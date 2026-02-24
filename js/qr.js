/**
 * qr.js — QR code generation and scanning utilities (TASK-004, TASK-005)
 *
 * Generation:
 *   - Single QR: for a short string (e.g. PeerJS peer ID, ~36 chars).
 *   - Multi-QR grid: for a large payload (WebRTC SDP, ~1–2 KB) split into
 *     fixed-size chunks of ~300 bytes each.  Every chunk is prefixed with
 *     a sequence header "N/T:" so the receiver can track reassembly.
 *
 * Scanning:
 *   - Single scan: opens the camera, detects one QR, returns the decoded string.
 *   - Multi-scan: opens the camera, detects multiple QRs per frame, tracks
 *     which chunks have been received, and resolves when all are collected.
 *
 * This module uses the following CDN libraries (cached by the Service Worker):
 *   - QR generation: qrcode (https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js)
 *   - QR scanning:   jsQR  (https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.min.js)
 *
 * Both libraries must be loaded globally before this module is used.
 * They are loaded via <script> tags in the HTML so they are available
 * as window.QRCode and window.jsQR respectively.
 *
 * Implementation note: the actual library calls are wrapped in lazy
 * accessor functions so that this module can be imported before the
 * libraries are loaded (they are fetched asynchronously by the browser).
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Maximum byte length of a single QR chunk payload (excluding header).
 * Chosen to keep QR density low enough for comfortable scanning.
 */
export const CHUNK_SIZE = 300;

/** Sequence header format: "N/T:" where N is 1-based index, T is total. */
const HEADER_RE = /^(\d+)\/(\d+):/;

// ---------------------------------------------------------------------------
// Generation — single QR
// ---------------------------------------------------------------------------

/**
 * Render a single QR code into a container element.
 * Clears any previous content from the container first.
 *
 * @param {HTMLElement} container — element to render the QR into
 * @param {string} text           — the string to encode
 * @param {object} [options]
 * @param {number} [options.size=240]        — QR size in pixels
 * @param {string} [options.colorDark='#000000']
 * @param {string} [options.colorLight='#ffffff']
 * @param {string} [options.errorLevel='L']  — 'L' | 'M' | 'Q' | 'H'
 * @returns {void}
 */
export function renderQR(container, text, options = {}) {
  if (typeof QRCode === 'undefined') {
    console.error('[qr] QRCode library not loaded');
    container.textContent = 'QR library not available';
    return;
  }

  const {
    size       = 240,
    colorDark  = '#000000',
    colorLight = '#ffffff',
    errorLevel = 'L',
  } = options;

  // Clear previous content
  container.innerHTML = '';

  // eslint-disable-next-line no-new
  new QRCode(container, {
    text,
    width:          size,
    height:         size,
    colorDark,
    colorLight,
    correctLevel:   QRCode.CorrectLevel[errorLevel] ?? QRCode.CorrectLevel.L,
  });
}

// ---------------------------------------------------------------------------
// Generation — multi-QR grid
// ---------------------------------------------------------------------------

/**
 * Split a string payload into fixed-size chunks, each prefixed with a
 * sequence header "N/T:".
 *
 * @param {string} payload
 * @param {number} [chunkSize=CHUNK_SIZE]
 * @returns {string[]} array of chunk strings
 */
export function chunkPayload(payload, chunkSize = CHUNK_SIZE) {
  const chunks = [];
  for (let i = 0; i < payload.length; i += chunkSize) {
    chunks.push(payload.slice(i, i + chunkSize));
  }
  const total = chunks.length;
  return chunks.map((chunk, idx) => `${idx + 1}/${total}:${chunk}`);
}

/**
 * Render a grid of QR codes representing a chunked payload.
 *
 * @param {HTMLElement} container   — element to render the grid into
 * @param {string} payload          — the full payload to encode
 * @param {object} [options]
 * @param {number} [options.chunkSize=CHUNK_SIZE]
 * @param {number} [options.qrSize=180]  — size in px of each individual QR
 * @returns {number} number of QR codes rendered
 */
