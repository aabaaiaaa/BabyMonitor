/**
 * peer.js — PeerJS peer lifecycle management (TASK-060)
 *
 * Manages the PeerJS Peer object lifecycle used by both the baby monitor
 * and parent monitor. Exposes a clean status interface and handles:
 *
 *   - Stable UUID-based peer ID generated once and persisted to localStorage
 *     (stored under SETTING_KEYS.PEER_ID, separate from the baby device ID)
 *   - Peer registration with the PeerJS cloud signaling server by default,
 *     or a custom self-hosted server (configurable via TASK-008 settings)
 *   - Full lifecycle events: open, disconnected, error, close
 *   - Exposed clean status: 'registering', 'ready', 'disconnected', 'error'
 *   - Automatic reconnection with exponential back-off on unexpected disconnect
 *   - Error classification: id-taken, network-error, server-unavailable, etc.
 *   - Clear surfacing of server unavailability with offline QR fallback guidance
 *
 * webrtc.js delegates all peer creation to this module and calls
 * getPeerInstance() to access the underlying Peer for calls/data connections.
 */

import { lsGet, lsSet, SETTING_KEYS } from './storage.js';

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

/**
 * Classified PeerJS error type strings.
 * @enum {string}
 */
export const PEER_ERROR = {
  LIBRARY_UNAVAILABLE:  'library-unavailable',   // PeerJS script not loaded
  ID_TAKEN:             'id-taken',               // peer ID already registered on server
  INVALID_ID:           'invalid-id',             // malformed peer ID string
  INVALID_KEY:          'invalid-key',            // bad PeerJS API key
  NETWORK_ERROR:        'network-error',          // socket-level failure
  SERVER_UNAVAILABLE:   'server-unavailable',     // signaling server unreachable
  SSL_ERROR:            'ssl-error',              // SSL/TLS handshake failure
  BROWSER_INCOMPATIBLE: 'browser-incompatible',  // WebRTC not supported
  UNKNOWN:              'unknown-error',          // unclassified PeerJS error
};

/** Error types that indicate the PeerJS signaling server cannot be reached. */
const SERVER_UNAVAILABLE_ERRORS = new Set([
  PEER_ERROR.SERVER_UNAVAILABLE,
  PEER_ERROR.NETWORK_ERROR,
  PEER_ERROR.SSL_ERROR,
]);

