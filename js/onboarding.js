/**
 * onboarding.js — First-run onboarding wizard (TASK-031)
 *
 * Manages the guided setup flow shown the first time the app is opened.
 * Detected via the ONBOARDING_DONE flag in localStorage.
 *
 * The wizard runs in index.html and walks the user through:
 *   Step 1 — Role selection (baby monitor or parent monitor)
 *   Step 2 — Safe sleep guidance + mandatory acknowledgement
 *   Step 3 — Notification permission request
 *   Step 4 — Camera / microphone permission grant
 *
 * After step 4 the user is navigated to baby.html?onboarding=1 or
 * parent.html?onboarding=1 where the existing pairing wizard continues
 * the setup (steps 5–7: pairing, labelling, and dashboard tour).
 *
 * Public API:
 *   isOnboardingRequired()    — true on first run
 *   startOnboarding(wizardEl) — begin the wizard
 *   resetOnboarding()         — clear flags so wizard re-runs on next open
 */

import { lsGet, lsSet, SETTING_KEYS } from './storage.js';
import { renderSafeSleepContent } from './safe-sleep.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TOTAL_STEPS = 4;

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if the user has not yet completed first-run onboarding.
 * @returns {boolean}
 */
export function isOnboardingRequired() {
  return lsGet(SETTING_KEYS.ONBOARDING_DONE, false) !== true;
}

/**
 * Reset all onboarding-related flags so the wizard runs again on next open.
 * Called by the "Help / Re-run setup" button in settings.
 */
export function resetOnboarding() {
  lsSet(SETTING_KEYS.ONBOARDING_DONE, false);
  lsSet(SETTING_KEYS.SAFE_SLEEP_ACK, false);
  lsSet(SETTING_KEYS.NOTIF_PROMPTED, false);
}

// ---------------------------------------------------------------------------
// Wizard entry point
// ---------------------------------------------------------------------------

/**
 * Start the first-run onboarding wizard.
 *
 * @param {HTMLElement} wizardEl  — the #onboarding-wizard section element
 * @param {Function}    onSkip    — called if user taps "Skip setup" on step 1
 */
export function startOnboarding(wizardEl, onSkip) {
  if (!wizardEl) return;

  /** @type {'baby'|'parent'|null} */
  let selectedRole = null;

  // Show wizard
  wizardEl.classList.remove('hidden');

  // Render initial progress indicator
  _updateProgress(wizardEl, 1);

  // Wire step-1: baby role
  wizardEl.querySelector('#onboarding-btn-baby')?.addEventListener('click', () => {
    selectedRole = 'baby';
    _goToStep(wizardEl, 2);
    _loadSafeSleepStep(wizardEl, selectedRole);
  });

  // Wire step-1: parent role
  wizardEl.querySelector('#onboarding-btn-parent')?.addEventListener('click', () => {
    selectedRole = 'parent';
    _goToStep(wizardEl, 2);
    _loadSafeSleepStep(wizardEl, selectedRole);
  });

  // Wire "Skip setup" link — lets returning users bypass the wizard
  wizardEl.querySelector('#onboarding-skip-link')?.addEventListener('click', () => {
    wizardEl.classList.add('hidden');
    lsSet(SETTING_KEYS.ONBOARDING_DONE, true);
    if (typeof onSkip === 'function') onSkip();
  });
}

// ---------------------------------------------------------------------------
// Step navigation helpers
// ---------------------------------------------------------------------------

/**
 * Show the given step panel; hide all others; update the progress indicator.
 * @param {HTMLElement} wizardEl
 * @param {number} stepNum
 */
function _goToStep(wizardEl, stepNum) {
  wizardEl.querySelectorAll('.onboarding-step').forEach(el => {
    el.classList.add('hidden');
    el.setAttribute('aria-hidden', 'true');
  });

  const target = wizardEl.querySelector(`[data-step="${stepNum}"]`);
  if (target) {
    target.classList.remove('hidden');
    target.removeAttribute('aria-hidden');
  }

  _updateProgress(wizardEl, stepNum);
}

/**
 * Re-render the step-dot progress bar and update the aria-valuenow attribute.
 * @param {HTMLElement} wizardEl
 * @param {number} currentStep
 */
function _updateProgress(wizardEl, currentStep) {
  const indicator = wizardEl.querySelector('#onboarding-steps-indicator');
  if (!indicator) return;

  indicator.innerHTML = '';

  for (let i = 1; i <= TOTAL_STEPS; i++) {
    const dot = document.createElement('span');
    dot.className = 'onboarding-progress__dot';
    if (i < currentStep)  dot.classList.add('done');
    if (i === currentStep) dot.classList.add('active');
    const state = i === currentStep ? 'current' : i < currentStep ? 'complete' : 'upcoming';
    dot.setAttribute('aria-label', `Step ${i}: ${state}`);
    indicator.appendChild(dot);
  }

  const bar = wizardEl.querySelector('#onboarding-progress-bar');
  if (bar) {
    bar.setAttribute('aria-valuenow', String(currentStep));
  }

  const label = wizardEl.querySelector('#onboarding-progress-label');
  if (label) {
    label.textContent = `Step ${currentStep} of ${TOTAL_STEPS}`;
  }
}

// ---------------------------------------------------------------------------
// Step 2: Safe sleep guidance + mandatory acknowledgement
// ---------------------------------------------------------------------------

/**
 * Inject safe sleep content into the wizard step.
 * The onAcknowledged callback advances to step 3.
 * @param {HTMLElement} wizardEl
 * @param {'baby'|'parent'} role
 */
function _loadSafeSleepStep(wizardEl, role) {
  const container = wizardEl.querySelector('#onboarding-safe-sleep-container');
  if (!container) return;

  renderSafeSleepContent(container, {
    requireAck: true,
    onAcknowledged: () => {
      _goToStep(wizardEl, 3);
      _loadNotifStep(wizardEl, role);
    },
  });
}

