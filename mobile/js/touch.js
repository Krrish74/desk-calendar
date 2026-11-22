// touch.js: long-press, then drag. Used to move events in Day / 3-day and Month.
//
// WHY LONG-PRESS
// On a phone a plain drag means "scroll". So, like Google Calendar on iPhone, you
// press and hold an event for about half a second; it lifts, and from then on your
// finger moves the event instead of scrolling. Moving your finger before then is a
// normal scroll, and a quick tap still opens the event.
//
// HOW (touch): touchstart starts a timer. If the finger moves more than a few pixels
// first, the timer is cancelled (it's a scroll). When the timer fires we're in drag
// mode: touchmove calls preventDefault() so the page doesn't scroll, and the
// session's move()/end() get the finger position.
// A mouse (testing on a computer) works the same way with press-and-hold.

const HOLD_MS = 450;
const SLOP_PX = 8;

let swallowClick = false;
document.addEventListener('click', (e) => {
  if (swallowClick) { e.stopPropagation(); e.preventDefault(); swallowClick = false; }
}, true);

/**
 * Watch `container` for long-presses.
 *   begin({ target, x, y }) → a session { move({x, y}), end({x, y}), cancel() } or null
 *     to ignore this press. `target` is the element pressed.
 */
export function onLongPress(container, begin) {
  // --- Touch -----------------------------------------------------------------------
  container.addEventListener('touchstart', (start) => {
    if (start.touches.length !== 1) return;
    const t0 = start.touches[0];
    const origin = { x: t0.clientX, y: t0.clientY, target: start.target };
    let last = { x: origin.x, y: origin.y };
    let session = null;
    let timer = setTimeout(() => {
      timer = null;
      session = begin(origin);
      if (session) {
        document.body.classList.add('dragging');
        navigator.vibrate?.(10); // a little buzz where supported (not on iPhone)
      }
    }, HOLD_MS);

    const move = (e) => {
      const t = e.touches[0];
      last = { x: t.clientX, y: t.clientY };
      if (session) { e.preventDefault(); session.move(last); return; }
      if (timer && Math.hypot(last.x - origin.x, last.y - origin.y) > SLOP_PX) { clearTimeout(timer); timer = null; finish(); }
    };
    const end = (e) => {
      if (timer) clearTimeout(timer);
      if (session) {
        e.preventDefault(); // no click after a drag
        swallowClick = true;
        setTimeout(() => { swallowClick = false; }, 400);
        if (e.type === 'touchcancel') session.cancel(); else session.end(last);
      }
      finish();
    };
    const finish = () => {
      document.body.classList.remove('dragging');
      container.removeEventListener('touchmove', move);
      container.removeEventListener('touchend', end);
      container.removeEventListener('touchcancel', end);
    };
    container.addEventListener('touchmove', move, { passive: false });
    container.addEventListener('touchend', end);
    container.addEventListener('touchcancel', end);
  }, { passive: true });

  // --- Mouse (press and hold) ------------------------------------------------------------
  container.addEventListener('pointerdown', (down) => {
    if (down.pointerType !== 'mouse' || down.button !== 0) return;
    const origin = { x: down.clientX, y: down.clientY, target: down.target };
    let last = { x: origin.x, y: origin.y };
    let session = null;
    let timer = setTimeout(() => {
      timer = null;
      session = begin(origin);
      if (session) document.body.classList.add('dragging');
    }, HOLD_MS);
    const move = (m) => {
      last = { x: m.clientX, y: m.clientY };
      if (session) { m.preventDefault(); session.move(last); return; }
      if (timer && Math.hypot(last.x - origin.x, last.y - origin.y) > SLOP_PX) { clearTimeout(timer); timer = null; }
    };
    const up = () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove('dragging');
      if (session) {
        swallowClick = true;
        setTimeout(() => { swallowClick = false; }, 400);
        session.end(last);
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
}

/**
 * Scroll `scroller` while the finger is near its top or bottom edge during a drag.
 * Returns { update(y), stop() }; onScroll(dy) is called after each scroll step.
 */
export function edgeScroller(scroller, onScroll) {
  let y = null;
  let raf = 0;
  const tick = () => {
    raf = 0;
    if (y === null) return;
    const r = scroller.getBoundingClientRect();
    const edge = 48;
    const speed = y < r.top + edge ? -(r.top + edge - y) / 4 : y > r.bottom - edge ? (y - (r.bottom - edge)) / 4 : 0;
    if (speed) {
      const before = scroller.scrollTop;
      scroller.scrollTop += Math.max(-14, Math.min(14, speed));
      if (scroller.scrollTop !== before) onScroll(scroller.scrollTop - before);
      raf = requestAnimationFrame(tick);
    }
  };
  return {
    update(newY) { y = newY; if (!raf) raf = requestAnimationFrame(tick); },
    stop() { y = null; cancelAnimationFrame(raf); raf = 0; },
  };
}
