/**
 * webrtc.js — WebRTC / PeerJS connection management (TASK-007, TASK-060, TASK-061)
 *
 * Exposes a unified connection interface regardless of which connection
 * method is used (PeerJS or raw offline WebRTC via QR exchange).
 *
 * After a connection is established by either method, both call the shared
 * `onConnectionReady(dataChannel, mediaStream)` callback so that all
 * subsequent tasks (media display, data-channel messages, etc.) work
 * identically.
 *
 * PeerJS peer lifecycle (TASK-060) is delegated to peer.js; this module
 * re-exports the relevant peer management APIs so callers only need to
 * import from webrtc.js.
 *
 * TASK-007  — peer connection management for both methods
 * TASK-008  — TURN server configuration
 * TASK-030  — auto-reconnect
 * TASK-061  — backup ID pool
 */

import { lsGet, SETTING_KEYS } from './storage.js';
import {
  initPeerManager,
  destroyPeerManager,
  getPeerInstance,
  getPeerStatus   as _getPeerStatus,
  getLocalPeerId  as _getLocalPeerId,
  onPeerStatus    as _onPeerStatus,
  getOrCreatePeerId as _getOrCreatePeerId,
  PEER_ERROR      as _PEER_ERROR,
} from './peer.js';

// ---------------------------------------------------------------------------
// Re-export peer management API (TASK-060)
// ---------------------------------------------------------------------------

/** @see peer.js */
export const getPeerStatus    = _getPeerStatus;
/** @see peer.js */
export const getLocalPeerId   = _getLocalPeerId;
/** @see peer.js */
export const onPeerStatus     = _onPeerStatus;
/** @see peer.js */
export const getOrCreatePeerId = _getOrCreatePeerId;
/** @see peer.js */
export const PEER_ERROR       = _PEER_ERROR;

// ---------------------------------------------------------------------------
// ICE server configuration (TASK-008)
// Used by the raw offline RTCPeerConnection path. PeerJS's own peer options
// are built inside peer.js using the same logic.
// ---------------------------------------------------------------------------

/**
 * Build the iceServers array from saved settings.
 * Includes the Google STUN server plus any configured TURN server.
 *
 * @returns {RTCIceServer[]}
 */
export function getIceServers() {
  const base = [{ urls: 'stun:stun.l.google.com:19302' }];
  const turn = lsGet(SETTING_KEYS.TURN_CONFIG, null);
  if (turn?.urls) {
    base.push({
      urls:       turn.urls,
      username:   turn.username ?? undefined,
      credential: turn.credential ?? undefined,
    });
  }
  return base;
}

// ---------------------------------------------------------------------------
// Connection state types
// ---------------------------------------------------------------------------

/**
 * @typedef {'disconnected'|'connecting'|'connected'|'reconnecting'|'failed'} ConnState
 */

/**
 * @typedef {object} Connection
 * @property {string}        deviceId    — remote device's unique ID
 * @property {RTCDataChannel|object} dataChannel — normalised data channel
 * @property {MediaStream|null}      mediaStream  — incoming media stream
 * @property {ConnState}             state        — live connection state
 * @property {string}                method       — 'peerjs' | 'offline'
 * @property {RTCPeerConnection|null} peerConnection — underlying RTC connection
 * @property {() => void}            close        — cleanly close the connection
 */

// ---------------------------------------------------------------------------
// PeerJS connection path — delegates to peer.js (TASK-060)
// ---------------------------------------------------------------------------

/**
 * Initialise the PeerJS Peer via peer.js's initPeerManager.
 * Uses the stable UUID-based peer ID from localStorage (or creates one).
 * Wires full lifecycle handling: open, disconnected, error, close.
 *
 * @param {object|null} [serverConfig]   — optional custom PeerJS server config (TASK-008)
 * @param {Function}    [onError]        — (detail: PeerErrorDetail) callback for errors
 * @param {string|null} [overridePeerId] — register with this specific peer ID instead of the
 *                                          persisted one; used by TASK-061 auto-reconnect when
 *                                          the baby device advances to the next pool ID
 * @returns {Promise<string>} the local peer ID once registered with the server
 */