/** Error types that are non-recoverable without user action / re-init. */
const FATAL_ERROR_TYPES = new Set([
  PEER_ERROR.LIBRARY_UNAVAILABLE,
  PEER_ERROR.SERVER_UNAVAILABLE,
  PEER_ERROR.NETWORK_ERROR,
  PEER_ERROR.BROWSER_INCOMPATIBLE,
  PEER_ERROR.INVALID_KEY,
  PEER_ERROR.SSL_ERROR,
]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * @typedef {'registering'|'ready'|'disconnected'|'error'} PeerStatus
 */

/**
 * @typedef {object} PeerErrorDetail
 * @property {string}  type              — one of PEER_ERROR values
 * @property {string}  message           — human-readable error message
 * @property {boolean} fatal             — if true, peer is unusable; re-init required
 * @property {boolean} [serverUnavailable] — true when the PeerJS server is unreachable
 */

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

/** @type {object|null} Active PeerJS Peer instance */
let _peer = null;

/** @type {PeerStatus} */
let _status = 'disconnected';

/** @type {string|null} Current peer ID (set after first 'open' event) */
let _peerId = null;

/** @type {object|null} Server config stored for reconnect attempts */
let _activeServerConfig = null;

/** @type {Function|null} Stored onError callback for reconnect attempts */
let _activeOnError = null;

/** @type {number} Consecutive reconnection attempt counter */
let _reconnectAttempts = 0;

/** @type {number|null} setTimeout handle for the next reconnect attempt */
let _reconnectTimer = null;

/** @type {Array<(status: PeerStatus, detail?: PeerErrorDetail) => void>} */
let _statusListeners = [];

const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BASE_DELAY_MS = 2000; // doubles each attempt (1×, 2×, 4×, 8×, 16×)

// ---------------------------------------------------------------------------
// Peer ID management
// ---------------------------------------------------------------------------

/**
 * Return the persistent PeerJS peer ID for this device, creating one if absent.
 * Stored under SETTING_KEYS.PEER_ID in localStorage.
 *
 * This ID is stable across sessions so paired devices can reconnect without
 * repeating the full pairing flow.
 *
 * @returns {string} UUID-format peer ID
 */
export function getOrCreatePeerId() {
  let id = lsGet(SETTING_KEYS.PEER_ID, null);
  if (!id) {
    id = crypto.randomUUID();
    lsSet(SETTING_KEYS.PEER_ID, id);
  }
  return id;
}

/**
 * Return the currently registered peer ID (null before first successful open).
 * @returns {string|null}
 */
export function getLocalPeerId() {
  return _peerId;
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/**
 * Return the current peer status.
 * @returns {PeerStatus}
 */
export function getPeerStatus() {
  return _status;
}

/**
 * Register a listener for peer status changes.
 * The callback receives (status, detail?) on every status transition.
 * Call the returned function to unsubscribe.
 *
 * @param {(status: PeerStatus, detail?: PeerErrorDetail) => void} callback
 * @returns {() => void} Unsubscribe function
 */
export function onPeerStatus(callback) {
  _statusListeners.push(callback);
  return () => {
    _statusListeners = _statusListeners.filter(cb => cb !== callback);
  };
}

/**
 * Internal: set new status and notify all registered listeners.
 * @param {PeerStatus} newStatus
 * @param {PeerErrorDetail|null} [detail]
 */
function _setStatus(newStatus, detail = null) {
  _status = newStatus;
  for (const cb of _statusListeners) {
    try {
      cb(newStatus, detail);
    } catch (e) {
      console.error('[peer] Status listener threw:', e);
    }
  }
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

/**
 * Map a PeerJS error object's `.type` field to one of our PEER_ERROR constants.
 * PeerJS error types: https://peerjs.com/docs/#peeron-error
 *
 * @param {Error & { type?: string }} err
 * @returns {string} One of the PEER_ERROR constants
 */
function _classifyError(err) {
  switch (err.type) {
    case 'peer-unavailable':     return PEER_ERROR.UNKNOWN;           // remote peer not found (non-fatal for us)
    case 'invalid-id':           return PEER_ERROR.INVALID_ID;
    case 'invalid-key':          return PEER_ERROR.INVALID_KEY;
    case 'unavailable-id':       return PEER_ERROR.ID_TAKEN;
    case 'ssl-unavailable':      return PEER_ERROR.SSL_ERROR;
    case 'server-error':         return PEER_ERROR.SERVER_UNAVAILABLE;
    case 'socket-error':         return PEER_ERROR.NETWORK_ERROR;
    case 'socket-closed':        return PEER_ERROR.NETWORK_ERROR;
    case 'browser-incompatible': return PEER_ERROR.BROWSER_INCOMPATIBLE;
    case 'network':              return PEER_ERROR.NETWORK_ERROR;
    default:                     return PEER_ERROR.UNKNOWN;
  }
}

// ---------------------------------------------------------------------------
// Peer instance access
// ---------------------------------------------------------------------------

/**
 * Return the active PeerJS Peer instance (null before init or after destroy).
 * Used by webrtc.js to make outgoing calls and listen for incoming ones.
 *
 * @returns {object|null}
 */
export function getPeerInstance() {
  return _peer;
}

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

/**
 * Initialise the peer manager.
 *
 * Creates a PeerJS Peer with a stable UUID-based ID (read from / persisted to
 * localStorage), registers it with the PeerJS cloud signaling server (or a
 * configured custom server), and wires up all lifecycle event handlers.
 *
 * @param {object}   [options]
 * @param {object}   [options.serverConfig]   — explicit PeerJS server config;
 *                                               falls back to SETTING_KEYS.PEERJS_SERVER
 * @param {Function} [options.onError]        — (detail: PeerErrorDetail) called on errors
 * @returns {Promise<string>} Resolves with the registered peer ID on first 'open',
 *                            rejects on fatal errors (server unavailable, etc.)
 */
export function initPeerManager(options = {}) {
  const { serverConfig = null, onError = null } = options;

  // Store active config so reconnect attempts can reuse it
  _activeServerConfig = serverConfig;
  _activeOnError      = onError;

  // Tear down any existing peer cleanly before starting fresh
  _destroyPeerInternal();

  _reconnectAttempts = 0;
  _setStatus('registering');

  return _createPeer(serverConfig, onError);
}

// ---------------------------------------------------------------------------
// Internal peer creation
// ---------------------------------------------------------------------------

/**
 * Construct a new PeerJS Peer, bind all lifecycle events, and return a Promise
 * that resolves with the peer ID on the first 'open' event or rejects on a
 * fatal error during initial registration.
 *
 * @param {object|null}   serverConfig
 * @param {Function|null} onError
 * @param {string|null}   [overridePeerId] — use a specific ID (set after id-taken retry)
 * @returns {Promise<string>}
 */
function _createPeer(serverConfig, onError, overridePeerId = null) {
  return new Promise((resolve, reject) => {
    // Guard: PeerJS must be available as a global (loaded from CDN via <script>)
    if (typeof Peer === 'undefined') {
      const detail = {
        type:              PEER_ERROR.LIBRARY_UNAVAILABLE,
        message:           'The PeerJS library could not be loaded. Check your internet connection and reload the page.',
        fatal:             true,
        serverUnavailable: false,
      };
      _setStatus('error', detail);
      onError?.(detail);
      reject(new Error(detail.message));
      return;
    }

    const peerId   = overridePeerId ?? getOrCreatePeerId();
    _peerId        = peerId;
    const peerOpts = _buildPeerOptions(serverConfig);

    let peer;
    try {
      peer = new Peer(peerId, peerOpts);
    } catch (constructErr) {
      const detail = {
        type:              PEER_ERROR.UNKNOWN,
        message:           `Failed to create PeerJS Peer: ${constructErr.message}`,
        fatal:             true,
        serverUnavailable: false,
      };
      _setStatus('error', detail);
      onError?.(detail);
      reject(constructErr);
      return;
    }

    _peer = peer;

    // -- 'open' -----------------------------------------------------------
    // Fired when the Peer has successfully registered with the signaling server.
    // Also fired again after a successful reconnect() call.
    _peer.on('open', (assignedId) => {
      // The server should honour the requested ID; handle the edge case where
      // it assigns a different one (e.g., custom server behaviour).
      if (assignedId !== peerId) {
        console.warn(`[peer] Server assigned different ID: ${assignedId} (requested ${peerId})`);
        lsSet(SETTING_KEYS.PEER_ID, assignedId);
        _peerId = assignedId;
      }
      _reconnectAttempts = 0;
      console.log(`[peer] Registered with peer ID: ${_peerId}`);
      _setStatus('ready');
      resolve(_peerId); // no-op if Promise is already resolved (reconnect scenario)
    });

    // -- 'disconnected' ---------------------------------------------------
    // Fired when the Peer loses its connection to the signaling server.
    // The underlying WebRTC connections may remain intact.
    _peer.on('disconnected', () => {
      console.warn('[peer] Disconnected from signaling server');
      _setStatus('disconnected');
      _scheduleReconnect();
    });

    // -- 'close' ----------------------------------------------------------
    // Fired when the Peer has been fully destroyed (e.g., peer.destroy() called).
    _peer.on('close', () => {
      console.log('[peer] Peer closed / destroyed');
      _peer   = null;
      _peerId = null;
      // Don't overwrite a prior 'error' status — keep it visible to the UI
      if (_status !== 'error') {
        _setStatus('disconnected');
      }
    });

    // -- 'error' ----------------------------------------------------------
    _peer.on('error', (err) => {
      const errorType = _classifyError(err);
      console.error(`[peer] Error (${errorType}):`, err.message ?? err);

      // Special case: peer ID already registered on the server.
      // Generate a new UUID, persist it, and retry the connection once.
      if (errorType === PEER_ERROR.ID_TAKEN) {
        if (overridePeerId) {
          // Already retried once — give up to avoid an infinite loop
          const detail = {
            type:              PEER_ERROR.ID_TAKEN,
            message:           'Could not register a unique peer ID after retrying. Please reload the app.',
            fatal:             true,
            serverUnavailable: false,
          };
          _setStatus('error', detail);
          onError?.(detail);
          reject(new Error(detail.message));
          return;
        }

        console.warn('[peer] Peer ID taken, generating a new UUID and retrying…');
        const newId = crypto.randomUUID();
        lsSet(SETTING_KEYS.PEER_ID, newId);
        _destroyPeerInternal();
        _createPeer(serverConfig, onError, newId).then(resolve).catch(reject);
        return;
      }

      const isServerUnavailable = SERVER_UNAVAILABLE_ERRORS.has(errorType);
      const fatal               = FATAL_ERROR_TYPES.has(errorType);

      const detail = {
        type:    errorType,
        message: isServerUnavailable
          ? 'Could not connect to the PeerJS server. Check your internet connection, or use Offline QR pairing instead.'
          : (err.message ?? `PeerJS error: ${errorType}`),
        fatal,
        serverUnavailable: isServerUnavailable,
      };

      _setStatus('error', detail);
      onError?.(detail);

      if (fatal) {
        reject(err);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Reconnection
// ---------------------------------------------------------------------------

/**
 * Schedule a reconnect attempt using PeerJS's built-in peer.reconnect().
 * Uses an exponential back-off delay. After MAX_RECONNECT_ATTEMPTS failures,
 * surfaces a final error and stops retrying.
 */
function _scheduleReconnect() {
  if (_reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.warn('[peer] Maximum reconnect attempts reached; giving up');
    const detail = {
      type:              PEER_ERROR.NETWORK_ERROR,
      message:           'Lost connection to the PeerJS server and could not reconnect. Try using Offline QR pairing instead.',
      fatal:             true,
      serverUnavailable: true,
    };
    _setStatus('error', detail);
    _activeOnError?.(detail);
    return;
  }

  // Prevent double-scheduling
  if (_reconnectTimer !== null) return;

  _reconnectAttempts++;
  const delay = RECONNECT_BASE_DELAY_MS * Math.pow(2, _reconnectAttempts - 1);
  console.log(`[peer] Scheduling reconnect attempt ${_reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${delay}ms…`);

  _reconnectTimer = setTimeout(() => {
    _reconnectTimer = null;

    if (!_peer || _peer.destroyed) {
      // Peer was destroyed (e.g., user navigated away) — abort
      return;
    }

    console.log(`[peer] Attempting reconnect (${_reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})…`);
    try {
      _peer.reconnect();
    } catch (e) {
      console.warn('[peer] peer.reconnect() threw:', e);
      // Retry again on next cycle
      _scheduleReconnect();
    }
  }, delay);
}

// ---------------------------------------------------------------------------
// Destruction
// ---------------------------------------------------------------------------

/**
 * Internal: destroy the current Peer and cancel any pending reconnect timer.
 * Does NOT update status or notify listeners — callers handle that.
 */
function _destroyPeerInternal() {
  if (_reconnectTimer !== null) {
    clearTimeout(_reconnectTimer);
    _reconnectTimer = null;
  }
  if (_peer) {
    if (!_peer.destroyed) {
      try { _peer.destroy(); } catch (_) { /* ignore */ }
    }
    _peer = null;
  }
}

/**
 * Fully tear down the peer manager: destroy the Peer, cancel timers, and
 * clear all registered status listeners.
 *
 * Safe to call even if the peer was never initialised.
 */
export function destroyPeerManager() {
  _destroyPeerInternal();
  _peerId            = null;
  _reconnectAttempts = 0;
  _activeServerConfig = null;
  _activeOnError      = null;
  _statusListeners   = [];
  _status            = 'disconnected';
}

// ---------------------------------------------------------------------------
// PeerJS options builder
// ---------------------------------------------------------------------------

/**
 * Build the PeerJS constructor options object.
 * Uses an explicitly provided serverConfig, or falls back to the value stored
 * under SETTING_KEYS.PEERJS_SERVER (set via the TASK-008 settings UI).
 * When neither is set, no host/port/path are specified and PeerJS defaults to
 * its cloud signaling server (0.peerjs.com).
 *
 * @param {object|null} serverConfig — explicit config (takes precedence)
 * @returns {object}
 */
function _buildPeerOptions(serverConfig) {
  const config = serverConfig ?? lsGet(SETTING_KEYS.PEERJS_SERVER, null);

  const options = {
    config: { iceServers: _getIceServers() },
    debug:  0,
  };

  if (config?.host) {
    options.host   = config.host;
    options.port   = config.port   ?? 9000;
    options.path   = config.path   ?? '/';
    options.secure = config.secure ?? true;
  }

  return options;
}

/**
 * Build the RTCIceServers array, including the Google STUN server plus any
 * TURN server configured under SETTING_KEYS.TURN_CONFIG (TASK-008).
 *
 * @returns {RTCIceServer[]}
 */
function _getIceServers() {
  const base = [{ urls: 'stun:stun.l.google.com:19302' }];
  const turn  = lsGet(SETTING_KEYS.TURN_CONFIG, null);
  if (turn?.urls) {
    base.push({
      urls:       turn.urls,
      username:   turn.username   ?? undefined,
      credential: turn.credential ?? undefined,
    });
  }
  return base;
}
