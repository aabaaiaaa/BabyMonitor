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

- **Other APIs**: WebRTC and `getUserMedia` are available on iOS 14.3+ for all
  browsers. The QR-based offline pairing (TASK-004 / TASK-005) and PeerJS
  quick-pair (TASK-006) flows have been designed to work within these constraints.

## Getting started

Open `index.html` on two devices connected to the same Wi-Fi network, or serve
the directory with any static file server:

```
npx serve .
```

Then navigate to the served URL in Chrome on both devices and follow the
on-screen pairing instructions.

## Architecture

- **`index.html`** — Mode selection (baby device / parent device)
- **`baby.html`** — Baby device view: streams video/audio, shows soothing content
- **`parent.html`** — Parent device view: monitors baby, remote controls
- **`js/`** — ES modules; no build step required
- **`css/`** — Plain CSS with custom properties for theming
- **`sw.js`** — Service Worker for offline caching (TASK-002)
- **`manifest.json`** — PWA manifest (TASK-002)