export function initPeer(serverConfig = null, onError = null, overridePeerId = null) {
  return initPeerManager({ serverConfig, onError, overridePeerId });
}

/**
 * Destroy the PeerJS Peer and clean up all peer manager state.
 */
export function destroyPeer() {
  destroyPeerManager();
}

/**
 * Get the active PeerJS Peer instance (may be null before init or after destroy).
 * @returns {object|null}
 */
export function getPeer() {
  return getPeerInstance();
}

// ---------------------------------------------------------------------------
// Baby device — PeerJS call out (TASK-007)
// ---------------------------------------------------------------------------

/**
 * Baby device: call a parent peer via PeerJS.
 * Sends a media stream and opens a data channel.
 *
 * @param {string}      parentPeerId    — peer ID of the parent device
 * @param {MediaStream} localStream     — baby's camera/mic stream
 * @param {object}      callbacks
 * @param {(conn: Connection) => void} callbacks.onReady   — connection ready
 * @param {(state: ConnState) => void} callbacks.onState   — state changes
 * @param {(msg: object) => void}      callbacks.onMessage — data channel message
 * @returns {Promise<void>}
 */
export async function babyCallParent(parentPeerId, localStream, callbacks) {
  const peer = getPeerInstance();
  if (!peer) throw new Error('PeerJS peer not initialised');

  const { onReady, onState, onMessage } = callbacks;

  onState?.('connecting');

  // Open media call
  const call = peer.call(parentPeerId, localStream);

  // Open data channel alongside the media call
  const dataConn = peer.connect(parentPeerId, { reliable: true });

  dataConn.on('open', () => {
    const conn = /** @type {Connection} */ ({
      deviceId:       parentPeerId,
      dataChannel:    normalisePeerJsDataConn(dataConn),
      mediaStream:    null,  // baby does not receive a stream from parent here
      state:          'connected',
      method:         'peerjs',
      peerConnection: call.peerConnection ?? null,
      close() {
        try { dataConn.close(); } catch (_) { /* ignore */ }
        try { call.close();    } catch (_) { /* ignore */ }
      },
    });
    onState?.('connected');
    onReady?.(conn);
  });

  dataConn.on('data', (data) => {
    try {
      const msg = typeof data === 'string' ? JSON.parse(data) : data;
      onMessage?.(msg);
    } catch (e) {
      console.warn('[webrtc] Could not parse data channel message', e);
    }
  });

  dataConn.on('close', () => onState?.('disconnected'));
  dataConn.on('error', (err) => {
    console.error('[webrtc] Data channel error:', err);
    onState?.('failed');
  });

  call.on('error', (err) => {
    console.error('[webrtc] Call error:', err);
    onState?.('failed');
  });
}

// ---------------------------------------------------------------------------
// Parent device — PeerJS receive (TASK-007)
// ---------------------------------------------------------------------------

/**
 * Parent device: listen for incoming PeerJS calls and data connections.
 *
 * TASK-022 multi-monitor: when `expectedPeerId` is provided, only handle
 * calls and data connections from that specific peer ID.  This prevents
 * event handlers registered for one baby's pairing session from firing
 * for a different baby that is already connected or is being paired
 * concurrently.
 *
 * @param {object}        callbacks
 * @param {(conn: Connection) => void} callbacks.onReady
 * @param {(state: ConnState) => void} callbacks.onState
 * @param {(msg: object) => void}      callbacks.onMessage
 * @param {string|null}   [expectedPeerId] — when set, only handle events
 *                                           from this peer (TASK-022)
 */
