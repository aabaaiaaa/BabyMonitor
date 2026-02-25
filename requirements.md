# Project Requirements

## Metadata
- **Project**: WebRTC Baby Monitor
- **Created**: 2026-02-24
- **Author**: Developer

## Overview

A browser-based, peer-to-peer baby monitor web app hosted on GitHub Pages. Two devices pair via WebRTC using a sequence of low-density QR codes to exchange signaling data — no server required. The baby device streams video/audio and displays soothing content; the parent device monitors one or more babies and controls the baby device remotely. The app must work offline over a local Wi-Fi network. Remote (cross-network) pairing is included as an optional mode.

---

## Tasks

### TASK-001: Create project file structure and GitHub Pages configuration
- **Status**: done
- **Priority**: high
- **Dependencies**: none
- **Description**: Scaffold the project as a static web app. Create `index.html` as the entry point with a mode-selection screen (baby monitor / parent monitor). Create separate HTML pages or JS-driven views for each mode. Add a `_config.yml` or equivalent for GitHub Pages. Organise JS into modules (e.g. `qr.js`, `webrtc.js`, `baby.js`, `parent.js`, `storage.js`). No build tools required — plain HTML/CSS/JS only.

### TASK-002: Implement PWA manifest and offline Service Worker
- **Status**: done
- **Priority**: high
- **Dependencies**: TASK-001
- **Description**: Add a `manifest.json` so the app is installable as a PWA. Implement a Service Worker that pre-caches all app assets (HTML, CSS, JS, fonts, audio files) on first load so the app is fully usable offline. Use a cache-first strategy. The app must function with no internet connection once the initial assets are cached. Third-party libraries may be loaded from CDNs; the Service Worker must intercept and cache those CDN responses on first load so that subsequent use (including offline use after the initial visit) does not require internet access. All CDN origins used must be listed in the cache manifest. Test that loading the page on a device with no internet access works after first visit.

### TASK-003: Implement Wake Lock API to prevent device sleep
- **Status**: done
- **Priority**: high
- **Dependencies**: TASK-001
- **Description**: Use the Screen Wake Lock API (`navigator.wakeLock.request('screen')`) to prevent the baby monitor device and parent monitor device from going to sleep while the app is in use. Request the wake lock when a mode is entered and release it when the user navigates away. Re-acquire the lock automatically if it is released by the system (e.g. tab becomes visible again). Fall back gracefully on browsers that do not support the API.

### TASK-004: Implement QR code generation for both connection methods
- **Status**: done
- **Priority**: high
- **Dependencies**: TASK-001
- **Description**: Integrate a QR code generation library (e.g. `qrcode.js` or `qr-code-styling`). The QR utility must support two distinct display modes used in different parts of the app. (1) Single QR code: used in the PeerJS connection method to display a short peer ID string (typically a UUID, ~36 characters). This is a single, easily scannable QR shown prominently. (2) Multi-QR grid: used in the offline QR fallback connection method to display a large payload (WebRTC SDP blob, ~1–2 KB). Implement a chunking utility that splits the payload into fixed-size chunks of approximately 300 bytes each. Each chunk is prefixed with a sequence header (e.g. `1/5:`). Render all chunks as a grid of small, low-density QR codes displayed simultaneously on screen. Chunk size must be tuned so each QR uses low error-correction and stays at a comfortable scan density. Both modes are used within the pairing flow (TASK-006).

### TASK-005: Implement QR code scanning for both connection methods
- **Status**: done
- **Priority**: high
- **Dependencies**: TASK-001
- **Description**: Integrate a QR scanning library (e.g. `jsQR` or `ZXing-js`) that uses the device camera. The scanner must support two modes. (1) Single scan: used in the PeerJS connection method — opens the camera, detects one QR code, and immediately returns the peer ID string. Used when the parent scans the baby's PeerJS ID QR. (2) Multi-scan with reassembly: used in the offline QR fallback — opens the camera, detects all visible QR codes in each frame simultaneously (multiple codes may be on screen at once), tracks which sequence chunks have been received, and displays scan progress (e.g. "3 of 5 scanned"). Once all chunks are received, reassembles the original payload and returns it. Allow re-scanning a chunk if missed. The scanner should auto-detect which mode to use based on whether the first detected payload matches a chunk header format or is a plain peer ID string.

### TASK-006: Build pairing flow — role selection and connection method
- **Status**: done
- **Priority**: high
- **Dependencies**: TASK-004, TASK-005, TASK-060
- **Description**: Build the pairing wizard UI. On the home screen the user selects "Baby Monitor" or "Parent Monitor". The wizard then offers two connection methods with clear descriptions:

  **Method 1 — PeerJS (default, recommended):** Requires both devices to have internet access. The baby monitor device obtains its PeerJS peer ID (from TASK-060) and displays it as a single compact QR code. The parent device scans this single QR. PeerJS handles signaling automatically; no further QR exchange is needed. Once the PeerJS connection is established, the pre-agreed backup ID pool is exchanged via the data channel (TASK-061). This is the fast path: two devices, one QR scan, done.

  **Method 2 — Offline QR (fallback):** Works with no internet connection, over local Wi-Fi only. The baby monitor device generates a raw WebRTC SDP offer, encodes it into a grid of multiple low-density QR codes (~300 bytes per code), and displays the grid. The parent device scans all QR codes in the grid. The parent device generates an SDP answer, encodes it into a QR grid, and displays it. The baby device scans the answer grid. A second round of QR exchange transfers the ICE candidates. The UI guides the user step-by-step through each round with clear instructions and scan progress indicators.

  The method selection screen must clearly state that Method 1 requires internet access and that Method 2 works without it. The chosen method is remembered in `localStorage` as the preferred method for this device.

  **Method 3 — Connect via existing parent device:** A third option on the home screen role selection, labelled "Add this device as an additional parent monitor". This is used by a second parent who already has a paired parent device in the household. In this mode, the second parent's app waits to receive baby monitor connection details from the first parent. The first parent initiates this from their dashboard (see TASK-058) and their device displays a QR code containing only their own PeerJS peer ID. The second parent scans this single QR, a PeerJS connection opens between the two parent devices, and the first parent's app automatically sends the PeerJS ID and backup pool for each paired baby monitor to the second parent. The second parent's app then connects directly and independently to each baby monitor using those IDs, without any further involvement from the first parent device. This mode is only available when PeerJS is reachable.

### TASK-007: Implement peer connection management for both connection methods
- **Status**: done
- **Priority**: high
- **Dependencies**: TASK-006, TASK-060
- **Description**: Implement the connection layer that handles both connection methods, exposing a unified interface to the rest of the app (media stream setup, data channel, connection state) regardless of which method was used.

  **PeerJS path (primary):** Use the PeerJS `Peer` object (TASK-060). On the baby device, call `peer.call(parentPeerId, mediaStream)` to send video/audio and `peer.connect(parentPeerId)` to open the data connection. On the parent device, handle incoming `peer.on('call')` and `peer.on('connection')` events. The underlying `RTCPeerConnection` is managed by PeerJS; access it via `call.peerConnection` for fine-grained controls (e.g. bitrate in TASK-034) where needed.

  **Offline QR path (fallback):** Use raw `RTCPeerConnection` with a minimal STUN configuration (`stun:stun.l.google.com:19302`). After the SDP offer/answer exchange via QR grids (TASK-006), wait for `iceGatheringState === 'complete'` before encoding the ICE candidates as a JSON array into a second QR grid for transfer. Once both sides have all ICE candidates, establish the connection. Validate the data channel opens before proceeding to the monitor views.

  Both paths must call a shared `onConnectionReady(dataChannel, mediaStream)` callback so all subsequent tasks (TASK-009, TASK-010, TASK-011, etc.) work identically regardless of which path established the connection.

