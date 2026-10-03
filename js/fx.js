// Small motion helpers: ripples, pops, particle bursts and exit animations.

const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
export const motionOK = () => !reduced.matches;

/** Material-style ripple from the pointer position inside `el`. */
export function ripple(el, event) {
  if (!motionOK()) return;
  const r = el.getBoundingClientRect();
  const size = Math.max(r.width, r.height) * 2.2;
  const x = (event && event.clientX ? event.clientX : r.left + r.width / 2) - r.left;
  const y = (event && event.clientY ? event.clientY : r.top + r.height / 2) - r.top;
  const dot = document.createElement('span');
  dot.className = 'ripple';
  // Positioned inline so it can never take up space in the button's layout,
  // even if the stylesheet hasn't loaded yet.
  Object.assign(dot.style, {
    position: 'absolute',
    pointerEvents: 'none',
    width: `${size}px`,
    height: `${size}px`,
    left: `${x - size / 2}px`,
    top: `${y - size / 2}px`,
  });
  el.appendChild(dot);
  const remove = () => dot.remove();
  dot.addEventListener('animationend', remove, { once: true });
  setTimeout(remove, 1000);
}

/** Springy scale "pop" on an element. */
export function pop(el, scale = 1.12) {
  if (!el || !motionOK() || !el.animate) return;
  el.animate(
    [
      { transform: 'scale(1)' },
      { transform: `scale(${scale})`, offset: 0.35 },
      { transform: `scale(${1 - (scale - 1) * 0.35})`, offset: 0.65 },
      { transform: 'scale(1)' },
    ],
    { duration: 420, easing: 'cubic-bezier(.3,.7,.4,1)' },
  );
}

/** Small shake, for "can't do that". */
export function nudge(el) {
  if (!el || !motionOK() || !el.animate) return;
  el.animate(
    [
      { transform: 'translateX(0)' },
      { transform: 'translateX(-6px)' },
      { transform: 'translateX(5px)' },
      { transform: 'translateX(-3px)' },
      { transform: 'translateX(0)' },
    ],
    { duration: 320, easing: 'ease-out' },
  );
}

function centerOf(source) {
  if (source && typeof source.getBoundingClientRect === 'function') {
    const r = source.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }
  return source || { x: window.innerWidth / 2, y: window.innerHeight / 2 };
}

/**
 * Particle burst from an element or {x, y} point.
 * opts: count, spread (px), colors, size, gravity, shapes
 */
export function burst(source, opts = {}) {
  if (!motionOK()) return;
  const { x, y } = centerOf(source);
  const count = opts.count ?? 14;
  const spread = opts.spread ?? 60;
  const gravity = opts.gravity ?? 30;
  const size = opts.size ?? 7;
  const colors = opts.colors ?? [getComputedStyle(document.body).getPropertyValue('--accent').trim() || '#e4643f'];
  const layer = document.createElement('div');
  layer.className = 'fx-layer';
  layer.style.cssText = 'position:fixed;inset:0;z-index:9999;pointer-events:none;overflow:hidden';
  setTimeout(() => layer.remove(), 2500);
  document.body.appendChild(layer);
  let alive = count;

  for (let i = 0; i < count; i++) {
    const p = document.createElement('span');
    const shape = opts.confetti ? (i % 3 === 0 ? 'is-strip' : i % 3 === 1 ? 'is-dot' : 'is-square') : 'is-dot';
    p.className = `fx-particle ${shape}`;
    p.style.position = 'absolute';
    const s = size * (0.6 + Math.random() * 0.8);
    p.style.width = `${shape === 'is-strip' ? s * 0.5 : s}px`;
    p.style.height = `${shape === 'is-strip' ? s * 1.6 : s}px`;
    p.style.left = `${x}px`;
    p.style.top = `${y}px`;
    p.style.background = colors[i % colors.length];
    layer.appendChild(p);

    const angle = (Math.PI * 2 * i) / count + Math.random() * 0.6;
    const dist = spread * (0.55 + Math.random() * 0.6);
    const dx = Math.cos(angle) * dist;
    const dy = Math.sin(angle) * dist;
    const spin = (Math.random() - 0.5) * 720;
    const dur = 650 + Math.random() * 500;
    const anim = p.animate(
      [
        { transform: 'translate(-50%, -50%) scale(.3) rotate(0deg)', opacity: 1 },
        { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(1) rotate(${spin / 2}deg)`, opacity: 1, offset: 0.45 },
        { transform: `translate(calc(-50% + ${dx * 1.15}px), calc(-50% + ${dy + gravity}px)) scale(.4) rotate(${spin}deg)`, opacity: 0 },
      ],
      { duration: dur, easing: 'cubic-bezier(.15,.75,.3,1)', fill: 'forwards' },
    );
    anim.onfinish = () => {
      if (--alive === 0) layer.remove();
    };
  }
}

/** Big celebratory confetti from an element. */
export function celebrate(source) {
  const cs = getComputedStyle(document.body);
  const accent = cs.getPropertyValue('--accent').trim();
  burst(source, {
    count: 46,
    spread: 190,
    gravity: 120,
    size: 10,
    confetti: true,
    colors: [accent, '#ffc94d', '#7ad3c4', '#8e9bff', '#ff8fb1', '#ffffff'],
  });
}

/** Collapse + fade an element out, then resolve. */
export function exit(el) {
  if (!motionOK() || !el.animate) return Promise.resolve();
  const h = el.getBoundingClientRect().height;
  el.style.overflow = 'hidden';
  const anim = el.animate(
    [
      { opacity: 1, transform: 'translateX(0) scale(1)', height: `${h}px` },
      { opacity: 0, transform: 'translateX(24px) scale(.96)', height: `${h}px`, offset: 0.55 },
      { opacity: 0, transform: 'translateX(24px) scale(.96)', height: '0px', marginTop: '-6px', paddingTop: '0px', paddingBottom: '0px' },
    ],
    { duration: 380, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'forwards' },
  );
  return anim.finished.catch(() => {});
}

/** Spring the element in from below. */
export function enter(el) {
  if (!motionOK() || !el.animate) return;
  el.animate(
    [
      { opacity: 0, transform: 'translateY(14px) scale(.96)' },
      { opacity: 1, transform: 'translateY(-2px) scale(1.01)', offset: 0.6 },
      { opacity: 1, transform: 'translateY(0) scale(1)' },
    ],
    { duration: 460, easing: 'cubic-bezier(.2,.8,.2,1)' },
  );
}

/** Light haptic tap on phones that support it. */
export function haptic(ms = 8) {
  try { if (navigator.vibrate) navigator.vibrate(ms); } catch { /* not supported */ }
}
