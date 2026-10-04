// Animated backgrounds that match the ambient sound: rain streaks, rolling
// waves, rising embers, fireflies under the stars, drifting dust in a breeze,
// hills rolling past a train window, motes in a reading lamp's light,
// sunbeams and birds in a forest, warm café lights and rising steam.
// One canvas behind the page; it only animates while a scene is showing.

import * as audio from './audio.js?v=73';
import { motionOK } from './fx.js?v=73';

const canvas = document.createElement('canvas');
canvas.className = 'scenery';
canvas.setAttribute('aria-hidden', 'true');
const g = canvas.getContext('2d');

let W = 0;
let H = 0;
let enabled = true;
let active = new Set();
const layers = new Map();
let raf = 0;
let last = 0;
let time = 0;
let colors = {};
let frameEMA = 1 / 60;
let lastTick = 0;
let halfRate = false;
let skip = false;

const rand = (a, b) => a + Math.random() * (b - a);

function hexLum(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 1;
  const n = parseInt(m[1], 16);
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
}

function readColors() {
  const cs = getComputedStyle(document.body);
  const v = (name) => cs.getPropertyValue(name).trim();
  const dark = hexLum(v('--bg')) < 0.35;
  colors = {
    dark,
    rain: dark ? '#b9c9e6' : '#55657e',
    accent: v('--accent'),
    waves: dark ? ['#1d6fa8', '#2a9df4', '#5ec8ff'] : ['#7cc4ff', '#4cc3ff', '#2a9df4'],
    star: dark ? '#fff8e8' : '#8c7d75',
    dust: dark ? '#f2e8e0' : '#7a6a62',
    hills: dark ? ['#3a4f66', '#2c3d50', '#1f2c3a'] : ['#b9cfdc', '#93b39c', '#6f9479'],
    pole: dark ? '#0f1720' : '#4c5a52',
  };
}

function sprite(inner, outer, size = 64) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const s = c.getContext('2d');
  const grd = s.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grd.addColorStop(0, inner);
  grd.addColorStop(0.25, inner);
  grd.addColorStop(0.45, outer);
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  s.fillStyle = grd;
  s.fillRect(0, 0, size, size);
  return c;
}

const EMBER = sprite('rgba(255,230,150,1)', 'rgba(255,110,20,0.35)');
const FIREFLY = sprite('rgba(240,255,170,1)', 'rgba(190,255,90,0.3)');

// ---------------------------------------------------------------------------
// Layers