### TASK-008: Implement TURN server configuration for strict NAT environments
- **Status**: done
- **Priority**: medium
- **Dependencies**: TASK-007, TASK-060
- **Description**: The PeerJS primary connection method already handles cross-network (internet) connectivity by default using the PeerJS cloud signaling server and STUN. However, in strict NAT or enterprise network environments, STUN alone may not be sufficient and a TURN relay server is needed. Add a TURN server settings panel (in the advanced section of TASK-032) allowing the user to enter a TURN server URL and optional credentials. When configured, pass these TURN details to both the PeerJS `Peer` constructor's `config.iceServers` option and the raw `RTCPeerConnection` configuration used in the offline QR fallback path. Also add an option to configure a self-hosted PeerJS server URL (host + port + path) for users who prefer not to rely on the public PeerJS cloud server. Both options are optional — the app works without them using PeerJS defaults. Document both options in the README (TASK-035).

### TASK-009: Implement data channel for control messages
- **Status**: done
- **Priority**: high
- **Dependencies**: TASK-007
- **Description**: Establish a reliable, ordered data channel for JSON control messages between parent and baby. The channel is obtained differently depending on the connection method used, but the message protocol and all handler code is identical for both. For the PeerJS path, the data channel is the `DataConnection` returned by `peer.connect()` / received via `peer.on('connection')`; send and receive via `conn.send()` and `conn.on('data')`. For the offline QR fallback path, the data channel is a raw `RTCDataChannel` created on the `RTCPeerConnection`. TASK-007's `onConnectionReady` callback delivers a normalised channel object so this task's code does not need to branch on connection method. Define the full JSON message protocol here, covering all message types used across the app: commands from parent to baby (e.g. `{ type: "setMode", value: "candle" }`), status updates from baby to parent (e.g. `{ type: "batteryLevel", value: 72 }`), the state snapshot (TASK-048), file transfer chunks (TASK-013), and the pre-agreed ID pool exchange (TASK-061). Implement send/receive handlers on both sides.

### TASK-010: Implement video and audio capture on the baby monitor device
- **Status**: done
- **Priority**: high
- **Dependencies**: TASK-007
- **Description**: On the baby monitor device, request camera and microphone access via `getUserMedia`. Add the resulting media stream tracks to the `RTCPeerConnection` for transmission to the parent. Implement resolution and frame-rate controls (e.g. 640×480 at 15 fps as a default to conserve battery). Provide a UI toggle to switch to audio-only mode (disables video track) to further save battery. Handle permission denial gracefully with a clear error message. Do not hard-code a camera facing direction — camera selection is handled separately in TASK-041.

### TASK-011: Implement media stream display on the parent monitor
- **Status**: done
- **Priority**: high
- **Dependencies**: TASK-010
- **Description**: On the parent monitor, receive the incoming media stream from the baby device and attach the video track to a `<video>` element (muted, for display only). Route the audio track separately through a Web Audio API graph: create a `MediaStreamSourceNode` from the incoming stream's audio track, connect it through a `GainNode` (for volume control and smooth ramping), and on to `AudioContext.destination`. This audio graph architecture is required by TASK-024 (AnalyserNode attachment), TASK-056 (smooth ramp when parent speaks), and TASK-050 (muting during alerts). Expose the `GainNode` and `AnalyserNode` hookup points for use by those tasks. Implement a volume slider that adjusts the `GainNode` gain value. Ensure both the video element and audio graph are fully cleaned up when the connection closes (stop tracks, disconnect nodes, close or suspend the AudioContext).

### TASK-012: Implement parent-to-baby speak-through audio
- **Status**: done
- **Priority**: high
- **Dependencies**: TASK-009, TASK-010, TASK-037
- **Description**: On the parent monitor, add a speak-through microphone button that supports two modes, switchable in settings: push-to-talk (held down to transmit, released to stop) and toggle (tap once to start, tap again to stop). The default mode is push-to-talk. When activated in either mode, capture the parent's microphone via `getUserMedia` and add the audio track to the peer connection. On the baby monitor device, receive this stream and play it through the device speakers. Implement a clear visual indicator on both sides when the parent's microphone is active. Include echo cancellation on the parent's microphone capture to suppress the baby audio playing through the parent's speakers.

### TASK-013: Implement audio file transfer from parent to baby device
- **Status**: done
- **Priority**: high
- **Dependencies**: TASK-009
- **Description**: On the parent monitor, add a file picker that accepts common audio formats (MP3, OGG, WAV). Transfer the selected file to the baby device over the `RTCDataChannel` using binary chunking (split the file into fixed-size chunks, send sequentially with sequence numbers, reassemble on the baby side). On the baby device, store the received file as a Blob in IndexedDB and play it locally using the Web Audio API — the file is not streamed live. Display transfer progress on both sides. Once transferred, the parent can trigger play/pause/stop and adjust the fade-out timer via the data channel. The baby device's local Web Audio graph (including GainNode for ducking) handles all playback. This is a separate audio source from the bundled soothing tracks; both draw from the same playback and ducking system. Only one file transfer may be in progress at a time — the file picker and send button are disabled while a transfer is active. If the connection drops during a transfer, discard any partially received data from IndexedDB, notify the parent that the transfer failed, and re-enable the send button once the connection is restored so they can try again.

### TASK-014: Implement music fade-out timer
- **Status**: done
- **Priority**: high
- **Dependencies**: TASK-013, TASK-019
- **Description**: On both the parent monitor (for streamed audio) and the baby monitor (for locally played soothing music), implement a configurable fade-out timer. The parent can set a duration (e.g. 15 min, 30 min, 45 min, 60 min, or custom). A visible countdown timer shows remaining time. The timer can be cancelled or reset. When the timer expires, playback stops automatically. The actual volume fade uses an exponential ramp applied over the final 10% of the configured duration, with a minimum fade window of 30 seconds and a maximum of 5 minutes. For example: a 30-minute timer fades over the final 3 minutes; a 60-minute timer fades over the final 5 minutes (capped); a 5-minute timer fades over the final 30 seconds (minimum). The `GainNode` ramp is scheduled in advance using `linearRampToValueAtTime` or `exponentialRampToValueAtTime` so the fade runs smoothly without polling.

### TASK-015: Implement baby monitor soothing mode UI
- **Status**: done
- **Priority**: high
- **Dependencies**: TASK-009
- **Description**: Build the baby monitor display UI. It should occupy the full screen and show one of three modes: soothing light effect, soothing music (screen dimmed), or blank/off. The mode is controlled either locally on the baby device (with minimal UI — a small settings icon or long-press interaction to avoid disturbing the baby) or remotely via the parent's control panel. The screen brightness should be kept low in soothing modes to avoid disturbing the baby. Display a small status indicator (connection status, battery) in a corner that fades out after a few seconds.

### TASK-016: Implement candle light soothing effect
- **Status**: done
- **Priority**: medium
- **Dependencies**: TASK-015
- **Description**: Implement a fullscreen canvas-based candle flicker animation. Use randomised flame shapes rendered with orange/yellow/red gradients. Add subtle, slow brightness variation to simulate natural candlelight. The animation should be computationally lightweight — use `requestAnimationFrame` with a low update rate (e.g. 24 fps) and simple geometry rather than heavy shaders. The warm, dimly lit output should be suitable for a darkened baby room.

### TASK-017: Implement water light soothing effect
- **Status**: done
- **Priority**: medium
- **Dependencies**: TASK-015
- **Description**: Implement a fullscreen canvas-based animated water/ripple light effect. Use soft blue and teal tones with gentle horizontal wave patterns or caustic-light ripples. Animate with slow sinusoidal movement. Keep the rendering lightweight — avoid per-pixel operations; use layered semi-transparent shapes or pre-computed lookup tables. The output should feel calm and soothing.

### TASK-018: Implement stars/night sky soothing effect
- **Status**: done
- **Priority**: medium
- **Dependencies**: TASK-015
- **Description**: Implement a fullscreen canvas-based starfield or projected-stars effect. Render a dark background with many small, softly glowing dots that twinkle gently using opacity animation. Optionally add a slow rotation or drift to simulate a projected star night-light. Keep the colour palette to deep blues, purples, and white/silver. Keep the rendering lightweight.

### TASK-019: Implement soothing music playback on baby monitor
- **Status**: done
- **Priority**: medium
- **Dependencies**: TASK-015, TASK-037
- **Description**: Bundle a small selection of soothing audio files (e.g. white noise, lullaby, rain sounds — royalty-free) within the app's cached assets. On the baby monitor, implement an audio player using the Web Audio API that loops the selected track. The player is controlled either locally or remotely via the data channel. Integrate the fade-out timer (TASK-014) into this local player. When in music mode, the screen should dim to near-black to save battery while audio plays.

