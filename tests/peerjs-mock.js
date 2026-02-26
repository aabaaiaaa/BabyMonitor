/**
 * peerjs-mock.js — In-process PeerJS signaling mock for Playwright E2E tests.
 *
 * Intercepts WebSocket connections to 0.peerjs.com (and any custom host) using
 * Playwright's page.routeWebSocket() API so tests never hit the real PeerJS
 * cloud server.  All signaling messages are forwarded directly between
 * registered peers in the Playwright test process (no external server needed).
 *
 * Benefits:
 *   • Zero network latency for PeerJS signaling (sub-millisecond peer registry)
 *   • No rate-limiting from the cloud server
 *   • Tests run in < 5 s instead of up to 60 s per pairDevices call
 *   • Works offline (no internet required for PeerJS pairing)
 *
 * Usage:
 *   const { mockPeerJsSignaling } = require('./peerjs-mock');
 *   // MUST be called BEFORE page.goto() — routeWebSocket only intercepts
 *   // WebSocket connections on a pre-navigation page:
 *   await mockPeerJsSignaling(page);
 *   await page.goto('/baby.html');
 *
 * Isolation:
 *   The peer registry is a module-level Map shared across all pages in the same
 *   Playwright worker process.  Each Playwright worker runs in a separate Node.js
 *   process, so there is no cross-worker contamination.  Entries are removed
 *   from the registry when the WebSocket connection closes, so stale entries
 *   from previous tests do not interfere with new ones.
 *
 * Message queuing:
 *   If peer A sends a signal to peer B before B has registered, the message is
 *   queued under B's peer ID.  When B registers, all queued messages are
 *   delivered immediately (before any new live messages).  This ensures that
 *   OFFER + ICE CANDIDATE messages sent during a reconnect attempt reach the
 *   target even when the target re-registers after a brief delay (e.g. the
 *   restarted baby device in reconnection test 4).
 *
 * LEAVE notifications:
 *   When a peer's WebSocket closes (e.g. its browser context is destroyed), the
 *   mock immediately sends a LEAVE message to every remaining registered peer.
 *   PeerJS clients process LEAVE by closing connections to the departed peer,
 *   which triggers connection.on('close') events in app code.  This eliminates
 *   the ~30 s ICE failure detection window and makes disconnect tests instant.
 */

'use strict';

// ---------------------------------------------------------------------------
// Shared peer registry and message queue
// ---------------------------------------------------------------------------

/**
 * Registry mapping peer ID → WebSocketRoute.
 * Shared across all pages in this Playwright worker process.
 * @type {Map<string, import('@playwright/test').WebSocketRoute>}
 */
const _peerRegistry = new Map();

/**
 * Pending message queue: messages addressed to a peer that has not yet
 * registered.  Flushed when the target peer connects.
 * @type {Map<string, Array<object>>}
 */
const _pendingMessages = new Map();

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Remove peerId from the registry, clear it from the page's tracking set,
 * and send a LEAVE notification to every remaining registered peer.
 *
 * Idempotent: if the entry has already been removed (e.g. ws.onClose() fired
 * before page.on('close')), the registry check prevents a duplicate LEAVE.
 *
 * @param {string}  peerId
 * @param {import('@playwright/test').WebSocketRoute | undefined} ws
 * @param {Set<string>} pageRegisteredPeerIds
 */
function _sendLeaveAndCleanup(peerId, ws, pageRegisteredPeerIds) {
  // Only clean up if this exact ws instance is still the registered one.
  // (ws may be undefined if the page closed before any WS was opened.)
  if (ws !== undefined && _peerRegistry.get(peerId) !== ws) return;
  if (!_peerRegistry.has(peerId)) return;

  _peerRegistry.delete(peerId);
  pageRegisteredPeerIds.delete(peerId);

  // Notify all remaining registered peers that this peer has left.
  //
  // PeerJS clients process LEAVE by calling _cleanupPeer(src), which
  // closes all connections to the departed peer and emits
  // connection.on('close').  App disconnect handlers then run
  // immediately (updating window.__peerState etc.) rather than
  // waiting up to 30 s for ICE failure detection.
  for (const [, otherWs] of _peerRegistry) {
    try {
      otherWs.send(JSON.stringify({ type: 'LEAVE', src: peerId }));
    } catch {
      // ignore errors sending to a closing socket
    }
  }
}

// ---------------------------------------------------------------------------
// PeerJS signaling mock
// ---------------------------------------------------------------------------

/**
 * Set up PeerJS signaling mock on a Playwright page.
 *
 * Intercepts:
 *   • WebSocket connections to wss://0.peerjs.com/** (the default PeerJS cloud)
 *   • HTTP GET requests to https://0.peerjs.com/** (server availability checks)
 *
 * IMPORTANT: Must be called BEFORE page.goto().  Playwright's routeWebSocket
 * only intercepts WebSocket connections on pages that have not yet navigated.
 * Calling this after goto() will register the route but it will NOT intercept
 * the PeerJS WebSocket — the connection will fall through to the real server.
 *
 * @param {import('@playwright/test').Page} page
 */
