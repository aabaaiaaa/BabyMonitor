/**
 * browser-compat.js — Browser compatibility detection and UI (TASK-045)
 *
 * Detects iOS Safari and other non-Chrome browsers on page load.
 *
 *   - iOS Safari: fullscreen blocking modal — the app cannot proceed.
 *   - Other non-Chrome (Firefox, Opera, …): dismissible soft warning banner.
 *   - Chromium-based (Chrome desktop/Android, Chrome on iOS): no warning.
 *
 * Notes on Chrome on iOS (CriOS):
 *   Chrome on iOS is officially supported and classified as Chromium-based here.
 *   However, Apple's browser restrictions force all iOS browsers to use the
 *   WebKit rendering engine under the hood, which means the Wake Lock API
 *   is unavailable on iOS Chrome just as it is on iOS Safari. The graceful
 *   fallback implemented in TASK-003 handles this automatically; no extra
 *   action is required here.
 *
 * Usage — call showCompatWarnings() as early as possible in each page module,
 * before any app initialisation runs:
 *
 *   import { showCompatWarnings } from './browser-compat.js';
 *   const compatResult = showCompatWarnings(); // 'blocked' | 'warned' | 'ok'
 *   if (compatResult === 'blocked') { ... skip init ... }
 */

// ---------------------------------------------------------------------------
// Detection helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if the browser is iOS Safari (not Chrome on iOS).
 * Matches iPhone/iPad/iPod user agents that do not carry the CriOS token.
 * @returns {boolean}
 */
export function isIosSafari() {
  const ua = navigator.userAgent;
  return /iP(hone|ad|od)/.test(ua) && !/CriOS/.test(ua);
}

/**
 * Returns true if the browser appears to be Chromium-based.
 * Matches desktop Chrome, Chrome on Android, Chrome on iOS (CriOS), and
 * other Chromium derivatives that identify themselves as Chrome.
 * @returns {boolean}
 */
export function isChromiumBased() {
  const ua = navigator.userAgent;
  return /Chrome/.test(ua) || /CriOS/.test(ua);
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run compatibility checks and update the page UI accordingly.
 *
 * Expected optional DOM elements (missing elements are silently skipped):
 *   #compat-modal          — fullscreen blocking modal (iOS Safari)
 *   #compat-modal-message  — message paragraph inside the modal
 *   #compat-modal-url      — paragraph that displays the copyable URL
 *   #compat-copy-btn       — button that copies the URL to clipboard
 *   #compat-banner         — soft warning banner (non-Chrome browsers)
 *   #compat-banner-dismiss — button to dismiss the soft banner
 *
 * @returns {'blocked' | 'warned' | 'ok'}
 */
export function showCompatWarnings() {
  if (isIosSafari()) {
    _showBlockingModal();
    return 'blocked';
  }

  if (!isChromiumBased()) {
    _showSoftBanner();
    return 'warned';
  }

  return 'ok';
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function _showBlockingModal() {
  const modal   = document.getElementById('compat-modal');
  const msg     = document.getElementById('compat-modal-message');
  const urlEl   = document.getElementById('compat-modal-url');
  const copyBtn = document.getElementById('compat-copy-btn');
  const tapOverlay = document.getElementById('tap-overlay');

  // Hide the tap-to-begin overlay so the modal is the only thing visible
  if (tapOverlay) tapOverlay.classList.add('hidden');

  if (msg) {
    msg.textContent =
      'This app requires Chrome to function. ' +
      'Please open this page in Chrome on your iPhone or iPad.';
  }

  if (urlEl) {
    urlEl.textContent = window.location.href;
  }

  if (copyBtn) {
    copyBtn.addEventListener('click', () => {
      const url = window.location.href;
      if (navigator.clipboard) {
        navigator.clipboard.writeText(url)
          .then(() => {
            const original = copyBtn.textContent;
            copyBtn.textContent = 'Copied!';
            setTimeout(() => { copyBtn.textContent = original; }, 2000);
          })
          .catch(() => _selectText(urlEl));
      } else {
        // Clipboard API unavailable — fall back to text selection
        _selectText(urlEl);
      }
    });
  }

  if (modal) modal.classList.remove('hidden');
}

function _showSoftBanner() {
  const banner  = document.getElementById('compat-banner');
  if (!banner) return;
  banner.classList.remove('hidden');

  const dismiss = document.getElementById('compat-banner-dismiss');
  dismiss?.addEventListener('click', () => {
    banner.classList.add('hidden');
  }, { once: true });
}

/** Select all text inside an element so the user can copy it manually. */
function _selectText(el) {
  if (!el) return;
  try {
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    if (sel) {
      sel.removeAllRanges();
      sel.addRange(range);
    }
  } catch {
    // Selection API unavailable — do nothing
  }
}