### TASK-020: Implement battery level monitoring and broadcast on baby monitor
- **Status**: done
- **Priority**: high
- **Dependencies**: TASK-009
- **Description**: Use the Battery Status API (`navigator.getBattery()`) on the baby monitor device to read the current battery level and charging state. Broadcast this information to the parent via the data channel as a periodic status update (e.g. every 60 seconds or when the level changes by more than 2%). Handle the case where the Battery Status API is not available (show "unknown" on the parent side). The baby monitor should also display a low-battery warning locally when the level drops below 20%.

### TASK-021: Build parent monitor main dashboard layout
- **Status**: done
- **Priority**: high
- **Dependencies**: TASK-011
- **Description**: Design and implement the parent monitor dashboard. The layout should be responsive and work on both phones and tablets. Allocate the majority of the screen to a grid of baby monitor video panels. Reserve a sidebar or bottom panel for controls. When only one baby monitor is connected, its video should fill most of the screen. When multiple are connected, arrange them in a responsive grid. Each panel should show the baby's label, connection status, battery level, and a noise level indicator.

### TASK-022: Implement multi-monitor support on parent dashboard
- **Status**: done
- **Priority**: medium
- **Dependencies**: TASK-021
- **Description**: Allow the parent monitor to maintain simultaneous WebRTC connections to multiple baby monitor devices, up to a maximum of 4. Each connection is initiated via a separate QR code pairing session. The parent dashboard dynamically adds a new panel for each connected baby monitor. Implement connection management so each baby monitor has its own data channel and media stream. Provide a button to add a new baby monitor (initiating a new pairing session) without interrupting existing connections. When 4 baby monitors are already connected, disable the "Add baby monitor" button and show a tooltip explaining the limit. If a device disconnects, the slot becomes available again.

### TASK-023: Implement baby monitor labelling and local storage persistence
- **Status**: done
- **Priority**: medium
- **Dependencies**: TASK-022
- **Description**: Allow the parent to assign a label to each baby monitor (e.g. "Nursery", "Alice's Room"). Store this label alongside any saved configuration for that device in `localStorage`. On the baby monitor device, assign it a unique device ID (stored in `localStorage`) that is included in its data channel messages. The parent stores a mapping of device ID to label. On subsequent pairing sessions, if the device ID is recognised, automatically restore the saved label. Provide a settings UI for managing saved devices (rename, delete).

### TASK-024: Implement noise level visualiser on parent dashboard
- **Status**: done
- **Priority**: high
- **Dependencies**: TASK-011, TASK-032
- **Description**: For each connected baby monitor, attach a Web Audio API `AnalyserNode` to the incoming audio stream. Compute the RMS amplitude in real time and render a compact noise-level bar or waveform indicator within the baby's panel on the parent dashboard. The visualiser should update at ~10 fps to remain lightweight. Add a threshold line the parent can adjust per device; if noise exceeds the threshold, the panel should highlight visually (e.g. pulsing border) as an alert. The per-device threshold value is stored in that device's profile in `localStorage` (see TASK-032) so it persists across sessions. This lets parents monitor audio activity without having to watch the video.

### TASK-025: Implement remote control panel on parent dashboard
- **Status**: done
- **Priority**: high
- **Dependencies**: TASK-009, TASK-015
- **Description**: In the parent dashboard, provide a control panel for each connected baby monitor (accessible by tapping/clicking the baby's panel or via a slide-out drawer). Controls include: soothing mode selector (candle / water / stars / music / off), volume slider for locally played soothing music on the baby device, music track selector (choosing from the baby device's bundled tracks), music fade-out timer setting, and video/audio quality settings. All control changes send a command via the data channel. The baby device applies the command and confirms via a response message.

### TASK-026: Implement movement detection on baby video stream
- **Status**: done
- **Priority**: medium
- **Dependencies**: TASK-011
- **Description**: On the parent monitor, implement frame-differencing motion detection on the incoming baby video stream. Draw each video frame to an offscreen `<canvas>`, compare pixel values to the previous frame, and compute a motion score. Throttle the analysis to run every 2–3 seconds to reduce CPU and battery load. Display a movement indicator on the baby's panel. If movement exceeds a configurable threshold, trigger a visual alert (e.g. panel border flashes, optional on-screen notification). Provide a sensitivity slider in the panel settings.

### TASK-027: Implement movement detection alerts and notification
- **Status**: done
- **Priority**: medium
- **Dependencies**: TASK-026, TASK-047
- **Description**: When movement is detected above the configured threshold, show a persistent visual alert on the parent dashboard. Use the Notifications API (`Notification.requestPermission()`) to send a browser notification if the tab is in the background or the screen is locked, so the parent is alerted even when not actively watching the app. Include the baby's label in the notification text. Allow the parent to mute movement alerts per device or globally for a set period (e.g. "Snooze alerts for 10 minutes").

### TASK-028: Implement battery-efficient streaming options
- **Status**: done
- **Priority**: high
- **Dependencies**: TASK-010
- **Description**: Add battery conservation controls. On the baby monitor: (a) an "audio only" mode that disables the video track entirely, (b) a low-resolution/low-fps mode (e.g. 320×240 at 10 fps), and (c) a screen-off/dim mode that turns the display near-black while keeping the connection alive. On the parent monitor: (a) an option to pause receiving video (data channel command tells baby to pause video) while keeping audio and data alive, and (b) reduced analysis frequency for movement detection and noise monitoring. Document these options clearly in the UI with battery-life impact hints.

### TASK-029: Implement background tab persistence and visibility handling
- **Status**: done
- **Priority**: high
- **Dependencies**: TASK-003, TASK-009, TASK-047
- **Description**: Handle the case where the parent or baby app tab is hidden or the phone is locked. Use the Page Visibility API to detect when the tab becomes hidden. When the baby monitor tab is hidden: keep the WebRTC connection and media streams alive (do not stop tracks), and re-acquire the Wake Lock when the tab becomes visible again. On the parent side when the tab is hidden: keep connections alive and use the Notifications API to deliver movement or battery alerts. Show a persistent banner in the app instructing users to keep the tab open or install the PWA to improve background reliability.

### TASK-030: Implement connection health monitoring and auto-reconnect
- **Status**: done
- **Priority**: medium
- **Dependencies**: TASK-007, TASK-061
- **Description**: Monitor the connection state and attempt automatic reconnection without user intervention. The approach differs by connection method.

  **PeerJS path (primary):** Monitor the PeerJS `Peer` and `MediaConnection` for `close`, `error`, and `disconnected` events. On disconnection, the baby device advances to the next ID in its pre-agreed backup pool (TASK-061) and re-registers with PeerJS under that ID. The parent device simultaneously cycles through the known backup pool attempting to reach the baby's new ID. Both sides retry with a short back-off (e.g. 3 s, 6 s, 12 s). If the pool is exhausted or the PeerJS server itself is unreachable, fall back to a full re-pair prompt.

  **Offline QR path (fallback):** Monitor `RTCPeerConnection.iceConnectionState`. On disconnection, attempt ICE restart. If that fails, show the re-pair QR flow.

  Display a connection status indicator (connected / reconnecting / disconnected) on both monitor UIs throughout. If auto-reconnect fails after all retries, show a "Re-pair devices" prompt alongside the connection diagnostics panel (TASK-059).

### TASK-031: Implement first-run onboarding and setup wizard
- **Status**: done
- **Priority**: medium
- **Dependencies**: TASK-006, TASK-015, TASK-021, TASK-044, TASK-047
- **Description**: Build a guided first-run onboarding flow that runs the first time the app is opened (detected via `localStorage` flag). Walk the user through: (1) choosing baby monitor or parent monitor role, (2) displaying the safe sleep information screen (TASK-044) with a mandatory acknowledgement checkbox — the user cannot proceed until this is ticked, (3) the notification permission request step (TASK-047), (4) granting camera/microphone permissions, (5) pairing the devices using the chosen connection method — for PeerJS this is a single QR scan; for offline QR this is a multi-round grid scanning process — with clear annotated instructions for each, (6) labelling the baby monitor, (7) a brief tour of the parent dashboard. On subsequent opens, skip directly to role selection. Provide a "Help / Re-run setup" link in settings.