export function parentListenPeerJs(callbacks, expectedPeerId = null) {
  const peer = getPeerInstance();
  if (!peer) throw new Error('PeerJS peer not initialised');

  const { onReady, onState, onMessage } = callbacks;

  /** @type {MediaStream|null} */
  let remoteStream = null;
  /** @type {object|null} */
  let dataConn     = null;
  /** @type {RTCPeerConnection|null} */
  let peerConn     = null;
  /** @type {boolean} onReady already fired — guard against double invocation */
  let notified     = false;

  function tryNotifyReady() {
    if (notified || !remoteStream || !dataConn?.open) return;
    notified = true;

    const conn = /** @type {Connection} */ ({
      deviceId:       dataConn.peer,
      dataChannel:    normalisePeerJsDataConn(dataConn),
      mediaStream:    remoteStream,
      state:          'connected',
      method:         'peerjs',
      peerConnection: peerConn,
      close() {
        try { dataConn?.close(); } catch (_) { /* ignore */ }
      },
    });
    onState?.('connected');
    onReady?.(conn);
  }

  peer.on('call', (call) => {
    // TASK-022: when pairing a specific baby, ignore calls from other peers so
    // handlers registered for previous pairing sessions don't interfere.
    if (expectedPeerId && call.peer !== expectedPeerId) return;

    // Accept the media call — no local stream needed on the parent side
    call.answer();

    // Capture the underlying RTCPeerConnection for bitrate/track replacement
    // (call.peerConnection is set synchronously by PeerJS after answer())
    if (call.peerConnection) {
      peerConn = call.peerConnection;
    }

    call.on('stream', (stream) => {
      remoteStream = stream;
      // peerConnection may now be set even if it wasn't on answer()
      if (!peerConn && call.peerConnection) {
        peerConn = call.peerConnection;
      }
      tryNotifyReady();
    });

    call.on('close', () => onState?.('disconnected'));
    call.on('error', (err) => {
      console.error('[webrtc] Incoming call error:', err);
      onState?.('failed');
    });
  });

  peer.on('connection', (conn) => {
    // TASK-022: only handle connections from the expected baby peer.
    if (expectedPeerId && conn.peer !== expectedPeerId) return;

    dataConn = conn;
    onState?.('connecting');

    conn.on('open', () => tryNotifyReady());

    conn.on('data', (data) => {
      try {
        const msg = typeof data === 'string' ? JSON.parse(data) : data;
        onMessage?.(msg);
      } catch (e) {
        console.warn('[webrtc] Could not parse data channel message', e);
      }
    });

    conn.on('close', () => onState?.('disconnected'));
    conn.on('error', (err) => {
      console.error('[webrtc] Data connection error:', err);
      onState?.('failed');
    });
  });
}

// ---------------------------------------------------------------------------
// Offline QR path (TASK-007) — raw RTCPeerConnection
// ---------------------------------------------------------------------------

/** @type {RTCPeerConnection|null} */
let _rtcConn   = null;
/** @type {RTCDataChannel|null} */
let _dataCh    = null;

/**
 * Create and configure a raw RTCPeerConnection.
 * @returns {RTCPeerConnection}
 */
function createRTCPeerConnection() {
  if (_rtcConn) {
    _rtcConn.close();
    _rtcConn = null;
  }
  _rtcConn = new RTCPeerConnection({ iceServers: getIceServers() });
  return _rtcConn;
}

/**
 * Baby device, offline QR path:
 * 1. Create a peer connection + data channel
 * 2. Generate an SDP offer
 * 3. Wait for ICE gathering to complete
 * 4. Return the offer+candidates JSON for QR encoding
 *
 * @param {MediaStream} localStream
 * @param {object}      callbacks
 * @param {(conn: Connection) => void} callbacks.onReady
 * @param {(state: ConnState) => void} callbacks.onState
 * @param {(msg: object) => void}      callbacks.onMessage
 * @returns {Promise<string>} JSON string of { sdp, candidates }
 */
export async function offlineBabyCreateOffer(localStream, callbacks) {
  const { onReady, onState, onMessage } = callbacks;
  const pc = createRTCPeerConnection();

  // Add local tracks
  for (const track of localStream.getTracks()) {
    pc.addTrack(track, localStream);
  }

  // Create data channel
  _dataCh = pc.createDataChannel('control', { ordered: true });
  _wireDataChannel(_dataCh, onMessage);

  onState?.('connecting');

  // Create offer
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  // Wait for ICE gathering to complete
  const candidates = await _waitForIceCandidates(pc);

  return JSON.stringify({ sdp: pc.localDescription, candidates });
}