export function renderQRGrid(container, payload, options = {}) {
  const { chunkSize = CHUNK_SIZE, qrSize = 180 } = options;

  if (typeof QRCode === 'undefined') {
    console.error('[qr] QRCode library not loaded');
    container.textContent = 'QR library not available';
    return 0;
  }

  const chunks = chunkPayload(payload, chunkSize);

  // Clear previous content
  container.innerHTML = '';

  // Set CSS grid columns based on chunk count
  const cols = chunks.length <= 4 ? chunks.length : Math.ceil(Math.sqrt(chunks.length));
  container.style.gridTemplateColumns = `repeat(${cols}, ${qrSize}px)`;

  for (const chunk of chunks) {
    const cell = document.createElement('div');
    cell.style.width  = `${qrSize}px`;
    cell.style.height = `${qrSize}px`;
    container.appendChild(cell);

    // eslint-disable-next-line no-new
    new QRCode(cell, {
      text:         chunk,
      width:        qrSize,
      height:       qrSize,
      correctLevel: QRCode.CorrectLevel.L,
    });
  }

  return chunks.length;
}

// ---------------------------------------------------------------------------
// Reassembly
// ---------------------------------------------------------------------------

/**
 * Attempt to reassemble a payload from a map of received chunks.
 *
 * @param {Map<number, string>} receivedChunks  — 1-based index → payload slice
 * @param {number} totalChunks
 * @returns {string|null} reassembled payload, or null if not yet complete
 */
