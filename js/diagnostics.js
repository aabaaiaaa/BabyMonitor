/**
 * diagnostics.js — Connection diagnostics tracking and rendering (TASK-059)
 *
 * Tracks read-only diagnostic information about the current or most recent
 * connection attempt.  Updated by parent.js and baby.js as connection events
 * fire.
 *
 * Consumers call renderDiag(container) to render the current state into a DOM
 * element.  Passing { liveUpdate: true } registers an auto-refresh listener
 * that keeps the container in sync as state changes — useful for panels that
 * remain open while a connection is being established.
 */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * @typedef {object} DiagState
 * @property {'peerjs'|'offline'|null} method          — connection method in use
 * @property {string|null}   localPeerId               — PeerJS: this device's peer ID
 * @property {string|null}   peerJsServerStatus        — PeerJS: server connection status
 * @property {string[]}      peerJsBackupIdsTried      — PeerJS: backup IDs attempted during reconnect
 * @property {string|null}   peerJsError               — PeerJS: last error message from server
 * @property {string|null}   rtcConnectionState        — Offline: RTCPeerConnection.connectionState
 * @property {string|null}   rtcIceConnectionState     — Offline: iceConnectionState
 * @property {number}        rtcIceCandidatesGathered  — Offline: ICE candidate count
 * @property {string|null}   rtcDataChannelState       — Offline: data channel readyState
 * @property {string|null}   lastError                 — Both: last error string
 */

/** @returns {DiagState} */
function _emptyState() {
  return {
    method:                   null,
    localPeerId:              null,
    peerJsServerStatus:       null,
    peerJsBackupIdsTried:     [],
    peerJsError:              null,
    rtcConnectionState:       null,
    rtcIceConnectionState:    null,
    rtcIceCandidatesGathered: 0,
    rtcDataChannelState:      null,
    lastError:                null,
  };
}

/** @type {DiagState} */
let _state = _emptyState();

// ---------------------------------------------------------------------------
// Live-update listeners
// ---------------------------------------------------------------------------

/** @type {Set<() => void>} */
const _listeners = new Set();

function _notify() {
  for (const cb of _listeners) {
    try { cb(); } catch (_) { /* ignore listener errors */ }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Update one or more diagnostic fields and notify all live-update listeners.
 *
 * To append to `peerJsBackupIdsTried` without replacing it, use
 * `recordBackupIdTried(id)` instead.
 *
 * @param {Partial<DiagState>} fields
 */
export function updateDiag(fields) {
  Object.assign(_state, fields);
  _notify();
}

/**
 * Append an ID to the peerJsBackupIdsTried list.
 * @param {string} id
 */
export function recordBackupIdTried(id) {
  _state.peerJsBackupIdsTried.push(id);
  _notify();
}

/**
 * Reset all diagnostics to the initial empty state.
 * Call this at the start of each new connection attempt.
 */
export function resetDiag() {
  _state = _emptyState();
  _notify();
}

/**
 * Get a shallow copy of the current diagnostics state.
 * @returns {DiagState}
 */
export function getDiag() {
  return {
    ..._state,
    peerJsBackupIdsTried: [..._state.peerJsBackupIdsTried],
  };
}

/**
 * Render the current diagnostics into a container element.
 *
 * If `liveUpdate` is true, the container is automatically re-rendered
 * whenever diagnostics state changes.  The returned cleanup function
 * removes the listener and should be called when the panel closes.
 *
 * @param {HTMLElement} container
 * @param {object}  [opts]
 * @param {boolean} [opts.liveUpdate=false]
 * @returns {() => void} Cleanup / unsubscribe function
 */
export function renderDiag(container, { liveUpdate = false } = {}) {
  const doRender = () => { container.innerHTML = _buildHtml(_state); };
  doRender();
  if (liveUpdate) {
    _listeners.add(doRender);
    return () => _listeners.delete(doRender);
  }
  return () => {};
}

// ---------------------------------------------------------------------------
// HTML builder
// ---------------------------------------------------------------------------

/**
 * Build the diagnostics HTML table from the given state.
 * @param {DiagState} s
 * @returns {string}
 */
function _buildHtml(s) {
  const isPeerJs  = s.method === 'peerjs'  || s.method === null;
  const isOffline = s.method === 'offline' || s.method === null;

  const rows = [];

  rows.push(_row('Connection method', _fmtMethod(s.method)));

  if (isPeerJs) {
    rows.push(_row('Local peer ID',        s.localPeerId       ?? '—'));
    rows.push(_row('PeerJS server status', s.peerJsServerStatus ?? '—'));

    const tried = s.peerJsBackupIdsTried.length
      ? s.peerJsBackupIdsTried.map(id => id.substring(0, 8) + '…').join(', ')
      : 'None';
    rows.push(_row('Backup IDs tried', tried));
    rows.push(_row('PeerJS error',     s.peerJsError ?? 'None'));
  }

  if (isOffline) {
    rows.push(_row('RTC connection', s.rtcConnectionState    ?? '—'));
    rows.push(_row('ICE state',      s.rtcIceConnectionState ?? '—'));
    rows.push(_row('ICE candidates', String(s.rtcIceCandidatesGathered)));
    rows.push(_row('Data channel',   s.rtcDataChannelState   ?? '—'));
  }

  rows.push(_row('Last error', s.lastError ?? 'None'));

  return `<dl class="diag-list">${rows.join('')}</dl>`;
}

function _row(label, value) {
  return `<div class="diag-row">`
    + `<dt class="diag-label">${_esc(label)}</dt>`
    + `<dd class="diag-value">${_esc(String(value))}</dd>`
    + `</div>`;
}

function _fmtMethod(m) {
  if (m === 'peerjs')  return 'Quick Pair (PeerJS)';
  if (m === 'offline') return 'Offline QR';
  return '—';
}

function _esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