### TASK-032: Implement persistent settings and saved device profiles
- **Status**: done
- **Priority**: medium
- **Dependencies**: TASK-023
- **Description**: Implement a settings screen accessible from both monitor views. Global settings stored in `localStorage` include: default soothing mode, default music track, fade-out timer presets, preferred video quality, speak-through mode (push-to-talk vs toggle), and whether remote mode is preferred. Per-device settings stored within each device's saved profile include: noise alert threshold, movement detection sensitivity, and low battery alert threshold. This ensures per-device values travel with the device profile (TASK-023) rather than overwriting a single global value when multiple baby monitors are in use. On the baby monitor side, store its assigned device ID persistently. On the parent side, store all paired device profiles so the parent dashboard can show expected devices and flag which are currently connected.

### TASK-033: Implement responsive UI and mobile-first layout
- **Status**: done
- **Priority**: medium
- **Dependencies**: TASK-015, TASK-021
- **Description**: Ensure both monitor UIs are fully usable on a phone held in portrait or landscape orientation, as well as on a tablet. The baby monitor UI should be fullscreen with no distracting chrome. The parent dashboard should adapt its grid layout based on the number of connected monitors and the available screen area. Use CSS Grid and media queries. Ensure all touch targets are large enough (minimum 44×44 px). Test the layout at common mobile resolutions (375px, 414px, 768px wide).

### TASK-034: Implement video quality and stream configuration controls
- **Status**: pending
- **Priority**: low
- **Dependencies**: TASK-010, TASK-028
- **Description**: Add a video quality settings panel accessible from the baby monitor device (locally) and remotely from the parent control panel. Offer preset quality levels: Low (320×240, 10 fps), Medium (640×480, 15 fps), High (1280×720, 24 fps). Use `RTCRtpSender.setParameters()` to adjust bitrate constraints on the active connection without renegotiation where possible. Display the current estimated stream bitrate on the parent dashboard as a diagnostic. The default should be Medium to balance quality and battery life.

### TASK-035: Write README and usage documentation
- **Status**: pending
- **Priority**: low
- **Dependencies**: TASK-031, TASK-032
- **Description**: Write a `README.md` explaining: what the app is, how to access it via GitHub Pages, how to pair two devices, the three connection methods (PeerJS, offline QR, connect via existing parent), how to install it as a PWA, battery-saving tips, and browser compatibility. Browser compatibility must state clearly: Chrome (desktop and Android) is fully supported; Chrome on iOS is supported with two important caveats — (1) the Wake Lock API is unavailable so the screen may sleep, which stops canvas light effects (use music mode on iOS baby devices); (2) iOS does not permit web apps to trigger background notifications, so alerts only appear while the app is open on screen. Safari on iOS and macOS is not supported — iOS users must use Chrome. The README must also explain the "Tap to begin" requirement that appears on every load (a browser security requirement for audio). Include a brief troubleshooting section covering common issues (camera permission denied, connection failing, audio not playing, app prompting to update, PeerJS unavailable — use offline QR instead).

### TASK-036: Implement low battery alert to parent
- **Status**: done
- **Priority**: high
- **Dependencies**: TASK-020, TASK-024, TASK-032, TASK-047
- **Description**: When the baby monitor's battery level drops below a configurable threshold (default 15%), the baby device sends a high-priority alert message via the data channel. On the parent dashboard, display a prominent persistent banner for that baby monitor (e.g. red border, battery icon, device label). Use the Notifications API to fire a push notification if the parent's tab is in the background (subject to platform limitations — see TASK-047). Include the baby monitor's label and current battery percentage in the alert text. The parent can dismiss the alert once acknowledged. The threshold should be configurable per device in settings (TASK-032). Battery alerts take the highest visual and audio priority of all alert types. If a battery alert and any other alert (noise or movement) fire at the same time, the battery alert banner is displayed above all others, its audio tone plays first, and other alert tones queue behind it rather than overlapping. If multiple baby monitors trigger low battery simultaneously, show a stacked banner per device.

### TASK-037: Implement autoplay policy handling
- **Status**: done
- **Priority**: high
- **Dependencies**: TASK-009, TASK-010
- **Description**: Browsers require a user gesture before any AudioContext can be created or resumed, and before getUserMedia can be called. This is a browser security feature that applies on every page load — it cannot be bypassed or stored across sessions. Handle this on both devices by displaying a full-screen "Tap to begin" overlay every time the app loads, before any WebRTC, getUserMedia, or Web Audio API call is made. The overlay should be minimal and fast to dismiss (a single tap anywhere). After the tap, create the AudioContext, request media permissions, and proceed with connection setup. On the baby monitor, the tap-to-begin overlay appears before the soothing mode UI or any streaming starts. On the parent monitor, it appears before the dashboard loads. Do not attempt to cache or skip this gesture — it is a hard browser requirement on every load. Document this clearly in the README so users understand why they must tap before the app becomes active each time they open it.

### TASK-038: Implement audio ducking when parent speaks
- **Status**: done
- **Priority**: high
- **Dependencies**: TASK-012, TASK-019, TASK-013
- **Description**: On the baby monitor device, implement automatic volume ducking via the Web Audio API. All audio playing on the baby device (whether a bundled soothing track or an uploaded file from the parent) routes through a shared `GainNode`. When the parent activates speak-through (TASK-012) and audio from the parent is received, smoothly reduce the music gain to a low level (e.g. 15–20% of normal) using a short ramp (~0.5 s). When the parent stops speaking and the incoming audio track goes silent, ramp the music gain back up to its previous level (~1–2 s). The ducking threshold should be driven by detecting activity on the incoming parent audio track (using an `AnalyserNode` on that track), not by a manual data channel message, so it works automatically without extra control lag.

### TASK-039: Implement touch lock / kiosk mode on baby monitor
- **Status**: done
- **Priority**: medium
- **Dependencies**: TASK-015
- **Description**: Once the baby monitor is running in soothing or streaming mode, lock the UI against accidental input. Any single tap on the screen shows a very dim, brief text hint (e.g. "Triple tap to unlock") that fades out within 2 seconds. Three taps within 1.5 seconds unlocks the UI and reveals the settings/mode controls. When locked, the Fullscreen API (`document.documentElement.requestFullscreen()`) should be active to prevent browser chrome from appearing. Re-lock the UI automatically after 30 seconds of inactivity once unlocked. The locked state should be the default whenever the device enters a soothing or streaming mode.

### TASK-040: Implement screen orientation lock on baby monitor
- **Status**: done
- **Priority**: medium
- **Dependencies**: TASK-015, TASK-039
- **Description**: Provide an orientation setting accessible during baby monitor setup (before locking the UI via TASK-039). Options: Portrait, Landscape Left, Landscape Right, and Auto (no lock). Use the Screen Orientation API (`screen.orientation.lock()`) to lock the display to the chosen orientation when entering soothing/streaming mode. Save the chosen orientation in `localStorage` so it is restored on reconnection. Fall back gracefully if the API is not supported (leave orientation unlocked and show a note in settings). This prevents the display layout from being disrupted if the device is placed on its side.

### TASK-041: Implement camera selection on baby monitor
- **Status**: done
- **Priority**: medium
- **Dependencies**: TASK-010
- **Description**: Add a camera flip button to the baby monitor setup screen (and accessible from the unlocked settings overlay). Tapping it switches between front-facing (`facingMode: 'user'`) and rear-facing (`facingMode: 'environment'`) cameras by stopping the current track and calling `getUserMedia` again with the new constraint. The active camera choice is saved in `localStorage`. Also expose a "Switch camera" command via the data channel so the parent can flip the camera remotely from the parent dashboard. Note: no camera direction is assumed — the parent chooses whichever camera provides the best view for their placement of the device.