export function reassembleChunks(receivedChunks, totalChunks) {
  if (receivedChunks.size < totalChunks) return null;
  let result = '';
  for (let i = 1; i <= totalChunks; i++) {
    if (!receivedChunks.has(i)) return null;
    result += receivedChunks.get(i);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

/** @type {MediaStream|null} Active camera stream (so we can stop it on cleanup). */
let _activeStream = null;

/**
 * Stop the active camera stream if one is open.
 */
export function stopScanner() {
  if (_activeStream) {
    _activeStream.getTracks().forEach(t => t.stop());
    _activeStream = null;
  }
}

/**
 * Start a camera stream on a <video> element.
 * Uses the rear-facing camera by default.
 *
 * @param {HTMLVideoElement} videoEl
 * @param {object} [constraints]
 * @returns {Promise<MediaStream>}
 */
async function startCamera(videoEl, constraints = {}) {
  stopScanner();

  const defaultConstraints = {
    video: {
      facingMode: { ideal: 'environment' },
      width:      { ideal: 1280 },
      height:     { ideal: 720 },
    },
    audio: false,
  };

  const merged = {
    ...defaultConstraints,
    video: { ...defaultConstraints.video, ...(constraints.video ?? {}) },
  };

  const stream = await navigator.mediaDevices.getUserMedia(merged);
  _activeStream = stream;
  videoEl.srcObject = stream;
  await videoEl.play();
  return stream;
}

/**
 * Scan frames from a video element using jsQR.
 * Calls `onFrame` with an array of decoded strings found in each frame.
 *
 * @param {HTMLVideoElement} videoEl
 * @param {(codes: string[]) => boolean} onFrame
 *   Called with decoded strings each frame.  Return true to stop scanning.
 * @returns {Promise<void>} resolves when onFrame returns true or scanning is cancelled.
 */
function scanFrames(videoEl, onFrame) {
  const canvas = document.createElement('canvas');
  const ctx    = canvas.getContext('2d', { willReadFrequently: true });

  return new Promise((resolve) => {
    let cancelled = false;

    function tick() {
      if (cancelled || videoEl.readyState < HTMLMediaElement.HAVE_ENOUGH_DATA) {
        if (!cancelled) requestAnimationFrame(tick);
        return;
      }

      canvas.width  = videoEl.videoWidth;
      canvas.height = videoEl.videoHeight;
      ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);

      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

      // Decode all QR codes visible in this frame.
      // jsQR decodes one code at a time; for multi-QR we would need a
      // different approach (ZXing or custom detection), but for the
      // single-scan mode jsQR is sufficient.
      // Multi-QR scanning (TASK-005) will scan one code per frame and
      // accumulate results — the grid QR codes are shown all at once so
      // the parent can move the camera to catch each one.
      const code = typeof jsQR !== 'undefined'
        ? jsQR(imageData.data, imageData.width, imageData.height, {
            inversionAttempts: 'dontInvert',
          })
        : null;

      const decoded = code ? [code.data] : [];

      if (onFrame(decoded)) {
        cancelled = true;
        resolve();
        return;
      }

      requestAnimationFrame(tick);
    }

    requestAnimationFrame(tick);

    // Expose a cancel method on the returned promise
    resolve._cancel = () => { cancelled = true; resolve(); };
  });
}

// ---------------------------------------------------------------------------
// Public scanning API
// ---------------------------------------------------------------------------

/**
 * Single-scan mode: open the camera, detect one QR code, return its data.
 * Stops the camera stream when done.
 *
 * @param {HTMLVideoElement} videoEl
 * @param {object} [options]
 * @param {(progress: string) => void} [options.onProgress]
 * @returns {Promise<string>} the decoded QR content
 */
export async function scanSingle(videoEl, options = {}) {
  const { onProgress } = options;

  if (typeof jsQR === 'undefined') {
    throw new Error('jsQR library not loaded');
  }

  onProgress?.('Opening camera…');
  await startCamera(videoEl);
  onProgress?.('Scanning — point at the QR code');

  return new Promise((resolve) => {
    scanFrames(videoEl, (codes) => {
      if (codes.length === 0) return false;
      const [first] = codes;
      // Ignore chunk headers — this mode expects a plain peer ID
      if (HEADER_RE.test(first)) return false;
      stopScanner();
      resolve(first);
      return true;
    });
  });
}

/**
 * Multi-scan mode: open the camera, collect all chunks from a QR grid,
 * reassemble and return the original payload.
 *
 * The scanner accumulates chunks across frames.  Individual chunk QR codes
 * may be scanned in any order; the caller is notified of progress via
 * `onProgress(scanned, total)`.
 *
 * @param {HTMLVideoElement} videoEl
 * @param {object} [options]
 * @param {(scanned: number, total: number|null) => void} [options.onProgress]
 * @returns {Promise<string>} the reassembled payload
 */
export async function scanMulti(videoEl, options = {}) {
  const { onProgress } = options;

  if (typeof jsQR === 'undefined') {
    throw new Error('jsQR library not loaded');
  }

  await startCamera(videoEl);

  /** @type {Map<number, string>} 1-based index → payload slice */
  const received = new Map();
  let totalChunks = null;

  return new Promise((resolve) => {
    scanFrames(videoEl, (codes) => {
      for (const data of codes) {
        const match = HEADER_RE.exec(data);
        if (!match) continue; // Not a chunk — skip

        const idx   = parseInt(match[1], 10);
        const total = parseInt(match[2], 10);
        const chunk = data.slice(match[0].length);

        if (totalChunks === null) totalChunks = total;
        if (!received.has(idx)) {
          received.set(idx, chunk);
          onProgress?.(received.size, totalChunks);
        }
      }

      if (totalChunks !== null) {
        const payload = reassembleChunks(received, totalChunks);
        if (payload !== null) {
          stopScanner();
          resolve(payload);
          return true;
        }
      }

      return false;
    });
  });
}

/**
 * Auto-detect scan mode based on the first decoded QR content.
 * If the first code matches a chunk header, switches to multi-scan.
 * Otherwise resolves immediately with the single code.
 *
 * @param {HTMLVideoElement} videoEl
 * @param {object} [options]
 * @param {(progress: string|[number, number|null]) => void} [options.onProgress]
 * @returns {Promise<string>}
 */
export async function scanAuto(videoEl, options = {}) {
  const { onProgress } = options;

  if (typeof jsQR === 'undefined') {
    throw new Error('jsQR library not loaded');
  }

  await startCamera(videoEl);
  onProgress?.('Scanning…');

  return new Promise((resolve) => {
    /** @type {Map<number, string>} */
    const received   = new Map();
    let totalChunks  = null;
    let mode         = null; // 'single' | 'multi' | null (unknown)

    scanFrames(videoEl, (codes) => {
      if (codes.length === 0) return false;

      for (const data of codes) {
        const match = HEADER_RE.exec(data);

        if (!match) {
          // Plain string — treat as single scan
          if (mode === null || mode === 'single') {
            mode = 'single';
            stopScanner();
            resolve(data);
            return true;
          }
          continue;
        }

        // Chunk header found — switch to multi-scan mode
        mode = 'multi';
        const idx   = parseInt(match[1], 10);
        const total = parseInt(match[2], 10);
        const chunk = data.slice(match[0].length);

        if (totalChunks === null) totalChunks = total;
        if (!received.has(idx)) {
          received.set(idx, chunk);
          onProgress?.([received.size, totalChunks]);
        }
      }

      if (mode === 'multi' && totalChunks !== null) {
        const payload = reassembleChunks(received, totalChunks);
        if (payload !== null) {
          stopScanner();
          resolve(payload);
          return true;
        }
      }

      return false;
    });
  });
}
