// Ambient visual effects: watch-face ticks, cursor spotlight, 3D tilt
// and a glow that pulses with the ambient sound.

import * as audio from './audio.js?v=38';
import { motionOK } from './fx.js?v=38';

const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');
const SVG_NS = 'http://www.w3.org/2000/svg';

/** 60 watch-face ticks inside the dial. Returns update(fractionRemaining). */
export function makeTicks(svg) {
  const g = document.createElementNS(SVG_NS, 'g');
  g.setAttribute('class', 'ticks');
  const ticks = [];
  for (let i = 0; i < 60; i++) {
    const a = (i / 60) * Math.PI * 2;
    const major = i % 5 === 0;
    const r1 = major ? 83 : 86;
    const r2 = 89.5;
    const line = document.createElementNS(SVG_NS, 'line');
    line.setAttribute('x1', (110 + r1 * Math.cos(a)).toFixed(2));
    line.setAttribute('y1', (110 + r1 * Math.sin(a)).toFixed(2));
    line.setAttribute('x2', (110 + r2 * Math.cos(a)).toFixed(2));
    line.setAttribute('y2', (110 + r2 * Math.sin(a)).toFixed(2));
    line.setAttribute('class', major ? 'tick is-major' : 'tick');
    g.appendChild(line);
    ticks.push(line);
  }
  svg.insertBefore(g, svg.querySelector('.ring-track'));
  let lit = -1;
  return (fraction) => {
    const n = Math.ceil(fraction * 60);
    if (n === lit) return;
    lit = n;
    ticks.forEach((t, i) => t.classList.toggle('is-lit', i < n));
  };
}

/** A soft light that follows the cursor across any .card. */
export function initSpotlight() {
  if (!finePointer.matches) return;
  document.addEventListener(
    'pointermove',
    (e) => {
      const card = e.target.closest && e.target.closest('.card');
      if (!card) return;
      const r = card.getBoundingClientRect();
      card.style.setProperty('--spot-x', `${e.clientX - r.left}px`);
      card.style.setProperty('--spot-y', `${e.clientY - r.top}px`);
    },
    { passive: true },
  );
}

/** Tilt a card slightly towards the cursor. */
export function initTilt(card, maxDeg = 4) {
  if (!finePointer.matches) return;
  let raf = 0;
  let rect = null;
  const measure = () => {
    // offset* ignore transforms, so the tilt can't feed back into itself.
    const box = card.getBoundingClientRect();
    rect = { left: box.left + (box.width - card.offsetWidth) / 2, top: box.top + (box.height - card.offsetHeight) / 2, width: card.offsetWidth, height: card.offsetHeight };
  };
  card.addEventListener('pointerenter', measure);
  window.addEventListener('scroll', () => { rect = null; }, { passive: true });
  window.addEventListener('resize', () => { rect = null; });
  card.addEventListener('pointermove', (e) => {
    if (!motionOK()) return;
    if (!rect) measure();
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      const r = rect;
      const x = (e.clientX - r.left) / r.width - 0.5;
      const y = (e.clientY - r.top) / r.height - 0.5;
      card.style.setProperty('--tilt-x', `${(-y * maxDeg).toFixed(2)}deg`);
      card.style.setProperty('--tilt-y', `${(x * maxDeg * 1.2).toFixed(2)}deg`);
      card.classList.add('is-tilting');
    });
  });
  card.addEventListener('pointerleave', () => {
    cancelAnimationFrame(raf);
    card.style.setProperty('--tilt-x', '0deg');
    card.style.setProperty('--tilt-y', '0deg');
    card.classList.remove('is-tilting');
  });
}

/**
 * Drive a --level custom property from the ambient sound's loudness.
 * Returns wake(): call it when a sound starts. The loop stops by itself once
 * the sound is off and the glow has faded, so it costs nothing when silent.
 */
export function initAudioGlow(target) {
  let level = 0;
  let shown = -1;
  let running = false;
  const loop = () => {
    const raw = Math.min(1, audio.meter() * 5);
    level += (raw - level) * (raw > level ? 0.3 : 0.06);
    if (Math.abs(level - shown) > 0.004) {
      shown = level;
      target.style.setProperty('--level', level.toFixed(3));
    }
    if (raw === 0 && level < 0.004 && !audio.ambientPlaying()) {
      running = false;
      target.style.setProperty('--level', '0');
      shown = 0;
      return;
    }
    requestAnimationFrame(loop);
  };
  return function wake() {
    if (running) return;
    running = true;
    requestAnimationFrame(loop);
  };
}