// ---------------------------------------------------------------------------
// Step 3: Notification permission
// ---------------------------------------------------------------------------

/**
 * Prepare the notification step.
 * If notifications were already handled (previous session, or API absent),
 * skip directly to step 4.
 * @param {HTMLElement} wizardEl
 * @param {'baby'|'parent'} role
 */
function _loadNotifStep(wizardEl, role) {
  const alreadyHandled = lsGet(SETTING_KEYS.NOTIF_PROMPTED, false) === true;
  const apiAbsent      = !('Notification' in window);
  const nonDefault     = !apiAbsent && Notification.permission !== 'default';

  if (alreadyHandled || apiAbsent || nonDefault) {
    // Record current state if we haven't yet
    if (!alreadyHandled) {
      lsSet(SETTING_KEYS.NOTIF_PROMPTED, true);
      lsSet(SETTING_KEYS.NOTIF_GRANTED, !apiAbsent && Notification.permission === 'granted');
    }
    _goToStep(wizardEl, 4);
    _loadCameraStep(wizardEl, role);
    return;
  }

  _wireNotifButtons(wizardEl, role);
}

/**
 * Wire up the Enable / Skip / Continue buttons on the notification step.
 * @param {HTMLElement} wizardEl
 * @param {'baby'|'parent'} role
 */
function _wireNotifButtons(wizardEl, role) {
  const actionsEl   = wizardEl.querySelector('#onboarding-notif-actions');
  const enableBtn   = wizardEl.querySelector('#onboarding-notif-enable');
  const skipBtn     = wizardEl.querySelector('#onboarding-notif-skip');
  const deniedEl    = wizardEl.querySelector('#onboarding-notif-denied');
  const continueBtn = wizardEl.querySelector('#onboarding-notif-continue');

  const proceed = () => {
    _goToStep(wizardEl, 4);
    _loadCameraStep(wizardEl, role);
  };

  enableBtn?.addEventListener('click', async () => {
    if (enableBtn) enableBtn.disabled = true;

    const result = await Notification.requestPermission();
    lsSet(SETTING_KEYS.NOTIF_PROMPTED, true);
    lsSet(SETTING_KEYS.NOTIF_GRANTED, result === 'granted');

    if (result === 'granted') {
      proceed();
    } else {
      // Show the "notifications blocked" explanation before proceeding
      if (actionsEl) actionsEl.classList.add('hidden');
      if (deniedEl)  deniedEl.classList.remove('hidden');
    }
  }, { once: true });

  skipBtn?.addEventListener('click', () => {
    lsSet(SETTING_KEYS.NOTIF_PROMPTED, true);
    lsSet(SETTING_KEYS.NOTIF_GRANTED, false);
    proceed();
  }, { once: true });

  continueBtn?.addEventListener('click', proceed, { once: true });
}

// ---------------------------------------------------------------------------
// Step 4: Camera & microphone permissions
// ---------------------------------------------------------------------------

/**
 * Set up the camera/microphone permission step.
 * The description shown is tailored to the user's chosen role.
 * Granting permissions stops the acquired tracks immediately — we only need
 * the browser permission record, not the actual stream on index.html.
 * @param {HTMLElement} wizardEl
 * @param {'baby'|'parent'} role
 */
function _loadCameraStep(wizardEl, role) {
  const descEl   = wizardEl.querySelector('#onboarding-camera-desc');
  const grantBtn = wizardEl.querySelector('#onboarding-camera-grant-btn');
  const skipBtn  = wizardEl.querySelector('#onboarding-camera-skip-btn');
  const statusEl = wizardEl.querySelector('#onboarding-camera-status');

  if (descEl) {
    descEl.textContent = role === 'baby'
      ? 'The baby device needs camera and microphone access to stream video and audio to the parent device.'
      : 'The parent device needs microphone access so you can speak to your baby remotely using the speak-through feature. Camera access is optional on this device.';
  }

  /**
   * Save role, mark onboarding done, and navigate to the device page.
   * The ?onboarding=1 query param tells baby.html / parent.html to show
   * the onboarding hint banner and (for parent) the dashboard tour.
   */
  const proceed = () => {
    lsSet(SETTING_KEYS.DEVICE_ROLE, role);
    lsSet(SETTING_KEYS.ONBOARDING_DONE, true);
    window.location.href = role === 'baby'
      ? 'baby.html?onboarding=1'
      : 'parent.html?onboarding=1';
  };

  grantBtn?.addEventListener('click', async () => {
    if (statusEl) statusEl.textContent = 'Requesting permissions…';
    if (grantBtn) grantBtn.disabled = true;

    try {
      const constraints = role === 'baby'
        ? { video: true, audio: true }
        : { audio: true, video: false };

      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      // Stop all tracks immediately — the permission record is what we need
      stream.getTracks().forEach(t => t.stop());

      if (statusEl) statusEl.textContent = 'Access granted! Continuing…';
      // Brief pause so the user sees the confirmation before navigating
      setTimeout(proceed, 700);

    } catch (err) {
      if (grantBtn) grantBtn.disabled = false;

      if (statusEl) {
        statusEl.textContent = err.name === 'NotAllowedError'
          ? 'Permission denied. You can grant access later in your browser settings.'
          : `Could not access device: ${err.message}`;
      }

      // Make the skip button more visible after a denial
      if (skipBtn) {
        skipBtn.textContent = 'Continue without permissions';
        skipBtn.classList.add('action-btn', 'action-btn--secondary');
        skipBtn.classList.remove('text-btn');
      }
    }
  }, { once: true });

  skipBtn?.addEventListener('click', proceed);
}
