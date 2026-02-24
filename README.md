# WebRTC Baby Monitor

A browser-based, peer-to-peer baby monitor web app hosted on GitHub Pages.
Two devices pair via WebRTC using a sequence of low-density QR codes to exchange
signalling data — no server required.

## Browser support

| Browser | Platform | Status |
|---|---|---|
| Chrome | Desktop (Windows / macOS / Linux) | ✅ Fully supported |
| Chrome | Android | ✅ Fully supported |
| Chrome (CriOS) | iOS (iPhone / iPad) | ✅ Supported (with caveats — see below) |
| Safari | iOS / macOS | ❌ Not supported |
| Firefox | Any | ⚠️ Not tested — may work, soft warning shown |
| Edge, Opera | Any | ⚠️ Not tested — may work, soft warning shown |

### iOS Chrome and WebKit

Chrome on iOS (`CriOS`) is classified as **supported** and will not trigger the
browser-incompatibility warning. However, it is important to note:

- **Same rendering engine as Safari**: Apple's App Store guidelines require all
  iOS browsers to use the WebKit rendering engine. Chrome on iOS is therefore
  built on WebKit rather than Blink, meaning its Web API surface is similar to
  Safari, not desktop Chrome.

- **Wake Lock API unavailable**: The Screen Wake Lock API (`navigator.wakeLock`)
  is not available on any iOS browser, including Chrome on iOS. The graceful
  fallback implemented in TASK-003 handles this automatically: the app continues
  to work without a wake lock, and the device may dim or sleep after the system
  idle timeout.

  **Impact on soothing modes**: When the iOS device screen sleeps, the browser
  suspends canvas rendering, so canvas-based light effects (Candle, Water, Stars)
  will pause visually. **Audio playback is not affected** — music, white noise,
  and rain sounds continue through screen sleep. If you are using the baby device
  as an overnight soother on an iOS device, choose **Music mode** (or any
  audio-only mode) rather than a canvas light effect. The baby monitor settings
  screen displays this advisory automatically on iOS devices.

- **Background notifications not available on iOS**: Apple's OS does not permit
  web apps to deliver push or background notifications on iPhone and iPad,
  regardless of which browser is used. This is an OS-level restriction that
  affects all web apps on iOS (including Chrome on iOS). Granting notification
  permission in the browser has no effect when the app is in the background or
  the screen is off.

  On iOS, the notification permission screen clearly explains this limitation:
  notifications will only appear while the app is actively open in the browser.
  Users who need background monitoring alerts on an iOS device should keep the
  browser open with the screen on (or use a non-iOS device as the parent monitor).

- **Other APIs**: WebRTC and `getUserMedia` are available on iOS 14.3+ for all
  browsers. The QR-based offline pairing (TASK-004 / TASK-005) and PeerJS
  quick-pair (TASK-006) flows have been designed to work within these constraints.

## Why you must tap before the app starts

Every time you open the app — on both the baby device and the parent device — you
will see a full-screen **"Tap anywhere to begin"** overlay before anything else loads.

**This is a hard browser security requirement, not a bug.**

Browsers enforce an *autoplay policy* that prevents any page from creating or
resuming an `AudioContext`, or calling `getUserMedia` (camera and microphone
access), unless the user has first interacted with the page. This policy exists
to stop websites from playing sound or accessing media without your knowledge.

The tap-to-begin overlay is the minimal interaction needed to satisfy this
requirement. After the tap:
- The `AudioContext` is unlocked so audio can be played on the baby device and
  monitored on the parent device.
- `getUserMedia` can be called to request camera and microphone access on the
  baby device.
- The WebRTC connection and pairing flow proceed normally.

**The gesture cannot be bypassed, stored, or cached across sessions.** Even if
you install the app as a PWA and reopen it, you will always see the overlay on
every fresh load. This is intentional and correct behaviour — it is the browser
enforcing its own security model, and there is no way to opt out.

## Getting started

Open `index.html` on two devices connected to the same Wi-Fi network, or serve
the directory with any static file server:

```
npx serve .
```

Then navigate to the served URL in Chrome on both devices and follow the
on-screen pairing instructions.

## Advanced connection settings

Both options below are entirely optional. The app works without any configuration
using PeerJS defaults (public cloud signalling server + Google STUN).

### TURN server

In most home Wi-Fi networks the default STUN-based ICE negotiation works fine.
In strict corporate / enterprise networks, or in double-NAT environments where
STUN hole-punching cannot establish a direct path, a **TURN relay server** is
needed.

To configure a TURN server, open **Settings** (from the home screen or the parent
dashboard) and expand the **TURN Server** panel:

| Field | Example | Notes |
|---|---|---|
| TURN server URL | `turn:relay.example.com:3478` | Required; use `turns:` for TLS |
| Username | `alice` | Optional — only needed if your TURN server requires authentication |
| Credential | `secret` | Optional — the shared secret / password |

The TURN details are stored in `localStorage` and are passed to:
- The `iceServers` option of the PeerJS `Peer` constructor (Quick Pair path)
- The `RTCPeerConnection` configuration used in the Offline QR pairing path

Leave the field blank to fall back to the default STUN-only configuration.

### Self-hosted PeerJS server

By default, Quick Pair uses the [public PeerJS cloud signalling server](https://peerjs.com/).
If you prefer to run your own, configure its address under **Settings → Custom PeerJS Server**:

| Field | Default | Notes |
|---|---|---|
| Host | *(PeerJS cloud)* | Hostname of your server, e.g. `peerjs.example.com` |
| Port | `9000` | TCP port your server listens on |
| Path | `/` | Mount path, e.g. `/peerjs` |
| Use HTTPS / WSS | ✓ | Disable only for local development over HTTP |

Changes take effect on the next connection attempt (i.e. after the pairing flow is
restarted). Self-hosted PeerJS server setup is outside the scope of this app —
refer to the [peerjs-server](https://github.com/peers/peerjs-server) documentation.

## Architecture

- **`index.html`** — Mode selection (baby device / parent device)
- **`baby.html`** — Baby device view: streams video/audio, shows soothing content
- **`parent.html`** — Parent device view: monitors baby, remote controls
- **`js/`** — ES modules; no build step required
- **`css/`** — Plain CSS with custom properties for theming
- **`sw.js`** — Service Worker for offline caching (TASK-002)
- **`manifest.json`** — PWA manifest (TASK-002)