/**
 * Baby device, offline QR path:
 * Receive the parent's answer and ICE candidates, complete the handshake.
 *
 * Waits for the data channel to open (which confirms ICE + DTLS are complete)
 * before calling onReady — satisfying the requirement to validate the data
 * channel is open before transitioning to the monitor view.
 *
 * @param {string} answerJson — JSON string of { sdp, candidates }
 * @param {object} callbacks
 * @param {(conn: Connection) => void} callbacks.onReady
 * @param {(state: ConnState) => void} callbacks.onState
 */
export async function offlineBabyReceiveAnswer(answerJson, callbacks) {
  const { onReady, onState } = callbacks;
  if (!_rtcConn) throw new Error('RTCPeerConnection not initialised');
  if (!_dataCh)  throw new Error('Data channel not initialised — call offlineBabyCreateOffer first');

  const { sdp, candidates } = JSON.parse(answerJson);
  await _rtcConn.setRemoteDescription(new RTCSessionDescription(sdp));

  for (const c of candidates) {
    await _rtcConn.addIceCandidate(new RTCIceCandidate(c));
  }

  // Capture references in case module-level vars change before callbacks fire
  const pc = _rtcConn;
  const dc = _dataCh;

  /** @type {Connection} */
  const conn = {
    deviceId:       'parent',
    dataChannel:    normaliseRawDataChannel(dc),
    mediaStream:    null,
    state:          'connecting',
    method:         'offline',
    peerConnection: pc,
    close() {
      closeOfflineConnection();
    },
  };

  /** Guard: ensure onReady fires at most once */
  let notified = false;

  const notifyReady = () => {
    if (notified) return;
    notified = true;
    conn.state = 'connected';
    onState?.('connected');
    onReady?.(conn);
  };

  // Primary signal: data channel open means ICE + DTLS have both completed.
  if (dc.readyState === 'open') {
    // Already open (very fast connection or edge-case)
    notifyReady();
  } else {
    dc.addEventListener('open', notifyReady, { once: true });
  }

  // Track connection failures via both ICE and connection-state events.
  const trackState = () => {
    const ice = pc.iceConnectionState;
    const cs  = pc.connectionState;

    if (ice === 'failed' || cs === 'failed') {
      conn.state = 'failed';
      onState?.('failed');
    } else if (ice === 'disconnected' || cs === 'disconnected') {
      if (notified) {
        // Only surface reconnecting / disconnected after the connection was ready
        conn.state = 'reconnecting';
        onState?.('reconnecting');
      }
    } else if (ice === 'closed' || cs === 'closed') {
      conn.state = 'disconnected';
      onState?.('disconnected');
    }
  };

  pc.addEventListener('iceconnectionstatechange', trackState);
  pc.addEventListener('connectionstatechange',    trackState);
}

/**
 * Parent device, offline QR path:
 * Receive the baby's offer, generate an answer.
 *
 * @param {string}      offerJson   — JSON string of { sdp, candidates }
 * @param {object}      callbacks
 * @param {(conn: Connection) => void} callbacks.onReady
 * @param {(state: ConnState) => void} callbacks.onState
 * @param {(msg: object) => void}      callbacks.onMessage
 * @returns {Promise<string>} JSON string of { sdp, candidates } to show to baby
 */
