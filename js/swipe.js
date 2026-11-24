/**
 * Lightweight, smooth 60fps horizontal swipe gesture controller for task cards.
 * - Swipe right -> next status
 * - Swipe left  -> previous status
 * - Axis-locked so vertical scrolling never stutters or triggers accidental swipes
 * - Soft rubber-band resistance when there is no next/previous status
 */

const AXIS_LOCK_PX = 10;
const TRIGGER_THRESHOLD_PX = 76;
const MAX_DRAG_PX = 148;
const EDGE_RESISTANCE = 0.24;

export function attachSwipeGesture(wrapperEl, options) {
  const {
    surfaceEl,
    leftActionEl,
    rightActionEl,
    canSwipeRight,
    canSwipeLeft,
    onSwipeRight,
    onSwipeLeft,
    onTap
  } = options;

  let pointerId = null;
  let startX = 0;
  let startY = 0;
  let currentX = 0;
  let axis = null; // 'x' | 'y' | null
  let thresholdCrossed = false;
  let moved = false;

  const resetVisuals = (animate = true) => {
    if (animate) {
      surfaceEl.classList.add('is-settling');
    } else {
      surfaceEl.classList.remove('is-settling');
    }
    surfaceEl.style.transform = 'translate3d(0, 0, 0)';
    wrapperEl.classList.remove('swiping-right', 'swiping-left', 'swipe-ready');
    if (leftActionEl) leftActionEl.style.opacity = '0';
    if (rightActionEl) rightActionEl.style.opacity = '0';
  };

  const triggerHaptic = () => {
    try {
      if (navigator.vibrate) navigator.vibrate(12);
    } catch {
      // Ignore on unsupported devices
    }
  };

  surfaceEl.addEventListener('pointerdown', (e) => {
    // Only primary mouse button or touch
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    // Don't hijack clicks on interactive buttons inside the card
    if (e.target.closest('button, a, input, select, textarea')) return;

    pointerId = e.pointerId;
    startX = e.clientX;
    startY = e.clientY;
    currentX = 0;
    axis = null;
    thresholdCrossed = false;
    moved = false;
    surfaceEl.classList.remove('is-settling');
  });

  surfaceEl.addEventListener('pointermove', (e) => {
    if (pointerId === null || e.pointerId !== pointerId) return;

    const dx = e.clientX - startX;
    const dy = e.clientY - startY;

    if (!axis) {
      if (Math.abs(dx) < AXIS_LOCK_PX && Math.abs(dy) < AXIS_LOCK_PX) {
        return;
      }
      if (Math.abs(dx) > Math.abs(dy) * 1.15) {
        axis = 'x';
        moved = true;
        try {
          surfaceEl.setPointerCapture(pointerId);
        } catch {
          // Ignore
        }
      } else {
        axis = 'y';
        pointerId = null;
        return;
      }
    }

    if (axis !== 'x') return;

    e.preventDefault();

    const goingRight = dx > 0;
    const allowed = goingRight ? canSwipeRight : canSwipeLeft;

    let offset;
    if (allowed) {
      // Slight damping past max drag
      const absDx = Math.abs(dx);
      const damped = absDx <= MAX_DRAG_PX ? absDx : MAX_DRAG_PX + (absDx - MAX_DRAG_PX) * 0.2;
      offset = goingRight ? damped : -damped;
    } else {
      offset = dx * EDGE_RESISTANCE;
    }

    currentX = offset;
    surfaceEl.style.transform = `translate3d(${offset.toFixed(1)}px, 0, 0)`;

    const progress = Math.min(1, Math.abs(offset) / TRIGGER_THRESHOLD_PX);
    wrapperEl.classList.toggle('swiping-right', goingRight && allowed);
    wrapperEl.classList.toggle('swiping-left', !goingRight && allowed);

    if (leftActionEl) {
      leftActionEl.style.opacity = goingRight && allowed ? String(Math.min(1, progress * 1.15)) : '0';
    }
    if (rightActionEl) {
      rightActionEl.style.opacity = !goingRight && allowed ? String(Math.min(1, progress * 1.15)) : '0';
    }

    const isReady = allowed && Math.abs(offset) >= TRIGGER_THRESHOLD_PX;
    if (isReady !== thresholdCrossed) {
      thresholdCrossed = isReady;
      wrapperEl.classList.toggle('swipe-ready', isReady);
      if (isReady) triggerHaptic();
    }
  });

  const finishGesture = (e, cancelled = false) => {
    if (pointerId === null || (e && e.pointerId !== pointerId)) return;

    const wasAxisX = axis === 'x';
    const finalX = currentX;
    const wasMoved = moved;

    pointerId = null;
    axis = null;

    if (!wasAxisX) {
      if (!cancelled && !wasMoved && onTap) {
        onTap();
      }
      return;
    }

    if (!cancelled && finalX >= TRIGGER_THRESHOLD_PX && canSwipeRight) {
      surfaceEl.classList.add('is-settling');
      surfaceEl.style.transform = 'translate3d(28%, 0, 0)';
      setTimeout(() => {
        resetVisuals(true);
        onSwipeRight?.();
      }, 110);
      return;
    }

    if (!cancelled && finalX <= -TRIGGER_THRESHOLD_PX && canSwipeLeft) {
      surfaceEl.classList.add('is-settling');
      surfaceEl.style.transform = 'translate3d(-28%, 0, 0)';
      setTimeout(() => {
        resetVisuals(true);
        onSwipeLeft?.();
      }, 110);
      return;
    }

    resetVisuals(true);
  };

  surfaceEl.addEventListener('pointerup', (e) => finishGesture(e, false));
  surfaceEl.addEventListener('pointercancel', (e) => finishGesture(e, true));
}