const FACTORIES = {
  rain() {
    let drops = [];
    const make = (anywhere) => ({
      x: rand(-120, W + 40),
      y: anywhere ? rand(-40, H) : rand(-H * 0.3, -20),
      len: rand(10, 30),
      v: rand(650, 1150),
      wide: Math.random() < 0.12,
    });
    return {
      init() {
        drops = Array.from({ length: Math.round((W * H) / 8000) }, () => make(true));
      },
      draw(dt, a) {
        const wind = 0.14;
        g.lineCap = 'round';
        g.strokeStyle = colors.rain;
        for (const pass of [false, true]) {
          g.globalAlpha = a * (pass ? 0.4 : 0.26);
          g.lineWidth = pass ? 1.8 : 1.1;
          g.beginPath();
          for (const d of drops) {
            if (d.wide !== pass) continue;
            g.moveTo(d.x, d.y);
            g.lineTo(d.x - d.len * wind, d.y - d.len);
          }
          g.stroke();
        }
        for (const d of drops) {
          d.y += d.v * dt;
          d.x += d.v * dt * wind;
          if (d.y > H + 30) Object.assign(d, make(false));
        }
      },
    };
  },

  storm() {
    // Rain, a darker sky, and lightning: a soft flash from the side the
    // thunder will come from (one gentle pulse, never a strobe), with a bolt
    // for close strikes.
    const rain = FACTORIES.rain();
    let flashes = [];
    const bolt = (x) => {
      const pts = [[x, -10]];
      let px = x;
      for (let y = 0; y < H * 0.5; y += rand(18, 40)) {
        px += rand(-26, 26);
        pts.push([px, y]);
      }
      return pts;
    };
    return {
      init() {
        rain.init();
      },
      thunder({ delay, x, power }) {
        flashes.push({ at: performance.now() / 1000 + delay, x: W * x, power, bolt: power > 0.8 ? bolt(W * x) : null });
      },
      draw(dt, a) {
        g.globalAlpha = a * (colors.dark ? 0.22 : 0.1);
        g.fillStyle = '#0b1020';
        g.fillRect(0, 0, W, H);
        rain.draw(dt, a);
        const now = performance.now() / 1000;
        for (const f of flashes) {
          const age = now - f.at;
          if (age < 0) continue;
          if (age > 1) {
            f.done = true;
            continue;
          }
          const k = age < 0.07 ? age / 0.07 : Math.max(0, 1 - (age - 0.07) / 0.9);
          const grd = g.createRadialGradient(f.x, -H * 0.15, 0, f.x, -H * 0.15, Math.max(W, H));
          grd.addColorStop(0, `rgba(225,232,255,${0.28 * f.power * k})`);
          grd.addColorStop(1, 'rgba(225,232,255,0)');
          g.globalAlpha = a;
          g.fillStyle = grd;
          g.fillRect(0, 0, W, H);
          if (f.bolt && age < 0.35) {
            g.globalAlpha = a * 0.55 * (1 - age / 0.35);
            g.strokeStyle = '#f4f6ff';
            g.lineWidth = 2;
            g.lineJoin = 'round';
            g.beginPath();
            f.bolt.forEach(([bx, by], i) => (i ? g.lineTo(bx, by) : g.moveTo(bx, by)));
            g.stroke();
          }
        }
        flashes = flashes.filter((f) => !f.done);
      },
    };
  },

  waves() {
    let swell = 0;
    return {
      draw(dt, a, t) {
        const level = Math.min(1, audio.meter() * 5);
        swell += (level - swell) * Math.min(1, dt * 1.5);
        for (let k = 0; k < 3; k++) {
          const base = H * (0.8 + k * 0.065) - swell * 30 * (3 - k);
          const amp = 12 + k * 7 + swell * 14;
          const freq = 0.0042 - k * 0.0008;
          const speed = 0.35 + k * 0.18;
          g.beginPath();
          g.moveTo(0, H);
          for (let x = 0; x <= W + 16; x += 16) {
            const y = base
              + Math.sin(x * freq + t * speed + k * 1.9) * amp
              + Math.sin(x * freq * 2.4 - t * speed * 0.8) * amp * 0.3;
            g.lineTo(x, y);
          }
          g.lineTo(W, H);
          g.closePath();
          g.fillStyle = colors.waves[k] || colors.accent;
          g.globalAlpha = a * (colors.dark ? 0.16 + k * 0.03 : 0.16 + k * 0.04);
          g.fill();
        }
      },
    };
  },

  fire() {
    const embers = [];
    let spawn = 0;
    return {
      draw(dt, a, t) {
        const level = Math.min(1, audio.meter() * 5);
        // warm glow from below
        const glow = g.createRadialGradient(W / 2, H + 80, 0, W / 2, H + 80, Math.max(W, H) * 0.7);
        glow.addColorStop(0, 'rgba(255,120,30,0.5)');
        glow.addColorStop(1, 'rgba(255,120,30,0)');
        g.globalAlpha = a * (0.16 + level * 0.25 + Math.sin(t * 7) * 0.02);
        g.fillStyle = glow;
        g.fillRect(0, 0, W, H);

        spawn += dt * (W / 40);
        while (spawn > 1) {
          spawn -= 1;
          embers.push({
            x: W / 2 + rand(-0.35, 0.35) * W,
            y: H + 10,
            vx: rand(-15, 15),
            vy: rand(-90, -35),
            life: 0,
            max: rand(3, 7),
            size: rand(6, 16),
            seed: Math.random() * 10,
          });
        }
        if (colors.dark) g.globalCompositeOperation = 'lighter';
        for (let i = embers.length - 1; i >= 0; i--) {
          const e = embers[i];
          e.life += dt;
          if (e.life > e.max) {
            embers.splice(i, 1);
            continue;
          }
          e.x += (e.vx + Math.sin(t * 2 + e.seed) * 18) * dt;
          e.y += e.vy * dt;
          const fade = Math.sin((e.life / e.max) * Math.PI);
          const flicker = 0.7 + Math.sin(t * 13 + e.seed * 7) * 0.3;
          g.globalAlpha = a * fade * flicker * (colors.dark ? 0.9 : 0.75);
          const s = e.size * (1 - (e.life / e.max) * 0.5);
          g.drawImage(EMBER, e.x - s / 2, e.y - s / 2, s, s);
        }
      },
    };
  },

  night() {
    let stars = [];
    let flies = [];
    return {
      init() {
        stars = Array.from({ length: Math.round((W * H) / 14000) }, () => ({
          x: Math.random() * W,
          y: Math.random() * H * 0.65,
          r: rand(0.5, 1.6),
          phase: Math.random() * 6.28,
          speed: rand(0.6, 2),
        }));
        flies = Array.from({ length: 16 }, () => ({
          x: Math.random() * W,
          y: rand(H * 0.35, H * 0.95),
          vx: rand(-20, 20),
          vy: rand(-10, 10),
          phase: Math.random() * 6.28,
          size: rand(10, 20),
        }));
      },
      draw(dt, a, t) {
        g.fillStyle = colors.star;
        for (const s of stars) {
          g.globalAlpha = a * (0.25 + 0.75 * (0.5 + 0.5 * Math.sin(t * s.speed + s.phase))) * (colors.dark ? 0.85 : 0.35);
          g.beginPath();
          g.arc(s.x, s.y, s.r, 0, Math.PI * 2);
          g.fill();
        }
        if (colors.dark) g.globalCompositeOperation = 'lighter';
        for (const f of flies) {
          f.vx += rand(-1, 1) * 60 * dt;
          f.vy += rand(-1, 1) * 40 * dt;
          f.vx *= 0.985;
          f.vy *= 0.985;
          f.x += f.vx * dt;
          f.y += f.vy * dt;
          if (f.x < -20) f.x = W + 20;
          if (f.x > W + 20) f.x = -20;
          if (f.y < H * 0.25) f.vy += 30 * dt;
          if (f.y > H) f.vy -= 30 * dt;
          const blink = Math.pow(0.5 + 0.5 * Math.sin(t * 1.4 + f.phase), 3);
          g.globalAlpha = a * blink * (colors.dark ? 1 : 0.7);
          g.drawImage(FIREFLY, f.x - f.size / 2, f.y - f.size / 2, f.size, f.size);
        }
      },
    };
  },

  lofi() {
    const notes = [];
    const glyphs = ['♪', '♫', '♩', '♬'];
    let spawn = 0;
    return {
      draw(dt, a, t) {
        const level = Math.min(1, audio.meter() * 5);
        spawn += dt * Math.max(0.6, W / 900);
        while (spawn > 1) {
          spawn -= 1;
          notes.push({
            x: rand(0.04, 0.96) * W,
            y: H + 24,
            vy: rand(-30, -14),
            size: rand(16, 30),
            glyph: glyphs[Math.floor(Math.random() * glyphs.length)],
            life: 0,
            max: rand(9, 16),
            seed: Math.random() * 10,
          });
        }
        g.fillStyle = colors.accent;
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        for (let i = notes.length - 1; i >= 0; i--) {
          const n = notes[i];
          n.life += dt;
          if (n.life > n.max) {
            notes.splice(i, 1);
            continue;
          }
          n.y += n.vy * dt;
          const x = n.x + Math.sin(t * 0.8 + n.seed) * 18;
          const fade = Math.sin((n.life / n.max) * Math.PI);
          g.globalAlpha = a * fade * (colors.dark ? 0.38 : 0.32) * (0.75 + level * 0.8);
          g.font = `${(n.size * (1 + level * 0.18)).toFixed(1)}px Georgia, serif`;
          g.fillText(n.glyph, x, n.y);
        }
      },
    };
  },

  stream() {
    let glints = [];
    const make = (anywhere) => ({
      x: anywhere ? Math.random() * W : -20,
      y: H * rand(0.84, 0.99),
      v: rand(40, 110),
      len: rand(10, 40),
      phase: Math.random() * 6.28,
    });
    return {
      init() {
        glints = Array.from({ length: Math.round(W / 14) }, () => make(true));
      },
      draw(dt, a, t) {
        // The water itself: a soft band along the bottom.
        const band = g.createLinearGradient(0, H * 0.8, 0, H);
        band.addColorStop(0, 'rgba(60,150,220,0)');
        band.addColorStop(1, colors.dark ? 'rgba(60,150,220,0.22)' : 'rgba(60,150,220,0.18)');
        g.globalAlpha = a;
        g.fillStyle = band;
        g.fillRect(0, H * 0.8, W, H * 0.2);
        // Glints of light drifting downstream.
        g.lineCap = 'round';
        g.lineWidth = 1.5;
        g.strokeStyle = colors.dark ? '#cfe9ff' : '#ffffff';
        for (const s of glints) {
          s.x += s.v * dt;
          if (s.x > W + 40) Object.assign(s, make(false));
          g.globalAlpha = a * (0.12 + 0.38 * Math.max(0, Math.sin(t * 2.2 + s.phase)));
          g.beginPath();
          g.moveTo(s.x, s.y + Math.sin(t * 1.5 + s.phase) * 2);
          g.lineTo(s.x + s.len, s.y + Math.sin(t * 1.5 + s.phase + 0.6) * 2);
          g.stroke();
        }
      },
    };
  },

  wind() {
    let leaves = [];
    const tones = ['#d9822b', '#c8553d', '#e0a33a', '#8a9a3b', '#b5651d'];
    const make = (anywhere) => ({
      x: anywhere ? Math.random() * W : -30,
      y: Math.random() * H * 0.9,
      vx: rand(40, 120),
      vy: rand(-10, 25),
      rot: Math.random() * 6.28,
      spin: rand(-3, 3),
      size: rand(9, 16),
      color: tones[Math.floor(Math.random() * tones.length)],
      phase: Math.random() * 6.28,
    });
    return {
      init() {
        leaves = Array.from({ length: Math.round((W * H) / 32000) + 8 }, () => make(true));
      },
      draw(dt, a, t) {
        const gust = 0.6 + 0.6 * Math.max(0, Math.sin(t * 0.5)) + Math.min(1, audio.meter() * 4);
        for (const l of leaves) {
          l.x += l.vx * gust * dt;
          l.y += (l.vy + Math.sin(t * 2 + l.phase) * 30) * dt;
          l.rot += l.spin * dt * gust;
          if (l.x > W + 40 || l.y > H + 40 || l.y < -40) Object.assign(l, make(false));
          g.save();
          g.translate(l.x, l.y);
          g.rotate(l.rot);
          g.scale(1, 0.45 + 0.35 * Math.abs(Math.sin(t * 3 + l.phase)));
          g.globalAlpha = a * (colors.dark ? 0.55 : 0.7);
          g.fillStyle = l.color;
          g.beginPath();
          g.ellipse(0, 0, l.size, l.size * 0.5, 0, 0, Math.PI * 2);
          g.fill();
          g.restore();
        }
      },
    };
  },

  train() {
    // Hills rolling past the window: three layers of parallax, and telegraph
    // poles whipping by with their wires dipping between them.
    const ridge = (x, seed, k) =>
      Math.sin(x * k + seed) * 0.55 + Math.sin(x * k * 2.3 + seed * 1.7) * 0.3 + Math.sin(x * k * 5.1 + seed * 2.9) * 0.15;
    const bands = [
      { speed: 14, base: 0.74, amp: 46, k: 0.004, seed: 1.3, alpha: 0.5 },
      { speed: 46, base: 0.84, amp: 30, k: 0.007, seed: 4.1, alpha: 0.55 },
      { speed: 150, base: 0.93, amp: 14, k: 0.013, seed: 7.7, alpha: 0.6 },
    ];
    let offset = 0;
    const POLE_GAP = 340;
    const POLE_SPEED = 520;
    return {
      draw(dt, a, t) {
        offset += dt;
        bands.forEach((b, i) => {
          const shift = offset * b.speed;
          g.globalAlpha = a * b.alpha * (colors.dark ? 0.9 : 0.75);
          g.fillStyle = colors.hills[i];
          g.beginPath();
          g.moveTo(0, H);
          for (let x = 0; x <= W + 12; x += 12) g.lineTo(x, H * b.base - b.amp * ridge(x + shift, b.seed, b.k) - b.amp);
          g.lineTo(W, H);
          g.closePath();
          g.fill();
        });
        // Telegraph poles and the wires between them.
        const shift = (offset * POLE_SPEED) % POLE_GAP;
        const top = H * 0.6;
        g.globalAlpha = a * (colors.dark ? 0.55 : 0.4);
        g.strokeStyle = colors.pole;
        g.lineWidth = 5;
        const xs = [];
        for (let x = W + POLE_GAP - shift; x > -POLE_GAP; x -= POLE_GAP) xs.push(x);
        for (const x of xs) {
          g.beginPath();
          g.moveTo(x, top);
          g.lineTo(x, H);
          g.stroke();
        }
        g.lineWidth = 1.2;
        for (let w = 0; w < 2; w++) {
          g.beginPath();
          for (let i = 0; i < xs.length - 1; i++) {
            const y = top + 10 + w * 12;
            g.moveTo(xs[i], y);
            g.quadraticCurveTo((xs[i] + xs[i + 1]) / 2, y + 26 + Math.sin(t * 9 + w) * 1.5, xs[i + 1], y);
          }
          g.stroke();
        }
      },
    };
  },

  study() {
    // A warm reading lamp, and dust motes drifting slowly through its light.
    let motes = [];
    return {
      init() {
        motes = Array.from({ length: Math.round((W * H) / 26000) + 10 }, () => ({
          x: Math.random() * W,
          y: Math.random() * H,
          vx: rand(-6, 6),
          vy: rand(-8, 3),
          r: rand(0.7, 1.9),
          phase: Math.random() * 6.28,
        }));
      },
      draw(dt, a, t) {
        const cx = W * 0.5;
        const glow = g.createRadialGradient(cx, -H * 0.1, 0, cx, -H * 0.1, Math.max(W, H) * 0.75);
        glow.addColorStop(0, colors.dark ? 'rgba(255,196,120,0.22)' : 'rgba(255,190,110,0.24)');
        glow.addColorStop(1, 'rgba(255,190,110,0)');
        g.globalAlpha = a * (0.85 + 0.15 * Math.sin(t * 0.7));
        g.fillStyle = glow;
        g.fillRect(0, 0, W, H);
        g.fillStyle = colors.dark ? '#ffe2b8' : '#a07a52';
        for (const m of motes) {
          m.x += (m.vx + Math.sin(t * 0.4 + m.phase) * 5) * dt;
          m.y += (m.vy + Math.cos(t * 0.3 + m.phase) * 4) * dt;
          if (m.x < -10) m.x = W + 10;
          if (m.x > W + 10) m.x = -10;
          if (m.y < -10) m.y = H + 10;
          if (m.y > H + 10) m.y = -10;
          // Brighter nearer the lamp.
          const near = Math.max(0, 1 - Math.hypot(m.x - cx, m.y) / Math.max(W, H));
          g.globalAlpha = a * (0.1 + 0.5 * near) * (0.6 + 0.4 * Math.sin(t * 1.7 + m.phase));
          g.beginPath();
          g.arc(m.x, m.y, m.r, 0, Math.PI * 2);
          g.fill();
        }
      },
    };
  },

  birds() {
    // Morning sun slanting through the trees, pollen drifting in the beams,
    // and now and then a bird flying across.
    let pollen = [];
    let flock = [];
    let nextBird = 3;
    const beams = [0.12, 0.3, 0.52, 0.7].map((x) => ({ x, w: rand(0.05, 0.11), phase: Math.random() * 6.28 }));
    return {
      init() {
        pollen = Array.from({ length: Math.round((W * H) / 30000) + 10 }, () => ({
          x: Math.random() * W,
          y: Math.random() * H,
          vx: rand(-4, 8),
          vy: rand(-6, 6),
          r: rand(0.8, 2),
          phase: Math.random() * 6.28,
        }));
      },
      draw(dt, a, t) {
        const sun = colors.dark ? 'rgba(255,236,190,' : 'rgba(255,226,150,';
        for (const b of beams) {
          const x0 = W * b.x + W * 0.25;
          const w = W * b.w;
          g.globalAlpha = a * (0.55 + 0.45 * Math.sin(t * 0.35 + b.phase));
          const grd = g.createLinearGradient(x0, 0, x0 - H * 0.45, H);
          grd.addColorStop(0, `${sun}${colors.dark ? 0.1 : 0.22})`);
          grd.addColorStop(1, `${sun}0)`);
          g.fillStyle = grd;
          g.beginPath();
          g.moveTo(x0, -10);
          g.lineTo(x0 + w, -10);
          g.lineTo(x0 + w - H * 0.45, H);
          g.lineTo(x0 - H * 0.45 - w * 0.5, H);
          g.closePath();
          g.fill();
        }
        g.fillStyle = colors.dark ? '#fff1c9' : '#b38a2e';
        for (const m of pollen) {
          m.x += (m.vx + Math.sin(t * 0.5 + m.phase) * 6) * dt;
          m.y += (m.vy + Math.cos(t * 0.4 + m.phase) * 5) * dt;
          if (m.x < -10) m.x = W + 10;
          if (m.x > W + 10) m.x = -10;
          if (m.y < -10) m.y = H + 10;
          if (m.y > H + 10) m.y = -10;
          g.globalAlpha = a * (colors.dark ? 0.35 : 0.3) * (0.5 + 0.5 * Math.sin(t * 2 + m.phase));
          g.beginPath();
          g.arc(m.x, m.y, m.r, 0, Math.PI * 2);
          g.fill();
        }
        // Birds: little flapping "m" shapes gliding across the top.
        nextBird -= dt;
        if (nextBird <= 0) {
          const dir = Math.random() < 0.5 ? 1 : -1;
          const n = Math.random() < 0.4 ? 3 : 1;
          const y = H * rand(0.08, 0.3);
          for (let i = 0; i < n; i++) {
            flock.push({ x: dir > 0 ? -30 - i * 40 : W + 30 + i * 40, y: y + i * rand(-14, 14), v: dir * rand(90, 140), size: rand(7, 11), phase: Math.random() * 6.28, rise: rand(-12, 6) });
          }
          nextBird = rand(9, 20);
        }
        flock = flock.filter((b) => b.x > -60 - 200 && b.x < W + 260);
        g.strokeStyle = colors.dark ? '#d9d4cc' : '#4a4038';
        g.lineWidth = 1.8;
        g.lineCap = 'round';
        for (const b of flock) {
          b.x += b.v * dt;
          b.y += b.rise * dt;
          const flap = Math.sin(t * 9 + b.phase);
          const s = b.size;
          g.globalAlpha = a * 0.55;
          g.beginPath();
          g.moveTo(b.x - s, b.y - flap * s * 0.6);
          g.quadraticCurveTo(b.x - s * 0.45, b.y - s * 0.2 - flap * s * 0.3, b.x, b.y);
          g.quadraticCurveTo(b.x + s * 0.45, b.y - s * 0.2 - flap * s * 0.3, b.x + s, b.y - flap * s * 0.6);
          g.stroke();
        }
      },
    };
  },

  cafe() {
    // Warm out-of-focus lights and wisps of steam rising from cups.
    let bokeh = [];
    let wisps = [];
    const warm = ['255,190,120', '255,160,90', '255,220,160', '240,140,110'];
    // Soft discs drawn once, then stamped every frame.
    const discs = warm.map((c) => {
      const d = document.createElement('canvas');
      d.width = d.height = 96;
      const s = d.getContext('2d');
      const grd = s.createRadialGradient(48, 48, 0, 48, 48, 48);
      grd.addColorStop(0, `rgba(${c},1)`);
      grd.addColorStop(0.7, `rgba(${c},0.6)`);
      grd.addColorStop(1, `rgba(${c},0)`);
      s.fillStyle = grd;
      s.fillRect(0, 0, 96, 96);
      return d;
    });
    const makeWisp = (anywhere) => ({
      x: rand(0.05, 0.95) * W,
      y: anywhere ? rand(0.3, 1) * H : H + 20,
      v: rand(18, 34),
      amp: rand(10, 24),
      len: rand(60, 120),
      phase: Math.random() * 6.28,
    });
    return {
      init() {
        bokeh = Array.from({ length: Math.round(W / 70) + 6 }, () => ({
          x: Math.random() * W,
          y: rand(0.05, 0.6) * H,
          r: rand(14, 46),
          disc: discs[Math.floor(Math.random() * discs.length)],
          phase: Math.random() * 6.28,
          drift: rand(-4, 4),
        }));
        wisps = Array.from({ length: 6 }, () => makeWisp(true));
      },
      draw(dt, a, t) {
        for (const b of bokeh) {
          b.x += b.drift * dt;
          if (b.x < -60) b.x = W + 60;
          if (b.x > W + 60) b.x = -60;
          const glow = 0.5 + 0.5 * Math.sin(t * 0.6 + b.phase);
          g.globalAlpha = a * (colors.dark ? 0.2 : 0.16) * (0.6 + 0.4 * glow);
          g.drawImage(b.disc, b.x - b.r, b.y - b.r, b.r * 2, b.r * 2);
        }
        g.strokeStyle = colors.dark ? '#f2e8e0' : '#ffffff';
        g.lineWidth = 3;
        g.lineCap = 'round';
        for (const w of wisps) {
          w.y -= w.v * dt;
          if (w.y < H * 0.25) Object.assign(w, makeWisp(false));
          const fade = Math.min(1, (H - w.y) / 120) * Math.min(1, (w.y - H * 0.25) / (H * 0.25));
          g.globalAlpha = a * fade * (colors.dark ? 0.12 : 0.35);
          g.beginPath();
          for (let i = 0; i <= 12; i++) {
            const k = i / 12;
            const yy = w.y + k * w.len;
            const xx = w.x + Math.sin(t * 1.2 + w.phase + k * 4) * w.amp * (1 - k * 0.5);
            if (i === 0) g.moveTo(xx, yy);
            else g.lineTo(xx, yy);
          }
          g.stroke();
        }
      },
    };
  },

  fan() {
    let motes = [];
    return {
      init() {
        motes = Array.from({ length: Math.round((W * H) / 22000) }, () => ({
          x: Math.random() * W,
          y: Math.random() * H,
          v: rand(30, 110),
          r: rand(0.8, 2.2),
          phase: Math.random() * 6.28,
        }));
      },
      draw(dt, a, t) {
        g.fillStyle = colors.dust;
        for (const m of motes) {
          m.x += m.v * dt;
          m.y += Math.sin(t * 1.3 + m.phase) * 12 * dt;
          if (m.x > W + 10) {
            m.x = -10;
            m.y = Math.random() * H;
          }
          g.globalAlpha = a * (colors.dark ? 0.3 : 0.22);
          g.beginPath();
          g.arc(m.x, m.y, m.r, 0, Math.PI * 2);
          g.fill();
        }
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Engine

function resize() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  layers.forEach((l) => l.init && l.init());
}

function frame(now) {
  // On a device that can't keep up, draw every other frame to halve the work
  // (with hysteresis so it doesn't flip back and forth).
  const interval = lastTick ? Math.min(0.1, (now - lastTick) / 1000) : 1 / 60;
  lastTick = now;
  frameEMA += (interval - frameEMA) * 0.05;
  if (!halfRate && frameEMA > 0.026) halfRate = true;
  else if (halfRate && frameEMA < 0.018) halfRate = false;
  if (halfRate) {
    skip = !skip;
    if (skip) {
      raf = requestAnimationFrame(frame);
      return;
    }
  }
  const dt = Math.min(0.05, (now - last) / 1000 || 0.016);
  last = now;
  time += dt;
  g.clearRect(0, 0, W, H);
  for (const [kind, layer] of layers) {
    const target = active.has(kind) ? 1 : 0;
    layer.alpha += (target - layer.alpha) * Math.min(1, dt * 2);
    if (target === 0 && layer.alpha < 0.01) {
      layers.delete(kind);
      continue;
    }
    g.save();
    layer.draw(dt, layer.alpha, time);
    g.restore();
  }
  if (layers.size && !document.hidden) raf = requestAnimationFrame(frame);
  else {
    raf = 0;
    if (!layers.size) g.clearRect(0, 0, W, H);
  }
}

function run() {
  if (raf || !layers.size || document.hidden) return;
  last = performance.now();
  lastTick = 0;
  raf = requestAnimationFrame(frame);
}

/** Show the scenes for these ambient sounds (others fade away). */
export function setScenes(kinds) {
  active = new Set(enabled && motionOK() ? kinds.filter((k) => FACTORIES[k]) : []);
  for (const kind of active) {
    if (layers.has(kind)) continue;
    const layer = FACTORIES[kind]();
    layer.alpha = 0;
    if (layer.init) layer.init();
    layers.set(kind, layer);
  }
  run();
}

export function setEnabled(on) {
  enabled = Boolean(on);
}

/** Re-read colours after a theme, palette or mode change. */
export function refresh() {
  readColors();
}

// The storm's sound says when and where lightning strikes.
window.addEventListener('tempo:thunder', (e) => {
  const layer = layers.get('storm');
  if (layer && active.has('storm') && layer.thunder) layer.thunder(e.detail);
});

export function mount() {
  const aurora = document.querySelector('.aurora');
  if (aurora) aurora.after(canvas);
  else document.body.prepend(canvas);
  readColors();
  resize();
  window.addEventListener('resize', resize);
  document.addEventListener('visibilitychange', run);
}