export async function offlineParentReceiveOffer(offerJson, callbacks) {
  const { onReady, onState, onMessage } = callbacks;
  const pc = createRTCPeerConnection();

  // Listen for incoming tracks
  pc.addEventListener('track', (event) => {
    // Media stream ready — will be surfaced via onReady once data channel opens
  });

  // Monitor ICE and connection state for TASK-030 reconnect handling.
  // Fires 'reconnecting' on temporary disruption, 'connected' on recovery,
  // 'failed'/'disconnected' on terminal failure.
  let _offlineParentConnected = false;
  const _trackParentIceState = () => {
    const ice = pc.iceConnectionState;
    const cs  = pc.connectionState;
    if ((ice === 'connected' || ice === 'completed') || cs === 'connected') {
      if (_offlineParentConnected) {
        onState?.('connected'); // recovery after a 'reconnecting' event
      }
    } else if ((ice === 'disconnected' || cs === 'disconnected') && _offlineParentConnected) {
      onState?.('reconnecting');
    } else if (ice === 'failed' || cs === 'failed') {
      onState?.('failed');
    } else if (ice === 'closed' || cs === 'closed') {
      onState?.('disconnected');
    }
  };
  pc.addEventListener('iceconnectionstatechange', _trackParentIceState);
  pc.addEventListener('connectionstatechange',    _trackParentIceState);

  // Listen for data channel from baby
  pc.addEventListener('datachannel', (event) => {
    _dataCh = event.channel;
    _wireDataChannel(_dataCh, onMessage);

    _dataCh.addEventListener('open', () => {
      _offlineParentConnected = true;
      onState?.('connected');
      const streams = pc.getReceivers()
        .map(r => r.track)
        .filter(Boolean);
      const stream = streams.length > 0 ? new MediaStream(streams) : null;
      const conn = /** @type {Connection} */ ({
        deviceId:       'baby',
        dataChannel:    normaliseRawDataChannel(_dataCh),
        mediaStream:    stream,
        state:          'connected',
        method:         'offline',
        peerConnection: pc,
        close() {
          closeOfflineConnection();
        },
      });
      onReady?.(conn);
    });

    // Notify parent when the data channel closes unexpectedly
    _dataCh.addEventListener('close', () => {
      if (_offlineParentConnected) onState?.('disconnected');
    });
  });

  const { sdp, candidates } = JSON.parse(offerJson);
  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  for (const c of candidates) {
    await pc.addIceCandidate(new RTCIceCandidate(c));
  }

  onState?.('connecting');

  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);

  const myCandidates = await _waitForIceCandidates(pc);
  return JSON.stringify({ sdp: pc.localDescription, candidates: myCandidates });
}

/**
 * Close the raw RTCPeerConnection and data channel.
 */
export function closeOfflineConnection() {
  if (_dataCh) {
    _dataCh.close();
    _dataCh = null;
  }
  if (_rtcConn) {
    _rtcConn.close();
    _rtcConn = null;
  }
}

// ---------------------------------------------------------------------------
// Shared data channel normalisation (TASK-009)
// ---------------------------------------------------------------------------

/**
 * Returns a normalised channel object wrapping a PeerJS DataConnection,
 * exposing `send(msg)` and `on(event, handler)` compatible with the raw
 * RTCDataChannel interface so the rest of the app works identically.
 *
 * @param {object} peerJsConn — PeerJS DataConnection
 * @returns {{ send: Function, on: Function, close: Function }}
 */
function normalisePeerJsDataConn(peerJsConn) {
  return {
    send(msg) {
      peerJsConn.send(typeof msg === 'object' ? JSON.stringify(msg) : msg);
    },
    on(event, handler) {
      // Map RTCDataChannel 'message' event to PeerJS 'data' event
      if (event === 'message') {
        peerJsConn.on('data', (data) => {
          handler({ data });
        });
      } else {
        peerJsConn.on(event, handler);
      }
    },
    close() {
      peerJsConn.close();
    },
  };
}

/**
 * Returns a normalised channel object wrapping a raw RTCDataChannel.
 *
 * @param {RTCDataChannel} channel
 * @returns {{ send: Function, on: Function, close: Function }}
 */
function normaliseRawDataChannel(channel) {
  return {
    send(msg) {
      channel.send(typeof msg === 'object' ? JSON.stringify(msg) : msg);
    },
    on(event, handler) {
      channel.addEventListener(event, handler);
    },
    close() {
      channel.close();
    },
  };
}

/**
 * Attach standard message/close/error listeners to a data channel,
 * parsing incoming JSON messages and forwarding to onMessage.
 *
 * @param {RTCDataChannel} channel
 * @param {(msg: object) => void} onMessage
 */
function _wireDataChannel(channel, onMessage) {
  channel.addEventListener('message', (event) => {
    try {
      const msg = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
      onMessage?.(msg);
    } catch (e) {
      console.warn('[webrtc] Could not parse data channel message', e);
    }
  });
}

// ---------------------------------------------------------------------------
// ICE gathering helper
// ---------------------------------------------------------------------------

/** Maximum time to wait for ICE gathering to complete (ms). */
const ICE_GATHER_TIMEOUT_MS = 15_000;