### TASK-042: Implement per-device disconnect and session end flow
- **Status**: done
- **Priority**: medium
- **Dependencies**: TASK-022, TASK-009
- **Description**: On the parent dashboard, add a disconnect button (e.g. a stop/X icon) to each baby monitor panel. When tapped, send a graceful disconnect message via the data channel, then close the `RTCPeerConnection` for that device and remove its panel from the dashboard. If multiple baby monitors are connected, the remaining ones are unaffected. On the baby monitor side, when a disconnect is received (or the connection closes unexpectedly), display a "Disconnected" screen with options to reconnect (re-run the pairing flow) or return to the home screen. Ensure all media tracks and Web Audio nodes for the disconnected device are properly stopped and released to free resources.

### TASK-043: Implement in-app parent audio recording and transfer to baby
- **Status**: done
- **Priority**: medium
- **Dependencies**: TASK-013, TASK-014, TASK-032, TASK-037, TASK-038
- **Description**: On the parent monitor, add an "Record for baby" feature alongside the file upload option in the audio panel. The parent taps a record button, which captures their microphone via `getUserMedia` and records audio using the `MediaRecorder` API (output format: WebM/Opus or OGG, whichever the browser supports). Show a live recording duration timer and a waveform or level meter so the parent can see audio is being captured. A stop button ends the recording. The parent is then offered a preview — a local playback of the recording before committing. If satisfied, they tap "Send to baby", which transfers the recording to the baby device using the same binary data channel chunking mechanism as TASK-013. Once received, the baby device stores and plays the recording on repeat in exactly the same way as any other transferred audio file, including respecting the fade-out timer (TASK-014) and audio ducking (TASK-038) rules. If the parent is not happy with the recording, they can discard it and re-record. The recording is not persisted beyond the session unless the parent explicitly saves it (which would store it in IndexedDB for re-use in future sessions, consistent with TASK-032).

### TASK-044: Implement safe sleep information screen and mandatory acknowledgement
- **Status**: done
- **Priority**: high
- **Dependencies**: TASK-001
- **Description**: Create a dedicated safe sleep information screen that is shown as a required step during first-run onboarding (TASK-031) and is permanently accessible via a clearly labelled "Safe Sleep Guide" button on the parent dashboard. The screen must be readable and well-formatted, with clear section headings. Content is drawn from NHS and Lullaby Trust guidance and must include the following:

  **When these guidelines apply (Lullaby Trust)**
  - These safer sleep practices apply for every sleep, day and night, until the baby is 12 months old. For premature or low birthweight babies, apply them until 12 months after their due date.

  **The six core safer sleep recommendations (Lullaby Trust)**
  1. Always lie your baby on their back to sleep.
  2. Keep their cot clear.
  3. Use a firm, flat, waterproof mattress.
  4. Keep baby smoke-free before and after birth.
  5. Avoid your baby getting too hot.
  6. Sleep your baby in the same room as you for at least the first six months.

  **Sleeping position and location (NHS + Lullaby Trust)**
  - The safest place for a baby to sleep for the first 6 months is in a cot or Moses basket, lying on their back, in the same room as a parent.
  - Always put baby to sleep on their back. Babies who are normally slept on their backs but are sometimes placed on their fronts are at higher risk of SIDS.
  - Room sharing for at least six months does not mean you cannot leave the room briefly, but the baby is safest when you are close by most of the time.
  - It is lovely to have your baby with you for a cuddle or a feed, but it is safest to put them back in their cot before you go to sleep.

  **Sleeping space — what to remove (NHS + Lullaby Trust)**
  - Use a cot or Moses basket. Ensure there are no toys or anything that could cover the baby's mouth or nose or cause overheating.
  - Do not use: cot bumpers, pillows, duvets, loose bedding, soft toys or comforters, weighted or bulky bedding, position-retention products (wedges, straps), sleeping pods, nests, rolled towels, or any soft items on the mattress.
  - Sleeping pods or nests are not advised as they have raised or cushioned areas.
  - Babies should not have anything soft around them, especially near their heads — this can cause overheating and increases the risk of SIDS (sudden infant death syndrome, sometimes called cot death).

  **Mattress (NHS + Lullaby Trust)**
  - The mattress must be firm, flat, and waterproof.
  - Buy a new mattress where possible. A mattress from your own home may be reused if stored somewhere clean, dry, and smoke-free.
  - Check firmness: the baby's head should not sink more than a few millimetres. A mattress that is not firm enough makes it harder for the baby to lose heat, increasing the risk of overheating.

  **Room temperature (Lullaby Trust)**
  - Try to keep the room temperature between 16°C and 20°C.
  - Use a room thermometer to monitor this. Overheating is associated with higher SIDS risk.

  **Sleeping bags (NHS)**
  - Baby sleeping bags reduce the risk of SIDS by preventing babies from wriggling under bedding.
  - Ensure the bag fits well around the shoulders so there is no risk of the baby's head slipping inside.
  - Match the tog rating to the room temperature: 2.5 tog (16–20°C), 1.0 tog (20–24°C), 0.5 tog (24–27°C).
  - No other bedding is needed when using a sleeping bag.

  **Blankets (if used instead of a sleeping bag) (NHS)**
  - Lie baby on their back with their feet nearest the foot of the cot to prevent loose bedding covering their face.
  - A cellular cotton blanket is best — it keeps baby warm while allowing airflow.
  - Tuck the blanket in firmly, no higher than the shoulders, and do not double it over.

  **Smoke exposure (NHS + Lullaby Trust)**
  - The risk of SIDS is much higher if you or your partner smoke during pregnancy or after the baby is born.
  - Keep baby smoke-free at all times, in all environments.

  **Breastfeeding (Lullaby Trust)**
  - Breastfeeding is associated with a reduced risk of SIDS.

  **Co-sleeping — when it is not safe (NHS)**
  - Never co-sleep if you are extremely tired, or if the baby has a fever or signs of illness.
  - Do not co-sleep if the baby was born premature (before 37 weeks) or had a low birthweight (under 2.5 kg / 5.5 lb).
  - Falling asleep on a sofa or chair with a baby substantially increases the risk of SIDS.
  - Co-sleeping is not safe if you or your partner have been: smoking, drinking alcohol, taking recreational drugs, or taking any medication that causes drowsiness.

  **Co-sleeping — if you do share a bed (NHS)**
  - Make sure the baby cannot fall out of bed or become trapped between the mattress and a wall.
  - Keep pillows, sheets, and blankets away from the baby (a sleeping bag is safer).
  - Do not let other children or pets in the bed at the same time.
  - Always put baby to sleep on their back.

  **Device placement notice (app-specific — display prominently)**
  - The monitor device must never be placed inside the cot or Moses basket. Position it outside the sleeping space entirely, on a stable surface at a safe distance, where the camera can observe the baby without any risk of the device falling into the sleeping area.

  The onboarding flow must require the parent to tick a checkbox confirming they have read the safe sleep guidance before they can proceed to device pairing. This acknowledgement is stored in `localStorage`. A "Safe Sleep Guide" button must be persistently visible on the parent dashboard (e.g. in the header or settings menu) so parents can revisit it at any time without repeating onboarding. Attribution links to the NHS and Lullaby Trust source pages should be included at the bottom of the screen.

### TASK-045: Implement browser compatibility detection and iOS Safari warning
- **Status**: done
- **Priority**: high
- **Dependencies**: TASK-001
- **Description**: On page load, detect the user's browser and platform before anything else runs. The app officially supports Chrome (and Chromium-based browsers) on desktop, Android, and iOS. It does not support Safari. Detect iOS Safari by checking the user agent for iPhone/iPad/iPod combined with the absence of the `CriOS` (Chrome on iOS) identifier. If iOS Safari is detected, display a fullscreen blocking modal explaining that this app requires Chrome to function, with clear instructions: "Please open this page in Chrome on your iPhone or iPad." Provide a copyable link so the user can easily open the URL in Chrome. Do not allow the app to proceed in iOS Safari. For all other unsupported browsers (e.g. Firefox, Opera), show a softer warning banner that the app is tested on Chrome and may not work as expected, but do not block them. Note in the README that Chrome on iOS uses the same WebKit rendering engine as Safari but provides better compatibility with the Web APIs this app requires; the Wake Lock API will still not be available on iOS Chrome, and the graceful fallback in TASK-003 handles this.

