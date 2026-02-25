# Baby Monitor

A browser-based, peer-to-peer baby monitor hosted on GitHub Pages. Two devices pair
via WebRTC — video and audio stream directly between them with no server, no account,
and no subscription required. The app works entirely over your local Wi-Fi network and
can be installed as a PWA for a native app-like experience.

---

## Accessing the App

Open the GitHub Pages URL in a supported browser (see [Browser Compatibility](#browser-compatibility))
on both devices. Both devices must be on the **same Wi-Fi network** for the connection to work
(unless you have configured a TURN relay server — see [Advanced Connection Settings](#advanced-connection-settings)).

No installation is required — the app runs in your browser. You can also [install it as a PWA](#installing-as-a-pwa)
for offline use and a full-screen experience.

---

## Pairing Two Devices

You need two devices: a **baby monitor** (placed near the baby) and a **parent monitor** (kept with you).

Open the app on both devices, then:

1. On the device near the baby, tap **Baby Monitor**.
2. On your device, tap **Parent Monitor**.
3. Choose a connection method (see below).

### Connection Methods

#### 1. Quick Pair (PeerJS)

The fastest option when both devices have internet access.

1. On the parent device, choose **Quick Pair**.
2. A QR code is displayed — scan it with the baby device's camera.
3. The devices connect automatically via the PeerJS cloud signalling server.

The internet connection is only needed for the initial handshake. Once paired, all
video and audio travel directly between devices over your local network.

#### 2. Offline QR Pairing

Works with no internet connection at all — ideal for travel or areas with no mobile data.
Connection data is exchanged as a sequence of QR codes scanned back and forth between devices.

1. On the parent device, choose **Offline QR**.
2. Follow the on-screen prompts: scan the QR code shown on the baby device, then show the resulting QR code back to the baby device.
3. The devices complete the WebRTC handshake entirely locally and connect.

This method does not contact any external server at any point.

#### 3. Add a Second Parent Device

If you want a second parent to monitor the baby (for example, in a different room or on a partner's phone),
you can add another parent device without re-pairing the baby device.

1. On the new parent device, tap **Add Parent Device** on the home screen.
2. On the already-connected parent device, open the option to share access — a QR code is shown.
3. Scan that QR code on the new parent device.

The new device connects via the existing parent as an intermediary.

---

## Installing as a PWA

Installing to your home screen gives you a full-screen, app-like experience and
ensures the app can be launched instantly without typing the URL.

**Android (Chrome):**
1. Open the app in Chrome.
2. Tap the three-dot menu → **Add to Home screen**, or tap the install banner when it appears.
3. Tap **Install**. The app icon appears on your home screen and launches full-screen.

**iOS (Chrome):**
1. Open the app in Chrome.
2. Tap the **Share** button → **Add to Home Screen** → **Add**.

**Desktop (Chrome):**
1. Click the install icon in the address bar (right side).
2. Click **Install**.

Once installed, the app is cached for offline use. Video and audio still stream over
your local Wi-Fi — the offline capability means the app shell loads without internet,
not that it streams without a network.

---

## "Tap to Begin"

Every time you open the app you will see a full-screen **"Tap anywhere to begin"** prompt.
**This is a browser security requirement, not a bug.**

Browsers prevent pages from playing audio or accessing the camera and microphone until
the user has interacted with the page. The tap satisfies this requirement for the session.
It cannot be bypassed, cached, or skipped — you must tap once on every fresh load of the app.

---

## Soothing Modes

The baby monitor can display soothing visuals and play audio, controlled remotely
from the parent device:

- **Candle** — soft flickering candlelight effect
- **Water** — gentle blue ripple light
- **Stars** — drifting night sky with twinkling stars
- **Music** — plays soothing music (upload your own tracks from the parent device)
- **Off** — no effect

Soothing modes continue running even if the parent device disconnects temporarily.
The baby device reconnects automatically when the parent comes back online.

---

## Battery-Saving Tips

Continuous video streaming drains battery faster than normal use. To extend battery life:

- **Lower the video quality.** On the parent monitor, open stream settings and reduce
  the resolution or frame rate. Lower quality means less processing and less battery use on both devices.
- **Use Music mode on iOS baby devices.** Canvas-based light effects (Candle, Water, Stars) pause when
  the iOS screen sleeps because the browser suspends canvas rendering. Music keeps playing regardless
  of screen state. Music mode is the best choice for iOS baby devices left overnight.
- **Keep the baby device plugged in.** If possible, connect the baby device to a charger.
  The app shows a low battery alert on the parent when the baby device drops below 20%.
- **Dim the baby device screen.** The soothing effects are visible at low brightness.
  Reduce brightness manually to save power while keeping the display on.
- **Let the parent screen turn off.** The parent device does not need to stay on continuously.
  Movement, noise, and battery alerts arrive as notifications even when the parent screen is off —
  unless you are using iOS (see [Browser Compatibility](#browser-compatibility)).

---

## Browser Compatibility

| Platform | Browser | Support |
|---|---|---|
| Android | Chrome | Fully supported |
| Desktop (Windows / macOS / Linux) | Chrome | Fully supported |
| iOS | Chrome | Supported — with two important caveats (see below) |
| iOS | Safari | **Not supported** |
| macOS | Safari | **Not supported** |
| Any | Firefox, Edge, Opera, etc. | Not tested — may work, soft warning shown |

### iOS Users — You Must Use Chrome

Safari on iOS does not support the WebRTC APIs this app requires. If you open the app
in Safari on iPhone or iPad, you will see a blocking message instructing you to switch to Chrome.

### Chrome on iOS — Two Important Limitations

Chrome on iOS is supported, but two platform-level restrictions apply:

**1. The screen may sleep, pausing canvas light effects.**

The Wake Lock API (which keeps the screen on) is unavailable in Chrome on iOS. If the device's
auto-lock timer fires, the screen sleeps and the canvas-based soothing effects (Candle, Water, Stars)
pause. Audio continues playing uninterrupted.

**Workaround:** Use **Music mode** on iOS baby devices — it is unaffected by screen sleep.
You can also disable Auto-Lock in iOS Settings → Display & Brightness → Auto-Lock while monitoring.

**2. Alerts only appear while the app is open on screen.**

Apple does not permit web apps to deliver background notifications on iPhone or iPad, regardless
of browser. This is an OS-level restriction. Movement alerts, noise alerts, and low battery alerts
will only appear while the app is actively visible — they will not arrive if the app is in the
background, the screen is locked, or the browser tab is not active.

**Workaround:** Keep the parent app on screen when you need alerts. For reliable background alerting,
use an Android or desktop device as the parent monitor.

---

## Troubleshooting

### Camera permission was denied

The baby device needs camera and microphone access; the parent device needs microphone access
for the speak-through feature.

If you denied the permission by mistake:

1. In Chrome, tap the lock or camera icon in the address bar.
2. Set Camera and Microphone to **Allow**.
3. Reload the page and tap to begin again.

On Android you may need to go to **Settings → Apps → Chrome → Permissions** to re-enable them.

### The connection keeps failing

- **Check both devices are on the same Wi-Fi network.** Mobile data and Wi-Fi are separate networks —
  WebRTC requires a direct path between devices.
- **Try Offline QR pairing.** If Quick Pair fails, Offline QR works entirely without external
  servers and is unaffected by PeerJS availability or network filtering.
- **Try reloading both devices** and pairing again from scratch.
- **Corporate or managed networks** may block STUN. In Settings, configure a **TURN relay server**
  (e.g. `turn:your-server.example.com:3478`) to route the connection through a relay.

### Audio is not playing on the baby device

- Make sure you tapped the **"Tap to begin"** overlay on the baby device — audio cannot play without it.
- Check that the baby device is not muted (hardware mute switch or system volume).
- If using a custom uploaded audio file, verify the file transferred successfully. Try switching
  soothing mode off and back on.
- If the audio context was suspended by the browser, reload the page and tap to begin again.

### The app is prompting me to update

A **"A new version is available"** banner appears when the app has been updated and a new version
is ready to load. Tap **Update** to apply it — the page reloads automatically.

If the banner reappears after updating, clear the browser's site data for this app, or
uninstall and reinstall the PWA. This forces the old Service Worker to be replaced.

### PeerJS Quick Pair is not working

The Quick Pair method uses the public PeerJS cloud signalling server. If it is unavailable
or blocked on your network, Quick Pair will fail.

**Use Offline QR pairing instead** — it has no dependency on any external server and works
entirely over your local network. Alternatively, configure a self-hosted PeerJS server in
**Settings → Custom PeerJS Server**.

---

## Advanced Connection Settings

Both options below are optional. The app works without any configuration using PeerJS defaults
(public cloud signalling + Google STUN).

### TURN Server

In most home Wi-Fi networks, STUN-based ICE negotiation establishes a direct connection.
In strict corporate networks or double-NAT environments where STUN hole-punching fails,
a TURN relay server is needed.

Open **Settings** from the home screen or parent dashboard and configure:

| Field | Example |
|---|---|
| TURN server URL | `turn:relay.example.com:3478` (use `turns:` for TLS) |
| Username | Optional — only if your server requires authentication |
| Credential | Optional — the shared secret or password |

### Self-Hosted PeerJS Server

By default, Quick Pair uses the public PeerJS cloud signalling server. To use your own:

Open **Settings → Custom PeerJS Server** and configure the host, port, path, and
whether to use HTTPS/WSS. Changes take effect on the next connection attempt.

Refer to the [peerjs-server documentation](https://github.com/peers/peerjs-server) for
server setup instructions.

---

## Privacy

All video and audio travel directly between devices using WebRTC peer-to-peer connections.
Nothing is sent to any external server.

The only exception is Quick Pair: the PeerJS signalling server is used to exchange connection
details (IP addresses and session tokens) during the initial handshake. No audio or video
data passes through this server. Offline QR pairing does not contact any external server at any point.

Settings and device profiles are stored locally using `localStorage`. Nothing is synced to the cloud.

---

## Architecture

| File / Directory | Purpose |
|---|---|
| `index.html` | Home screen — role selection (baby / parent) |
| `baby.html` | Baby device view — streams video and audio, displays soothing content |
| `parent.html` | Parent device view — monitors baby feed, remote controls, alerts |
| `js/` | ES modules — no build step required |
| `css/` | Plain CSS with custom properties for theming |
| `sw.js` | Service Worker — offline caching and PWA update detection |
| `manifest.json` | PWA manifest |