/**
 * Wait for the ICE gathering to complete on a peer connection.
 * Resolves with an array of collected RTCIceCandidate objects.
 * After ICE_GATHER_TIMEOUT_MS, resolves with whatever candidates have been
 * gathered so far rather than blocking indefinitely.
 *
 * @param {RTCPeerConnection} pc
 * @returns {Promise<RTCIceCandidateInit[]>}
 */
function _waitForIceCandidates(pc) {
  return new Promise((resolve) => {
    /** @type {RTCIceCandidateInit[]} */
    const candidates = [];

    if (pc.iceGatheringState === 'complete') {
      resolve(candidates);
      return;
    }

    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      resolve(candidates);
    };

    // Timeout fallback: resolve with partial candidates rather than hanging
    const timer = setTimeout(() => {
      console.warn('[webrtc] ICE gathering timed out — proceeding with', candidates.length, 'candidate(s)');
      finish();
    }, ICE_GATHER_TIMEOUT_MS);

    pc.addEventListener('icecandidate', (event) => {
      if (event.candidate) {
        candidates.push(event.candidate.toJSON());
      }
    });

    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(timer);
        finish();
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Data channel message protocol helpers (TASK-009)
// ---------------------------------------------------------------------------

/**
 * Send a typed JSON message over a normalised data channel.
 * @param {{ send: Function }} channel
 * @param {string} type
 * @param {*} [payload]
 */
export function sendMessage(channel, type, payload) {
  channel.send({ type, ...(payload !== undefined ? { value: payload } : {}) });
}

/**
 * All message types used in the data channel protocol.
 * Defined here as a single source of truth; referenced by baby.js and parent.js.
 */
export const MSG = {
  // Parent → Baby commands
  SET_MODE:           'setMode',       // value: soothing mode name
  SET_VOLUME:         'setVolume',     // value: 0–100
  SET_TRACK:          'setTrack',      // value: track id / filename
  SET_FADE_TIMER:     'setFadeTimer',  // value: seconds (0 = off)
  CANCEL_FADE:        'cancelFade',
  FLIP_CAMERA:        'flipCamera',
  SET_AUDIO_ONLY:     'setAudioOnly',  // value: boolean
  SPEAK_START:        'speakStart',
  SPEAK_STOP:         'speakStop',
  DISCONNECT:         'disconnect',
  SET_QUALITY:        'setQuality',    // value: 'low'|'medium'|'high'
  SET_COMBINED_LIGHT: 'setCombinedLight', // value: 'candle'|'water'|'stars' (TASK-054)

  // Baby → Parent status updates
  STATE_SNAPSHOT:     'stateSnapshot', // full state object
  BATTERY_LEVEL:      'batteryLevel',  // value: { level, charging }
  CONN_STATUS:        'connStatus',    // value: ConnState

  // File transfer (TASK-013) — parent → baby
  FILE_META:             'fileMeta',           // value: { id, name, size, mimeType, totalChunks }
  FILE_CHUNK:            'fileChunk',          // value: { id, seq, data: base64 string }
  FILE_COMPLETE:         'fileComplete',       // value: { id }
  FILE_ABORT:            'fileAbort',          // value: { id, reason }

  // File transfer acknowledgement — baby → parent
  FILE_ACK:              'fileAck',            // value: { id } — baby confirms receipt
  FILE_TRANSFER_FAILED:  'fileTransferFailed', // value: { id, reason } — baby reports failure

  // File playback commands — parent → baby (TASK-013)
  FILE_PLAY:             'filePlay',           // (no value) — play / resume
  FILE_PAUSE:            'filePause',          // (no value) — pause
  FILE_STOP:             'fileStop',           // (no value) — stop + reset

  // PeerJS backup ID pool exchange (TASK-061)
  ID_POOL:            'idPool',        // value: string[] (backup peer IDs)

  // Alert from baby to parent
  ALERT_BATTERY_LOW:  'alertBatteryLow',  // value: { level }

  // Battery-efficient streaming options (TASK-028) — parent → baby
  SET_SCREEN_DIM:     'setScreenDim',     // value: boolean — dim baby device display
  SET_VIDEO_PAUSED:   'setVideoPaused',   // value: boolean — pause/resume video track
};