### TASK-046: Implement dark/night mode with time-based prompt and manual toggle
- **Status**: done
- **Priority**: medium
- **Dependencies**: TASK-001
- **Description**: Implement a two-theme system (light and dark) using CSS custom properties. On app load, check the current local time. If it is between 7:00 pm and 7:00 am, and the user has not previously set a manual preference, show a subtle non-blocking prompt: "It looks like it's evening — switch to dark mode?" with "Yes" and "No thanks" options. If the user accepts, or if their saved preference is dark, apply the dark theme immediately. The manual toggle (a sun/moon icon button) is always visible in the header on both monitor views and in settings, allowing the parent to switch at any time regardless of the time. The chosen theme is stored in `localStorage` and restored on every subsequent visit. The dark theme must use very low-luminance backgrounds and muted colours appropriate for a dark room; the light theme uses standard high-contrast colours for daytime use.

### TASK-047: Implement notification permission request during onboarding
- **Status**: done
- **Priority**: high
- **Dependencies**: TASK-001
- **Description**: Add a dedicated step in the onboarding wizard (TASK-031) to request notification permission. Display a clear explanation screen before the browser permission prompt appears, explaining exactly why notifications are needed: "Allow notifications so we can alert you about baby movement, unusual sounds, and low battery — even when the app is in the background or your phone screen is off." Include a button to "Enable notifications", which then calls `Notification.requestPermission()`. If the user grants permission, proceed. If the user denies or dismisses, show a note explaining what they will miss and how to enable notifications later in their browser settings, then allow them to continue without notifications — the app remains functional but without background alerts. Store the permission state in `localStorage` so the prompt is not shown again on subsequent visits. Important platform caveat: on iOS (including Chrome on iOS), web apps cannot trigger background notifications regardless of permission — Apple's OS does not permit this for web apps. On iOS, the explanation screen must clearly state this: "On iPhone and iPad, notifications will only show while this app is open. For background alerts, keep the app open on screen." This caveat must also be documented in the README (TASK-035).

### TASK-048: Implement baby device state sync to parent on connection
- **Status**: done
- **Priority**: high
- **Dependencies**: TASK-009, TASK-015, TASK-019
- **Description**: When the WebRTC data channel opens (on initial connection or after reconnection via TASK-030), the baby device must immediately broadcast a full state snapshot message to the parent. This snapshot includes: current soothing mode (candle/water/stars/music/off), currently active audio track name (if any), current music volume level, fade-out timer status (running or stopped) and remaining duration if running, battery level and charging state, camera facing direction, and stream quality setting. The parent dashboard reads this snapshot and sets all controls in the remote control panel to match the baby device's actual current state. Without this, the parent's controls would show default values rather than what is actually happening on the baby device. Add a `stateSnapshot` message type to the data channel protocol (TASK-009). Also send an updated snapshot whenever the baby device's state changes (e.g. mode changes, timer expires) so the parent panel stays in sync throughout the session.

### TASK-049: Implement audio file library management
- **Status**: done
- **Priority**: medium
- **Dependencies**: TASK-013, TASK-043
- **Description**: Implement a persistent audio file library using IndexedDB on both the parent and baby devices. On the parent device: store uploaded files (TASK-013) and recordings (TASK-043) with metadata (name, duration, file size, date added, type: uploaded/recorded). Provide a library panel in the audio section of the parent dashboard listing all stored files, each with options to preview (play locally), rename, send to baby, and delete. On the baby device: store all received files (from TASK-013 and TASK-043 transfers) in IndexedDB with the same metadata. Provide a file list accessible from the unlocked settings overlay, with options to play, set as current track, and delete individual files. Both sides should show approximate storage used and warn if IndexedDB quota is near its limit. Files persist across sessions so the parent does not need to re-upload on every use.

### TASK-050: Implement audible alert on parent device for noise and battery events
- **Status**: done
- **Priority**: medium
- **Dependencies**: TASK-024, TASK-027, TASK-036, TASK-047
- **Description**: When a noise threshold alert is triggered (TASK-024) or a low battery alert fires (TASK-036), play a gentle audible chime on the parent device in addition to the visual alert. Use the Web Audio API to generate or play a short, soft tone (not a harsh buzzer) so the parent is alerted even if their screen is off or they are not looking at the dashboard. Noise alerts and battery alerts should use distinct tones so the parent can tell them apart by sound alone. Provide separate volume controls for alert tones in settings (distinct from the baby stream volume). Include a mute/unmute toggle for alert sounds. Alert sounds must respect the autoplay policy — they will only play after the initial user gesture captured in TASK-037. If the parent has snoozed alerts (TASK-027), the audio alert should also be suppressed.

### TASK-051: Ensure soothing modes continue independently of connection state
- **Status**: done
- **Priority**: high
- **Dependencies**: TASK-003, TASK-015, TASK-019, TASK-030
- **Description**: All soothing activity on the baby device (music playback, canvas light effects, any active fade-out timer) must be entirely decoupled from the WebRTC connection state. If the connection drops, is reconnecting, or is lost entirely, the baby device must continue playing its current soothing mode without interruption. The connection lifecycle (TASK-030) must not pause, stop, or reset any audio or visual effects. Specifically: the Web Audio API playback graph must not be torn down on disconnection; the canvas animation loop must not be paused; and the fade-out timer must continue counting down. Only an explicit user action or a command received after a successful reconnection should change the soothing state. Add a note in the baby monitor UI that soothing modes will continue even if the connection is lost. Known iOS limitation: on iOS Chrome, the Wake Lock API is unavailable (TASK-003) so the device screen may sleep. When the screen sleeps, canvas-based light effects (TASK-016, TASK-017, TASK-018) will stop rendering as the browser pauses canvas animation — audio playback will continue unaffected. This is an OS-level constraint that cannot be worked around in a web app. The README (TASK-035) and the baby monitor settings screen should advise iOS users to use a music or audio-only soothing mode rather than light effects, as those modes are unaffected by screen sleep.

### TASK-052: Implement PWA install prompt
- **Status**: done
- **Priority**: medium
- **Dependencies**: TASK-002, TASK-031
- **Description**: Intercept the browser's `beforeinstallprompt` event and suppress the default prompt. After the user has completed first-run onboarding and successfully established their first baby monitor connection, show an in-app install banner: "Install this app for better background performance and battery life." Include an "Install" button that triggers the saved prompt and a "Not now" option that dismisses it. If the user dismisses it, do not show it again for at least 7 days (track in `localStorage`). If the app is already installed as a PWA, do not show the banner. On iOS Chrome (where `beforeinstallprompt` is not available), show a manual install instruction instead: "Tap the Share button then 'Add to Home Screen' for the best experience."

