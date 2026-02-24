/**
 * safe-sleep.js — Safe sleep information screen (TASK-044)
 *
 * Renders NHS and Lullaby Trust safer sleep guidance and manages the
 * mandatory first-run acknowledgement used in the onboarding flow (TASK-031).
 *
 * Public API:
 *   renderSafeSleepContent(containerEl, options?)
 *   isSafeSleepAcknowledged()
 */

import { lsGet, lsSet, SETTING_KEYS } from './storage.js';

// ---------------------------------------------------------------------------
// Acknowledgement helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if the user has previously acknowledged the safe sleep guidance.
 * @returns {boolean}
 */
export function isSafeSleepAcknowledged() {
  return lsGet(SETTING_KEYS.SAFE_SLEEP_ACK, false) === true;
}

/**
 * Record that the user has acknowledged the safe sleep guidance.
 */
function recordAcknowledgement() {
  lsSet(SETTING_KEYS.SAFE_SLEEP_ACK, true);
}

// ---------------------------------------------------------------------------
// Content rendering
// ---------------------------------------------------------------------------

/**
 * Render the full safe sleep guidance into a container element.
 *
 * @param {HTMLElement} containerEl
 *   The element to inject content into. Existing content beyond the
 *   back-button is preserved (i.e. the function is idempotent — calling it
 *   a second time on the same container is a no-op).
 *
 * @param {object}   [options]
 * @param {boolean}  [options.requireAck=false]
 *   When true, show a mandatory acknowledgement checkbox and confirm button.
 *   Intended for use in the first-run onboarding flow (TASK-031).
 * @param {Function} [options.onAcknowledged]
 *   Callback invoked (with no arguments) after the user confirms the ack.
 *   Only used when requireAck is true.
 */
export function renderSafeSleepContent(containerEl, options = {}) {
  if (!containerEl) return;

  // Idempotency guard: skip if content already injected
  if (containerEl.querySelector('.safe-sleep-content')) return;

  const { requireAck = false, onAcknowledged } = options;

  containerEl.insertAdjacentHTML('beforeend', buildContentHtml(requireAck));

  if (requireAck) {
    wireAcknowledgementUi(containerEl, onAcknowledged);
  }
}

// ---------------------------------------------------------------------------
// HTML builder
// ---------------------------------------------------------------------------