async function mockPeerJsSignaling(page) {
  // -------------------------------------------------------------------
  // 1. Mock HTTP requests to the PeerJS cloud server.
  //    PeerJS checks server availability via HTTP before opening the
  //    WebSocket.  Return a minimal valid response so initialisation
  //    proceeds without blocking on a real network request.
  // -------------------------------------------------------------------
  await page.route('https://0.peerjs.com/**', (route) => {
    route.fulfill({
      status:      200,
      contentType: 'application/json',
      body:        '{}',
    });
  });

  // Track every peer ID registered from this specific page so we can
  // send LEAVE notifications if the page is forcibly destroyed.
  const pageRegisteredPeerIds = new Set();

  // -------------------------------------------------------------------
  // 2. Mock the PeerJS WebSocket signaling connection.
  //
  //    PeerJS opens:  wss://0.peerjs.com/peerjs?key=peerjs&id=<id>&token=<tok>
  //
  //    Protocol:
  //      • On connect: server → client {"type":"OPEN"}
  //      • Heartbeat:  client → server {"type":"HEARTBEAT"} (echo back)
  //      • Forwarding: client → server {"type":"OFFER|ANSWER|CANDIDATE|LEAVE",
  //                                      "dst":"<target-peer-id>",
  //                                      "payload":{...}}
  //                    server forwards to target peer with "src" added.
  //      • LEAVE:      server → client {"type":"LEAVE","src":"<departed-id>"}
  //                    sent to all remaining peers when a peer disconnects.
  // -------------------------------------------------------------------
  await page.routeWebSocket(/wss?:\/\/0\.peerjs\.com\//, (ws) => {
    // Extract the peer ID the client is registering under.
    let peerId;
    try {
      const url = new URL(ws.url());
      peerId = url.searchParams.get('id') ?? '';
    } catch {
      ws.close();
      return;
    }

    if (!peerId) {
      ws.close();
      return;
    }

    // Register this peer so other peers can send signals to it.
    _peerRegistry.set(peerId, ws);
    pageRegisteredPeerIds.add(peerId);

    // Confirm registration: the PeerJS client awaits this before
    // considering itself "ready" (triggers the peer.on('open') event).
    ws.send(JSON.stringify({ type: 'OPEN' }));

    // Flush any messages queued while this peer was not yet registered.
    // This handles the reconnection case where the parent sends an OFFER
    // to the baby's new peer ID before the baby has called peer.open().
    const queued = _pendingMessages.get(peerId);
    if (queued) {
      _pendingMessages.delete(peerId);
      for (const msg of queued) {
        try {
          ws.send(JSON.stringify(msg));
        } catch {
          // ignore errors sending to a just-opened socket
        }
      }
    }

    // Handle messages the page sends (i.e. signals intended for another peer).
    ws.onMessage((data) => {
      let msg;
      try {
        const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
        msg = JSON.parse(text);
      } catch {
        return; // ignore malformed messages
      }

      // Echo heartbeats back to keep the PeerJS connection alive.
      if (msg.type === 'HEARTBEAT') {
        ws.send(JSON.stringify({ type: 'HEARTBEAT' }));
        return;
      }

      // Forward signal to the target peer.
      if (!msg.dst) return;
      const target = _peerRegistry.get(msg.dst);
      if (target) {
        target.send(JSON.stringify({ ...msg, src: peerId }));
      } else {
        // Target peer not yet registered — queue the message so it is
        // delivered as soon as the target comes online.  This is critical
        // for reconnection: the parent sends OFFER + ICE candidates to
        // the baby's new peer ID before the baby has registered under it.
        if (!_pendingMessages.has(msg.dst)) {
          _pendingMessages.set(msg.dst, []);
        }
        _pendingMessages.get(msg.dst).push({ ...msg, src: peerId });
      }
    });

    // Clean up when this peer's WebSocket closes gracefully.
    ws.onClose(() => {
      _sendLeaveAndCleanup(peerId, ws, pageRegisteredPeerIds);
    });
  });

  // -------------------------------------------------------------------
  // 3. Fallback: send LEAVE on page / context close.
  //
  //    ws.onClose() fires when the WebSocket is closed gracefully.
  //    When a browser context is forcibly destroyed via context.close(),
  //    Playwright may tear down the network session without calling the
  //    ws.onClose() callback.
  //
  //    We listen on BOTH the Playwright Page 'close' event AND the
  //    BrowserContext 'close' event as redundant fallbacks.
  //    _sendLeaveAndCleanup is idempotent so double-firing is safe.
  // -------------------------------------------------------------------
  const _sendLeaveForPagePeers = () => {
    for (const pid of [...pageRegisteredPeerIds]) {
      _sendLeaveAndCleanup(pid, _peerRegistry.get(pid), pageRegisteredPeerIds);
    }
  };
  page.on('close', _sendLeaveForPagePeers);
  page.context().on('close', _sendLeaveForPagePeers);
}

module.exports = { mockPeerJsSignaling };
