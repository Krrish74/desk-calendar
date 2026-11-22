// sheet.js: bottom sheets (event details, editor, quick add, assistant, settings)
// and the toast at the bottom ("Event deleted · Undo").
//
// A sheet slides up from the bottom over a dark scrim. Close it by tapping the
// scrim, the ✕ button, or dragging its handle / title bar down. Only one sheet is
// open at a time; opening another replaces it.
//
// THE KEYBOARD
// On iPhone the on-screen keyboard doesn't shrink the page; it slides over it. So
// we watch window.visualViewport (the part of the page you can actually see) and
// set --kb to the keyboard's height. Sheets sit at `bottom: var(--kb)`, so their
// inputs stay above the keyboard.

import { $, el, icon, button } from './util.js';

let current = null; // { node, onClose }

const scrim = () => $('scrim');

/**
 * Open a sheet.
 *   title      heading text (or a Node)
 *   body       content Node (scrolls)
 *   foot       optional Node pinned at the bottom (e.g. the chat input)
 *   full       true = full height (editor, assistant, settings); false = fits content
 *   actions    extra header buttons (Nodes), placed before ✕
 *   onClose    called after it closes (any way)
 * Returns { close, node, body }.
 */
export function openSheet({ title = '', body, foot, full = false, actions = [], onClose, className = '' }) {
  closeSheet(true);
  const node = el('section', `sheet ${full ? 'full' : ''} ${className}`.trim());
  node.setAttribute('role', 'dialog');
  node.setAttribute('aria-modal', 'true');
  const grab = el('div', 'sheet-grab');
  const head = el('div', 'sheet-head');
  const h = el('h2');
  if (title instanceof Node) h.append(title); else h.textContent = title;
  const close = button('icon', 'ico:dismiss', () => closeSheet());
  close.setAttribute('aria-label', 'Close');
  head.append(h, ...actions, close);
  const bodyWrap = el('div', 'sheet-body');
  if (body) bodyWrap.append(body);
  node.append(grab, head, bodyWrap);
  if (foot) { const f = el('div', 'sheet-foot'); f.append(foot); node.append(f); }
  document.body.append(node);

  scrim().hidden = false;
  // Read layout once so the browser registers the closed position, then add the class
  // that slides it in. (Waiting for an animation frame instead would never fire while
  // the page is in the background.)
  void node.offsetHeight;
  scrim().classList.add('show');
  node.classList.add('open');
  scrim().onclick = () => closeSheet();
  current = { node, onClose };
  dragToDismiss(node, [grab, head]);
  return { close: () => closeSheet(), node, body: bodyWrap };
}

/** Close the open sheet. `instant` skips the slide-down (used when swapping sheets). */
export function closeSheet(instant = false) {
  if (!current) return;
  const { node, onClose } = current;
  current = null;
  document.activeElement?.blur?.(); // drops the keyboard
  if (instant) {
    node.remove();
  } else {
    node.classList.remove('open');
    scrim().classList.remove('show');
    setTimeout(() => { node.remove(); if (!current) scrim().hidden = true; }, 260);
  }
  onClose?.();
}

export const sheetOpen = () => !!current;

/** Drag the handle / header down to dismiss (or flick it). */
function dragToDismiss(node, handles) {
  for (const h of handles) {
    h.addEventListener('pointerdown', (down) => {
      if (down.target.closest('button')) return;
      const y0 = down.clientY;
      const t0 = performance.now();
      let dy = 0;
      node.classList.add('dragging');
      h.setPointerCapture(down.pointerId);
      const move = (m) => { dy = Math.max(0, m.clientY - y0); node.style.transform = `translateY(${dy}px)`; };
      const up = () => {
        h.removeEventListener('pointermove', move);
        h.removeEventListener('pointerup', up);
        h.removeEventListener('pointercancel', up);
        node.classList.remove('dragging');
        node.style.transform = '';
        const fast = dy / (performance.now() - t0) > 0.6;
        if (dy > 110 || (fast && dy > 30)) closeSheet();
      };
      h.addEventListener('pointermove', move);
      h.addEventListener('pointerup', up);
      h.addEventListener('pointercancel', up);
    });
  }
}

// --- Keyboard height -----------------------------------------------------------------

if (window.visualViewport) {
  const vv = window.visualViewport;
  const update = () => {
    const kb = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
    document.documentElement.style.setProperty('--kb', `${kb}px`);
    current?.node.classList.toggle('kb-open', kb > 80);
    // iOS sometimes scrolls the whole page up when an input focuses; put it back.
    if (kb > 80 && window.scrollY) window.scrollTo(0, 0);
  };
  vv.addEventListener('resize', update);
  vv.addEventListener('scroll', update);
}

// --- Toast ------------------------------------------------------------------------------

let toastTimer;

/** A message at the bottom with an optional action ("Undo"). Disappears after `ms`. */
export function showToast(text, actionLabel, onAction, ms = 6000) {
  $('toast')?.remove();
  clearTimeout(toastTimer);
  const t = el('div', 'toast');
  t.id = 'toast';
  t.setAttribute('role', 'status');
  t.append(el('span', '', text));
  if (actionLabel) t.append(button('btn subtle', actionLabel, () => { t.remove(); onAction(); }));
  const x = button('icon', [icon('dismiss')], () => t.remove());
  x.setAttribute('aria-label', 'Dismiss');
  t.append(x);
  document.body.append(t);
  toastTimer = setTimeout(() => t.remove(), ms);
}