function buildContentHtml(requireAck) {
  const alreadyAcked = isSafeSleepAcknowledged();

  return `
<article class="safe-sleep-content" aria-labelledby="safe-sleep-heading">

  <h2 id="safe-sleep-heading" class="safe-sleep-content__title">Safer Sleep Guide</h2>
  <p class="safe-sleep-content__intro">
    The guidance below is drawn from NHS and Lullaby Trust recommendations on
    reducing the risk of sudden infant death syndrome (SIDS, sometimes called
    cot death). Follow these practices for every sleep, day and night.
  </p>

  <!-- Device placement notice — app-specific, must be prominent -->
  <div class="safe-sleep-notice" role="note" aria-label="Important device placement notice">
    <h3 class="safe-sleep-notice__heading">⚠ Device Placement</h3>
    <p>
      The monitor device must <strong>never</strong> be placed inside the cot
      or Moses basket. Position it on a stable surface outside the sleeping
      space entirely, where the camera can observe the baby without any risk
      of the device falling into the sleeping area.
    </p>
  </div>

  <!-- When these guidelines apply -->
  <section class="safe-sleep-section" aria-labelledby="ssh-when">
    <h3 id="ssh-when" class="safe-sleep-section__heading">When these guidelines apply</h3>
    <p>
      Follow these safer sleep practices for <strong>every sleep, day and
      night, until your baby is 12 months old</strong>. For premature or
      low-birthweight babies, continue until 12 months after their due date.
    </p>
    <p class="safe-sleep-source">Source: Lullaby Trust</p>
  </section>

  <!-- Six core recommendations -->
  <section class="safe-sleep-section" aria-labelledby="ssh-six">
    <h3 id="ssh-six" class="safe-sleep-section__heading">The six core safer sleep recommendations</h3>
    <ol class="safe-sleep-list safe-sleep-list--numbered">
      <li>Always lie your baby on their back to sleep.</li>
      <li>Keep their cot clear.</li>
      <li>Use a firm, flat, waterproof mattress.</li>
      <li>Keep baby smoke-free before and after birth.</li>
      <li>Avoid your baby getting too hot.</li>
      <li>Sleep your baby in the same room as you for at least the first six months.</li>
    </ol>
    <p class="safe-sleep-source">Source: Lullaby Trust</p>
  </section>

  <!-- Sleeping position and location -->
  <section class="safe-sleep-section" aria-labelledby="ssh-position">
    <h3 id="ssh-position" class="safe-sleep-section__heading">Sleeping position and location</h3>
    <ul class="safe-sleep-list">
      <li>
        The safest place for a baby to sleep for the first 6 months is in a
        cot or Moses basket, lying on their back, in the same room as a parent.
      </li>
      <li>
        Always put baby to sleep on their back. Babies who are normally slept
        on their backs but are sometimes placed on their fronts are at
        higher risk of SIDS.
      </li>
      <li>
        Room-sharing for at least six months does not mean you cannot leave the
        room briefly, but the baby is safest when you are close by most of the
        time.
      </li>
      <li>
        It is lovely to have your baby with you for a cuddle or a feed, but it
        is safest to put them back in their cot before you go to sleep.
      </li>
    </ul>
    <p class="safe-sleep-source">Source: NHS, Lullaby Trust</p>
  </section>

  <!-- Sleeping space — what to remove -->
  <section class="safe-sleep-section" aria-labelledby="ssh-space">
    <h3 id="ssh-space" class="safe-sleep-section__heading">Sleeping space — what to remove</h3>
    <p>
      Use a cot or Moses basket. Ensure there are no items that could cover the
      baby's mouth or nose, or cause overheating.
    </p>
    <p><strong>Do not use:</strong></p>
    <ul class="safe-sleep-list">
      <li>Cot bumpers, pillows, or duvets</li>
      <li>Loose bedding or soft toys</li>
      <li>Weighted or bulky bedding</li>
      <li>Position-retention products (wedges, straps)</li>
      <li>Sleeping pods, nests, or rolled towels</li>
      <li>Any soft items on or near the mattress</li>
    </ul>
    <p>
      Sleeping pods or nests are not advised as they have raised or cushioned
      areas. Soft items near the baby's head can cause overheating and increase
      the risk of SIDS.
    </p>
    <p class="safe-sleep-source">Source: NHS, Lullaby Trust</p>
  </section>

  <!-- Mattress -->
  <section class="safe-sleep-section" aria-labelledby="ssh-mattress">
    <h3 id="ssh-mattress" class="safe-sleep-section__heading">Mattress</h3>
    <ul class="safe-sleep-list">
      <li>The mattress must be firm, flat, and waterproof.</li>
      <li>
        Buy a new mattress where possible. A mattress from your own home may be
        reused if stored somewhere clean, dry, and smoke-free.
      </li>
      <li>
        Check firmness: the baby's head should not sink more than a few
        millimetres. A mattress that is not firm enough makes it harder for the
        baby to lose heat, increasing the risk of overheating.
      </li>
    </ul>
    <p class="safe-sleep-source">Source: NHS, Lullaby Trust</p>
  </section>

  <!-- Room temperature -->
  <section class="safe-sleep-section" aria-labelledby="ssh-temp">
    <h3 id="ssh-temp" class="safe-sleep-section__heading">Room temperature</h3>
    <ul class="safe-sleep-list">
      <li>Keep the room temperature between <strong>16°C and 20°C</strong>.</li>
      <li>
        Use a room thermometer to monitor temperature. Overheating is associated
        with higher SIDS risk.
      </li>
    </ul>
    <p class="safe-sleep-source">Source: Lullaby Trust</p>
  </section>

  <!-- Sleeping bags -->
  <section class="safe-sleep-section" aria-labelledby="ssh-bags">
    <h3 id="ssh-bags" class="safe-sleep-section__heading">Sleeping bags</h3>
    <ul class="safe-sleep-list">
      <li>
        Baby sleeping bags reduce the risk of SIDS by preventing babies from
        wriggling under bedding.
      </li>
      <li>
        Ensure the bag fits well around the shoulders so there is no risk of
        the baby's head slipping inside.
      </li>
      <li>
        Match the tog rating to room temperature:
        <strong>2.5 tog</strong> (16–20°C) ·
        <strong>1.0 tog</strong> (20–24°C) ·
        <strong>0.5 tog</strong> (24–27°C).
      </li>
      <li>No other bedding is needed when using a sleeping bag.</li>
    </ul>
    <p class="safe-sleep-source">Source: NHS</p>
  </section>

  <!-- Blankets -->
  <section class="safe-sleep-section" aria-labelledby="ssh-blankets">
    <h3 id="ssh-blankets" class="safe-sleep-section__heading">Blankets (if not using a sleeping bag)</h3>
    <ul class="safe-sleep-list">
      <li>
        Lie baby on their back with their feet nearest the foot of the cot to
        prevent loose bedding covering their face.
      </li>
      <li>
        A cellular cotton blanket is best — it keeps baby warm while allowing
        airflow.
      </li>
      <li>
        Tuck the blanket in firmly, no higher than the shoulders, and do not
        double it over.
      </li>
    </ul>
    <p class="safe-sleep-source">Source: NHS</p>
  </section>

  <!-- Smoke exposure -->
  <section class="safe-sleep-section" aria-labelledby="ssh-smoke">
    <h3 id="ssh-smoke" class="safe-sleep-section__heading">Smoke exposure</h3>
    <ul class="safe-sleep-list">
      <li>
        The risk of SIDS is much higher if you or your partner smoke during
        pregnancy or after the baby is born.
      </li>
      <li>Keep baby smoke-free at all times, in all environments.</li>
    </ul>
    <p class="safe-sleep-source">Source: NHS, Lullaby Trust</p>
  </section>

  <!-- Breastfeeding -->
  <section class="safe-sleep-section" aria-labelledby="ssh-bf">
    <h3 id="ssh-bf" class="safe-sleep-section__heading">Breastfeeding</h3>
    <p>Breastfeeding is associated with a reduced risk of SIDS.</p>
    <p class="safe-sleep-source">Source: Lullaby Trust</p>
  </section>

  <!-- Co-sleeping — when not safe -->
  <section class="safe-sleep-section" aria-labelledby="ssh-co-no">
    <h3 id="ssh-co-no" class="safe-sleep-section__heading">Co-sleeping — when it is not safe</h3>
    <ul class="safe-sleep-list">
      <li>
        Never co-sleep if you are extremely tired, or if the baby has a fever
        or signs of illness.
      </li>
      <li>
        Do not co-sleep if the baby was born prematurely (before 37 weeks) or
        had a low birthweight (under 2.5 kg / 5.5 lb).
      </li>
      <li>
        Falling asleep on a sofa or armchair with a baby substantially
        increases the risk of SIDS.
      </li>
    </ul>
    <p class="safe-sleep-source">Source: NHS</p>
  </section>

  <!-- Co-sleeping — if you do share a bed -->
  <section class="safe-sleep-section" aria-labelledby="ssh-co-bed">
    <h3 id="ssh-co-bed" class="safe-sleep-section__heading">Co-sleeping — if you do share a bed</h3>
    <ul class="safe-sleep-list">
      <li>
        Co-sleeping is not safe if you or your partner have been: smoking,
        drinking alcohol, taking recreational drugs, or taking any medication
        that causes drowsiness.
      </li>
      <li>
        Make sure the baby cannot fall out of bed or become trapped between the
        mattress and a wall.
      </li>
      <li>
        Keep pillows, sheets, and blankets away from the baby — a sleeping bag
        is safer.
      </li>
      <li>Do not let other children or pets in the bed at the same time.</li>
      <li>Always put baby to sleep on their back.</li>
    </ul>
    <p class="safe-sleep-source">Source: NHS</p>
  </section>

  <!-- Acknowledgement (onboarding only) -->
  ${requireAck ? `
  <div class="safe-sleep-ack" id="safe-sleep-ack-block">
    <label class="safe-sleep-ack__label">
      <input type="checkbox" id="safe-sleep-ack-check" class="safe-sleep-ack__checkbox"
             aria-required="true"
             ${alreadyAcked ? 'checked' : ''}
             aria-describedby="safe-sleep-ack-hint" />
      <span class="safe-sleep-ack__text">
        I have read and understood the safer sleep guidance above.
      </span>
    </label>
    <p id="safe-sleep-ack-hint" class="safe-sleep-ack__hint">
      You must confirm this before continuing to device set-up.
    </p>
    <button id="safe-sleep-ack-btn" class="action-btn safe-sleep-ack__btn"
            ${alreadyAcked ? '' : 'disabled'}
            aria-disabled="${alreadyAcked ? 'false' : 'true'}">
      Confirm and continue
    </button>
  </div>
  ` : ''}

  <!-- Attribution -->
  <footer class="safe-sleep-attribution" aria-label="Sources">
    <p class="safe-sleep-attribution__heading">Sources</p>
    <ul class="safe-sleep-attribution__list">
      <li>
        <a href="https://www.nhs.uk/conditions/baby/caring-for-a-newborn/reduce-the-risk-of-sudden-infant-death-syndrome/"
           target="_blank" rel="noopener noreferrer"
           class="safe-sleep-attribution__link">
          NHS — Reduce the risk of sudden infant death syndrome (SIDS)
        </a>
      </li>
      <li>
        <a href="https://www.lullabytrust.org.uk/safer-sleep-advice/"
           target="_blank" rel="noopener noreferrer"
           class="safe-sleep-attribution__link">
          The Lullaby Trust — Safer Sleep Advice
        </a>
      </li>
    </ul>
    <p class="safe-sleep-attribution__note">
      Always follow the most current guidance from the NHS and Lullaby Trust.
    </p>
  </footer>

</article>
  `.trim();
}

// ---------------------------------------------------------------------------
// Acknowledgement UI wiring
// ---------------------------------------------------------------------------

/**
 * Wire up the checkbox + confirm button for the mandatory ack UI.
 * @param {HTMLElement} containerEl
 * @param {Function|undefined} onAcknowledged
 */
function wireAcknowledgementUi(containerEl, onAcknowledged) {
  const checkbox  = containerEl.querySelector('#safe-sleep-ack-check');
  const confirmBtn = containerEl.querySelector('#safe-sleep-ack-btn');

  if (!checkbox || !confirmBtn) return;

  checkbox.addEventListener('change', () => {
    const checked = checkbox.checked;
    confirmBtn.disabled = !checked;
    confirmBtn.setAttribute('aria-disabled', checked ? 'false' : 'true');
  });

  confirmBtn.addEventListener('click', () => {
    if (!checkbox.checked) return;
    recordAcknowledgement();
    if (typeof onAcknowledged === 'function') {
      onAcknowledged();
    }
  });
}