### TASK-053: Implement Service Worker update detection and refresh prompt
- **Status**: done
- **Priority**: medium
- **Dependencies**: TASK-002
- **Description**: When the Service Worker detects that a new version of the app has been deployed (the SW's `updatefound` and `statechange` events), show a non-blocking banner at the top of the screen: "A new version is available — tap to update." Tapping it calls `skipWaiting()` on the new Service Worker and reloads the page to activate it. The banner must not auto-reload without user consent, as an unexpected reload during an active monitoring session would be disruptive. If the user dismisses the banner, remind them again the next time the app is opened. Ensure the versioning strategy in the Service Worker cache name allows clean cache replacement on each deploy (e.g. include a build hash or version number in the cache name).

### TASK-054: Implement combined soothing light and music mode
- **Status**: done
- **Priority**: medium
- **Dependencies**: TASK-014, TASK-015, TASK-016, TASK-017, TASK-018, TASK-019, TASK-038
- **Description**: Extend the soothing mode selector on both the baby device (TASK-015) and the parent's remote control panel (TASK-025) to allow light and music to run simultaneously. Add a combined mode option alongside the existing single modes. When active, the chosen light effect renders fullscreen at reduced brightness while the selected audio track plays through the speakers. The screen brightness overlay used in music-only mode (near-black screen) must not be applied in combined mode — the light effect is the visual output. The fade-out timer (TASK-014) applies to the audio only in this mode; the light effect continues until the mode is changed. Audio ducking (TASK-038) operates normally in combined mode.

### TASK-055: Implement parent-side microphone permission handling
- **Status**: done
- **Priority**: high
- **Dependencies**: TASK-012, TASK-043
- **Description**: Both the speak-through feature (TASK-012) and the in-app recording feature (TASK-043) require microphone access on the parent device via `getUserMedia`. Add explicit permission handling for both: before the first microphone request, show a brief explanation of why microphone access is needed (e.g. "Microphone access lets you speak to your baby or record a message"). If the parent denies permission, display a clear error message with instructions for re-enabling microphone access in their browser settings, and disable the speak-through and record buttons with a visible "Microphone access required" label. If permission is subsequently granted (e.g. the parent enables it in settings and returns), re-enable the buttons automatically. Do not silently fail.

### TASK-056: Mute incoming baby audio on parent device while speak-through is active
- **Status**: done
- **Priority**: high
- **Dependencies**: TASK-011, TASK-012
- **Description**: When the parent activates speak-through (TASK-012) and their microphone is open, automatically mute or significantly reduce the volume of the incoming baby audio stream on the parent device (the `<video>` element or Web Audio output from TASK-011). This prevents a feedback loop where the parent's speakers play the baby's audio back into the parent's microphone. Apply a short, smooth volume ramp down (~0.2 s) when speak-through activates and a ramp back up (~0.5 s) when it deactivates. The noise level visualiser (TASK-024) should continue to function using the incoming audio data even while muted for playback, so the parent can still see if the baby stirs while speaking. The muting applies per-device when multiple baby monitors are connected — only the device the parent is speaking to needs muting if applicable, though muting all is acceptable.

### TASK-057: Implement empty state on parent dashboard
- **Status**: pending
- **Priority**: medium
- **Dependencies**: TASK-021
- **Description**: When the parent opens the dashboard and no baby monitor devices are paired or connected, display a clear and welcoming empty state instead of a blank grid. The empty state should include: the app name and a brief one-line description, a prominent "Add baby monitor" button that starts the pairing flow (TASK-006), and a short reminder that both devices need to have the app open to pair. If there are saved device profiles (TASK-023) but none are currently connected, show the saved devices in a "Not connected" state with a "Connect" button for each that initiates a new pairing session using the saved device ID. This gives returning users a clear starting point without having to navigate settings.

### TASK-058: Implement second parent device pairing via first parent's device
- **Status**: pending
- **Priority**: medium
- **Dependencies**: TASK-009, TASK-022, TASK-023, TASK-048, TASK-060, TASK-061
- **Description**: Allow a second parent device to connect to all paired baby monitors using the first parent's device as a broker, without needing to be physically near any baby device and without needing the first parent to remain connected afterwards.

  The second parent opens the app on their device and selects "Add this device as an additional parent monitor" (Method 3 from TASK-006). Their device displays a waiting screen. On the first parent's dashboard, a "Share with another parent" button triggers the sharing flow: the first parent's device displays its own current PeerJS peer ID as a single compact QR code with a short instruction ("Ask the other parent to scan this on their device").

  The second parent scans the first parent's QR. A temporary PeerJS connection opens between the two parent devices. The first parent's app then automatically sends the second parent — as a single JSON message over this temporary connection — the full details for every paired baby monitor: label, current primary PeerJS peer ID, and full backup ID pool (TASK-061). No further interaction is needed from the first parent.

  The second parent's app receives this payload, stores each baby monitor in its own device profiles (TASK-023), and immediately begins connecting to each baby monitor directly and independently using the PeerJS IDs provided. The temporary parent-to-parent connection is then closed. From this point both parent devices have fully independent direct connections to each baby monitor — either parent can disconnect or close the app without affecting the other. The second parent device counts toward each baby monitor's 4-connection limit (TASK-022) and receives the state snapshot (TASK-048) on connecting to each baby device.

### TASK-059: Implement connection diagnostics panel
- **Status**: pending
- **Priority**: low
- **Dependencies**: TASK-007, TASK-030
- **Description**: Provide a "Connection details" panel accessible from the "Re-pair devices" prompt (TASK-030) and from a discreet link in the settings screen. The panel shows read-only diagnostic information to help a user or support person understand why a connection failed. For the PeerJS path: PeerJS peer ID, PeerJS server connection state, backup IDs tried, and any PeerJS error message. For the offline QR path: `RTCPeerConnection` state, `iceConnectionState`, number of ICE candidates gathered, and whether the data channel opened. Both paths: connection method in use, and the last error message. On the baby monitor side, show equivalent information in the unlocked settings overlay. This information should update live while connection is being established. No action buttons are needed — the panel is informational only, giving users something concrete to report if they encounter a persistent failure.

### TASK-060: Integrate PeerJS library and implement peer lifecycle management
- **Status**: done
- **Priority**: high
- **Dependencies**: TASK-001
- **Description**: Integrate the PeerJS library (loaded from CDN and cached by the Service Worker per TASK-002). Implement a peer management module used by both the baby monitor and parent monitor. On first use, generate a stable UUID-based peer ID and store it in `localStorage`. Create a `Peer` object with this ID, connected to the PeerJS cloud signaling server by default (configurable via TASK-008). Handle all peer lifecycle events: `open` (peer registered with server and ready), `disconnected` (lost connection to signaling server — attempt to reconnect), `error` (classify error: ID taken, network error, server unavailable, etc. and surface appropriately), and `close` (peer destroyed). Expose a clean status to the rest of the app: `registering`, `ready`, `disconnected`, `error`. If the PeerJS server is unreachable on startup, the app should surface a clear message that PeerJS is unavailable and offer the offline QR method as an alternative. The peer ID is displayed (as a QR and as readable text) in the pairing flow (TASK-006).

### TASK-061: Implement pre-agreed PeerJS ID pool for automatic reconnection and parent sharing
- **Status**: done
- **Priority**: high
- **Dependencies**: TASK-060, TASK-009
- **Description**: To enable automatic reconnection without re-pairing, and to allow second parent devices to connect independently, each baby monitor pre-generates a pool of backup PeerJS peer IDs on first setup. Generate 20 random UUID-based IDs at setup time and store them in `localStorage` on the baby device alongside a current index pointer. After the initial PeerJS data connection is established (TASK-009), the baby device immediately sends the full ID pool (as a JSON array) and the current index to the connected parent via the data channel. The parent stores the pool against that baby device's profile (TASK-023). On subsequent connections, both sides track the pool index. When auto-reconnect is triggered (TASK-030), the baby device increments its index, registers the next pool ID with PeerJS, and the parent simultaneously tries to connect to each ID in the pool starting from the last known index. Both sides advance the index in sync and persist it so reconnection works even after a full app restart. When the pool falls below 5 unused IDs, the baby device generates 20 new IDs, appends them to the pool, and broadcasts the additions to ALL currently connected parent devices — not just one. If two parent devices are connected (TASK-058), both must receive the updated pool or one parent's reconnection attempts will use a stale list. The replenishment broadcast uses the same data channel message type as the initial pool exchange. The full pool is also included in the data sent to a second parent device during TASK-058's sharing flow.

---

## E2E Testing

### TASK-062: Set up Playwright E2E test framework
- **Status**: done
- **Priority**: high
- **Dependencies**: TASK-001
- **Description**: Add Playwright as a development-only testing tool. Create a `tests/` directory with a `package.json` that installs Playwright as a devDependency — this keeps test tooling separate from the app's plain HTML/CSS/JS structure. Create `playwright.config.js` configuring: (1) Chromium only (the target browser for this app); (2) launch args `--use-fake-ui-for-media-stream` and `--use-fake-device-for-media-stream` so tests run without a real camera or microphone; (3) a base URL pointing to a local static file server (e.g. `npx serve`); (4) a test timeout of 20 seconds to accommodate WebRTC connection establishment. Create a shared helper (`tests/helpers.js`) that launches two browser contexts representing a baby device and a parent device, each with isolated `localStorage`. Add `npm test` and `npm run test:headed` scripts to the `tests/package.json`. The production app files must remain unchanged — no build tooling, bundlers, or config files added to the app root.

### TASK-063: E2E tests for PeerJS pairing flow
- **Status**: done
- **Priority**: high
- **Dependencies**: TASK-062, TASK-006, TASK-007, TASK-060, TASK-061
- **Description**: Write E2E tests for the primary PeerJS pairing method using the two-context helper from TASK-062. (1) In the baby context, navigate to baby monitor mode and perform the tap-to-begin gesture; verify the PeerJS peer ID is displayed as readable text and as a QR code. (2) In the parent context, navigate to parent mode, enter the baby's peer ID, and confirm; verify both contexts show "connected" status within the connection timeout. (3) Verify the data channel is open by sending a test ping message from the parent and confirming a pong response from the baby. (4) Verify the initial state snapshot (battery level, current mode) is received by the parent on connection. (5) Sad path: entering an invalid or unknown peer ID shows a clear error message without crashing.

### TASK-064: E2E tests for video and audio streaming
- **Status**: done
- **Priority**: high
- **Dependencies**: TASK-062, TASK-010, TASK-011, TASK-012, TASK-037
- **Description**: Write E2E tests for media streaming between paired contexts. Chromium's fake media stream injects a coloured frame and a sine-wave tone automatically when the launch flags from TASK-062 are active. After pairing: (1) verify the parent dashboard's video element receives frames (`videoWidth > 0` and `readyState >= 2`); (2) verify the noise visualiser shows a non-zero level, confirming the baby's audio track is live; (3) simulate a speak-through interaction from the parent — verify `getUserMedia` is called in the parent context and that the baby device's incoming audio GainNode is ramped to zero (silencing the baby's speaker output per TASK-056); (4) verify the baby's AudioContext is in `running` state, confirming the tap-to-begin gate (TASK-037) was satisfied before any media API was called.

### TASK-065: E2E tests for soothing light and music modes
- **Status**: pending
- **Priority**: medium
- **Dependencies**: TASK-062, TASK-016, TASK-017, TASK-018, TASK-019, TASK-054
- **Description**: Write E2E tests for soothing content on the baby device. (1) For each visual mode (candle, water, stars): activate the mode via the UI, wait one animation frame, and assert the canvas element has non-zero dimensions and at least one non-black pixel in the centre region (read via `getImageData` in a `page.evaluate` call). (2) Activate music playback and verify the AudioContext is in `running` state and the source node is connected to the destination. (3) Activate combined mode (TASK-054) and verify both canvas and audio are active simultaneously. (4) Set the fade-out timer to its minimum value and verify the audio GainNode value reaches zero within the expected window. (5) Disconnect the parent context and verify music continues playing on the baby device without interruption (TASK-051).

### TASK-066: E2E tests for noise and battery alerts
- **Status**: done
- **Priority**: high
- **Dependencies**: TASK-062, TASK-024, TASK-027, TASK-032, TASK-036, TASK-047, TASK-050
- **Description**: Write E2E tests for the alert system. Noise alerts: (1) grant Notification permission in the parent context via Playwright's browser context permissions; (2) set the noise threshold for a connected baby device to its minimum (most sensitive); (3) confirm the fake sine-wave audio stream triggers a noise alert notification and an audible alert sound on the parent; (4) set the threshold to maximum (least sensitive) and confirm no alert fires; (5) connect two baby devices with different threshold settings and verify alerts are independent per device. Battery alerts: (6) inject a low-battery data-channel message from the baby context (level below 20%) using `page.evaluate` to call the app's internal message handler; (7) verify a battery alert notification appears on the parent with higher visual prominence than a noise alert, per the priority rule in TASK-036; (8) inject a battery-recovered message and verify the alert clears.

### TASK-067: E2E tests for automatic reconnection
- **Status**: done
- **Priority**: high
- **Dependencies**: TASK-062, TASK-030, TASK-061
- **Description**: Write E2E tests verifying reconnection without re-pairing. (1) Pair a baby and parent context via PeerJS. (2) Close the baby browser context to simulate a disconnection. (3) Verify the parent shows a "reconnecting" UI state within a short delay. (4) Reopen the baby context (simulating the app restarting); verify the baby re-registers using the next ID in the backup pool (TASK-061) and the parent reconnects automatically. (5) Verify both contexts reach "connected" state without any user action. (6) Verify the data channel is functional after reconnection by exchanging a test message. (7) Confirm the pool index was persisted correctly across the baby context's close and reopen — the baby must not reuse an already-tried ID.

### TASK-068: E2E tests for audio file transfer
- **Status**: pending
- **Priority**: medium
- **Dependencies**: TASK-062, TASK-013, TASK-043
- **Description**: Write E2E tests for audio file transfer from parent to baby. (1) After pairing, inject a small synthetic audio `Blob` (a valid WAV file) into the parent context's file picker via `page.setInputFiles`. (2) Trigger the transfer and verify a progress indicator appears in the parent UI. (3) Verify the baby context receives the file and it appears in the local audio library. (4) Verify the transferred file can be selected for playback on the baby device (AudioContext loads the buffer without error). (5) Simulate a mid-transfer interruption by closing the data channel using `page.evaluate` and verify the UI clears the partial transfer cleanly without throwing an unhandled error. (6) Attempt to start a second transfer while one is already in progress and verify it is rejected with a user-visible message, confirming the no-concurrent-transfers rule.

### TASK-069: E2E tests for second parent pairing
- **Status**: pending
- **Priority**: medium
- **Dependencies**: TASK-062, TASK-058, TASK-022, TASK-023
- **Description**: Write E2E tests for the three-device second-parent pairing flow using three browser contexts: one baby device and two parent devices. (1) Pair the first parent with the baby via PeerJS. (2) On the first parent UI, initiate "Add another parent device" and verify the first parent's own peer ID is displayed as a QR code. (3) In the second parent context, enter the first parent's peer ID to begin the broker flow. (4) Verify the first parent sends a payload containing all baby monitor peer IDs and backup pools to the second parent over the parent-to-parent data channel. (5) Verify the second parent then connects directly to the baby device independently, without routing through the first parent. (6) Close the first parent context and verify the second parent remains connected to the baby. (7) Verify both parents count toward the baby device's 4-connection limit (TASK-022).

### TASK-070: E2E tests for QR code fallback pairing
- **Status**: pending
- **Priority**: medium
- **Dependencies**: TASK-062, TASK-004, TASK-005, TASK-007
- **Description**: Write E2E tests for the offline QR code pairing method. (1) Simulate PeerJS being unavailable by intercepting the PeerJS CDN request via `page.route` and returning a network error; verify the app surfaces a clear "PeerJS unavailable" message and offers the QR fallback option. (2) In the baby context, activate "Offline QR pairing" and verify the first offer QR code is rendered on a canvas element. (3) Extract the QR data from the canvas using a JS QR decoder in a `page.evaluate` call (or read a `data-qr-payload` attribute if the app exposes one). (4) Inject the SDP offer payload into the parent context and verify the parent renders an answer QR code. (5) Complete the full SDP and ICE exchange programmatically, cycling through all QR frames. (6) Verify both contexts reach "connected" state and the data channel opens, confirming the offline path works end-to-end with no server dependency.

### TASK-071: E2E tests for PWA and offline functionality
- **Status**: pending
- **Priority**: medium
- **Dependencies**: TASK-062, TASK-002, TASK-052, TASK-053
- **Description**: Write E2E tests for Service Worker caching and offline behaviour. (1) Load the app for the first time and verify the Service Worker registers successfully (check `navigator.serviceWorker.ready` resolves). (2) Use `context.setOffline(true)` to simulate losing internet connectivity. (3) Reload each app page and verify they load from the Service Worker cache — no network errors, no blank screens. (4) Verify CDN-hosted libraries (PeerJS, QR library) are served from cache and not re-requested from the network. (5) While offline, verify the app shows the "PeerJS unavailable" message and offers the QR fallback cleanly, with no JS exceptions from failed CDN fetches. (6) Bring the network back online, serve a new Service Worker with a bumped cache key, and verify the "update available" prompt appears on the next page load without forcing an automatic reload.
