// Tempo sound engine.
// Everything is synthesised live with the Web Audio API (no audio files), and
// placed in 3D space around the listener with HRTF panning, so headphones give
// you rain falling all around you, waves rolling past, and button clicks that
// come from wherever the button is on screen.

const AC = window.AudioContext || window.webkitAudioContext;

let ctx = null;
let master, sfxBus, chimeBus, ambientBus;
const buffers = {};
let sfxOn = true;
let ambientLevel = 0.5;
let scene = null;
let sceneTimer = 0;
let tracked = null;
let analyser = null;
let meterBuf = null;
let reverb = null;

export const supported = Boolean(AC);

function ensure() {
  if (!AC) return null;
  if (!ctx) {
    ctx = new AC({ latencyHint: 'interactive' });
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -12;
    comp.knee.value = 12;
    comp.ratio.value = 4;
    comp.attack.value = 0.003;
    comp.release.value = 0.25;
    master = ctx.createGain();
    master.gain.value = 0.9;
    master.connect(comp).connect(ctx.destination);
    sfxBus = gain(0.5, master);
    chimeBus = gain(0.75, master);
    ambientBus = gain(curve(ambientLevel), master);
    analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    meterBuf = new Float32Array(analyser.fftSize);
    ambientBus.connect(analyser);
    reverb = ctx.createConvolver();
    reverb.buffer = roomImpulse(2.2, 3.2);
    reverb.connect(gain(0.45, master));
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

/** Call from a user gesture so browsers allow audio to start. */
export function unlock() { ensure(); }

export function setSfxEnabled(on) { sfxOn = Boolean(on); }

export const ambientPlaying = () => Boolean(scene);

/** Current loudness (RMS) of the ambient scene, 0 when nothing is playing. */
export function meter() {
  if (!analyser || !scene) return 0;
  analyser.getFloatTimeDomainData(meterBuf);
  let sum = 0;
  for (let i = 0; i < meterBuf.length; i++) sum += meterBuf[i] * meterBuf[i];
  return Math.sqrt(sum / meterBuf.length);
}

export function setAmbientVolume(v) {
  ambientLevel = Math.max(0, Math.min(1, v));
  if (ctx) ambientBus.gain.setTargetAtTime(curve(ambientLevel), ctx.currentTime, 0.05);
}

// ---------------------------------------------------------------------------
// Building blocks

const rand = (a, b) => a + Math.random() * (b - a);
const curve = (v) => v * v;

function gain(value, dest) {
  const g = ctx.createGain();
  g.gain.value = value;
  if (dest) g.connect(dest);
  return g;
}

function filter(type, freq, q = 0.7) {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  return f;
}

function osc(type, freq) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.value = freq;
  return o;
}

function panner(x, y, z, rolloff = 0.6) {
  const p = ctx.createPanner();
  p.panningModel = 'HRTF';
  p.distanceModel = 'inverse';
  p.refDistance = 1;
  p.maxDistance = 60;
  p.rolloffFactor = rolloff;
  place(p, x, y, z);
  return p;
}

function place(p, x, y, z, t) {
  if (p.positionX) {
    if (t == null) {
      p.positionX.value = x;
      p.positionY.value = y;
      p.positionZ.value = z;
    } else {
      p.positionX.setValueAtTime(x, t);
      p.positionY.setValueAtTime(y, t);
      p.positionZ.setValueAtTime(z, t);
    }
  } else {
    p.setPosition(x, y, z);
  }
}

function glide(p, x, y, z, t) {
  if (!p.positionX) return;
  p.positionX.linearRampToValueAtTime(x, t);
  p.positionY.linearRampToValueAtTime(y, t);
  p.positionZ.linearRampToValueAtTime(z, t);
}

/** A synthetic room impulse response for the reverb. */
function roomImpulse(seconds, decay) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
  }
  return buf;
}

/** Send some of a node's signal to the room reverb. */
function send(node, amount) {
  if (reverb) node.connect(gain(amount, reverb));
}

/** Exponential glide of an AudioParam from one value to another. */
function sweep(param, from, to, t, dur) {
  param.setValueAtTime(from, t);
  param.exponentialRampToValueAtTime(to, t + dur);
}

/** Fast attack, exponential decay. */
function envelope(g, t, attack, peak, decay) {
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
}

/** Seamlessly looping noise: white, pink or brown. */
function noise(type) {
  if (buffers[type]) return buffers[type];
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * 6);
  const fade = Math.floor(sr * 0.4);
  const raw = new Float32Array(len + fade);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0;
  for (let i = 0; i < raw.length; i++) {
    const w = Math.random() * 2 - 1;
    if (type === 'white') {
      raw[i] = w;
    } else if (type === 'pink') {
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.016898;
      raw[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
      b6 = w * 0.115926;
    } else {
      last = (last + 0.02 * w) / 1.02;
      raw[i] = last;
    }
  }
  // Crossfade the overflow into the head so the loop point is inaudible.
  const data = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    if (i < fade) {
      const k = (i / fade) * (Math.PI / 2);
      data[i] = raw[i] * Math.sin(k) + raw[len + i] * Math.cos(k);
    } else {
      data[i] = raw[i];
    }
  }
  let sum = 0;
  for (let i = 0; i < len; i++) sum += data[i] * data[i];
  const k = 0.22 / (Math.sqrt(sum / len) || 1);
  for (let i = 0; i < len; i++) data[i] = Math.max(-1, Math.min(1, data[i] * k));
  const buf = ctx.createBuffer(1, len, sr);
  buf.getChannelData(0).set(data);
  buffers[type] = buf;
  return buf;
}

/** A noise source that starts at a random point and keeps running. */
function noiseSource(type, t = ctx.currentTime, dur) {
  const s = ctx.createBufferSource();
  s.buffer = noise(type);
  s.loop = true;
  s.start(t, Math.random() * s.buffer.duration);
  if (dur != null) s.stop(t + dur + 0.05);
  else if (tracked) tracked.push(s);
  return s;
}

function track(node) {
  if (tracked) tracked.push(node);
  return node;
}

// ---------------------------------------------------------------------------
// Interface sounds — positioned where the element is on screen.

function screenToSpace(source) {
  let cx = window.innerWidth / 2;
  let cy = window.innerHeight / 2;
  if (source && typeof source.getBoundingClientRect === 'function') {
    const r = source.getBoundingClientRect();
    cx = r.left + r.width / 2;
    cy = r.top + r.height / 2;
  } else if (source && Number.isFinite(source.x)) {
    cx = source.x;
    cy = source.y;
  }
  const nx = (cx / Math.max(window.innerWidth, 1)) * 2 - 1;
  const ny = (cy / Math.max(window.innerHeight, 1)) * 2 - 1;
  return [nx * 1.8, -ny * 0.9, -1.2];
}

const SFX = {
  tap(t, out) {
    const o = osc('triangle', 0);
    sweep(o.frequency, 1500 * rand(0.92, 1.08), 650, t, 0.045);
    const g = gain(0.0001, out);
    envelope(g, t, 0.002, 0.32, 0.055);
    o.connect(g);
    o.start(t);
    o.stop(t + 0.09);
    const n = noiseSource('white', t, 0.02);
    const hp = filter('highpass', 3500);
    const g2 = gain(0.0001, out);
    envelope(g2, t, 0.001, 0.22, 0.012);
    n.connect(hp).connect(g2);
  },
  pop(t, out) {
    const f = rand(300, 380);
    const o = osc('sine', f);
    sweep(o.frequency, f, f * 3.2, t, 0.05);
    const g = gain(0.0001, out);
    envelope(g, t, 0.003, 0.55, 0.09);
    o.connect(g);
    o.start(t);
    o.stop(t + 0.12);
  },
  start(t, out) {
    [[523.25, 0], [783.99, 0.075]].forEach(([f, d]) => {
      const o = osc('sine', f);
      const g = gain(0.0001, out);
      envelope(g, t + d, 0.004, 0.45, 0.16);
      o.connect(g);
      o.start(t + d);
      o.stop(t + d + 0.2);
    });
    SFX.tap(t, out);
  },
  pause(t, out) {
    [[659.25, 0], [440, 0.075]].forEach(([f, d]) => {
      const o = osc('sine', f);
      const g = gain(0.0001, out);
      envelope(g, t + d, 0.004, 0.4, 0.14);
      o.connect(g);
      o.start(t + d);
      o.stop(t + d + 0.18);
    });
  },
  check(t, out) {
    SFX.pop(t, out);
    [1567.98, 2093].forEach((f, i) => {
      const o = osc('sine', f);
      const g = gain(0.0001, out);
      envelope(g, t + 0.05 + i * 0.06, 0.003, 0.2, 0.25);
      o.connect(g);
      o.start(t + 0.05 + i * 0.06);
      o.stop(t + 0.4 + i * 0.06);
    });
  },
  uncheck(t, out) {
    const o = osc('sine', 520);
    sweep(o.frequency, 520, 260, t, 0.08);
    const g = gain(0.0001, out);
    envelope(g, t, 0.003, 0.35, 0.09);
    o.connect(g);
    o.start(t);
    o.stop(t + 0.12);
  },
  remove(t, out) {
    const o = osc('sine', 420);
    sweep(o.frequency, 420, 90, t, 0.14);
    const g = gain(0.0001, out);
    envelope(g, t, 0.004, 0.6, 0.16);
    o.connect(g);
    o.start(t);
    o.stop(t + 0.2);
    const n = noiseSource('pink', t, 0.15);
    const lp = filter('lowpass', 1200);
    const g2 = gain(0.0001, out);
    envelope(g2, t, 0.003, 0.3, 0.1);
    n.connect(lp).connect(g2);
  },
  open(t, out) {
    const n = noiseSource('pink', t, 0.35);
    const bp = filter('bandpass', 400, 1.2);
    sweep(bp.frequency, 400, 2400, t, 0.25);
    const g = gain(0.0001, out);
    envelope(g, t, 0.08, 0.35, 0.22);
    n.connect(bp).connect(g);
  },
  close(t, out) {
    const n = noiseSource('pink', t, 0.3);
    const bp = filter('bandpass', 2200, 1.2);
    sweep(bp.frequency, 2200, 350, t, 0.22);
    const g = gain(0.0001, out);
    envelope(g, t, 0.05, 0.3, 0.2);
    n.connect(bp).connect(g);
  },
  on(t, out) {
    const o = osc('sine', 880);
    sweep(o.frequency, 880, 1320, t, 0.05);
    const g = gain(0.0001, out);
    envelope(g, t, 0.003, 0.35, 0.08);
    o.connect(g);
    o.start(t);
    o.stop(t + 0.12);
  },
  off(t, out) {
    const o = osc('sine', 1100);
    sweep(o.frequency, 1100, 620, t, 0.05);
    const g = gain(0.0001, out);
    envelope(g, t, 0.003, 0.3, 0.08);
    o.connect(g);
    o.start(t);
    o.stop(t + 0.12);
  },
  key(t, out) {
    const bp = filter('bandpass', rand(2600, 4200), 1.3);
    const g = gain(0.0001, out);
    envelope(g, t, 0.001, rand(0.16, 0.26), rand(0.014, 0.028));
    noiseSource('white', t, 0.04).connect(bp).connect(g);
    const o = osc('sine', rand(150, 200));
    const g2 = gain(0.0001, out);
    envelope(g2, t, 0.002, 0.2, 0.035);
    o.connect(g2);
    o.start(t);
    o.stop(t + 0.06);
  },
  keySpace(t, out) {
    const bp = filter('bandpass', 1500, 1.1);
    const g = gain(0.0001, out);
    envelope(g, t, 0.002, 0.28, 0.04);
    noiseSource('white', t, 0.06).connect(bp).connect(g);
    const o = osc('sine', 110);
    const g2 = gain(0.0001, out);
    envelope(g2, t, 0.003, 0.3, 0.06);
    o.connect(g2);
    o.start(t);
    o.stop(t + 0.09);
  },
  keyBack(t, out) {
    const bp = filter('bandpass', 2000, 2);
    const g = gain(0.0001, out);
    envelope(g, t, 0.001, 0.22, 0.03);
    noiseSource('white', t, 0.05).connect(bp).connect(g);
    const o = osc('sine', 0);
    sweep(o.frequency, 900, 500, t, 0.04);
    const g2 = gain(0.0001, out);
    envelope(g2, t, 0.002, 0.08, 0.04);
    o.connect(g2);
    o.start(t);
    o.stop(t + 0.07);
  },
  tick(t, out) {
    const o = osc('square', 2600);
    const hp = filter('highpass', 1800);
    const g = gain(0.0001, out);
    envelope(g, t, 0.001, 0.08, 0.02);
    o.connect(hp).connect(g);
    o.start(t);
    o.stop(t + 0.04);
  },
};

/**
 * Play an interface sound. `source` is the element (or {x, y} point) the sound
 * should come from.
 */
export function sfx(name, source) {
  if (!sfxOn || !SFX[name]) return;
  const c = ensure();
  if (!c) return;
  const [x, y, z] = screenToSpace(source);
  const p = panner(x, y, z, 0);
  p.connect(sfxBus);
  SFX[name](c.currentTime + 0.005, p);
}

// ---------------------------------------------------------------------------
// End-of-session chime: a bell arpeggio that sweeps across the room.

function bell(t, f, out, peak) {
  [[1, 1, 2.2], [2.01, 0.42, 1.3], [3.03, 0.2, 0.8], [4.2, 0.1, 0.45]].forEach(([ratio, amp, dur]) => {
    const o = osc('sine', f * ratio);
    const g = gain(0.0001, out);
    envelope(g, t, 0.006, peak * amp, dur);
    o.connect(g);
    o.start(t);
    o.stop(t + dur + 0.05);
  });
}

/** kind: 'break' (a focus session ended) or 'focus' (a break ended). */
export function chime(kind) {
  const c = ensure();
  if (!c) return;
  const t = c.currentTime + 0.06;
  const notes = kind === 'break'
    ? [[659.25, -1.6], [830.61, -0.5], [987.77, 0.5], [1318.51, 1.6]]
    : [[987.77, 1.4], [783.99, 0], [659.25, -1.4]];
  notes.forEach(([f, x], i) => {
    const p = panner(x, 0.4, -1.4, 0);
    p.connect(chimeBus);
    send(p, 0.28);
    bell(t + i * 0.16, f, p, 0.32);
  });
}

/** Achievement fanfare: a sparkling arpeggio whose notes circle your head. */
export function fanfare() {
  if (!sfxOn) return;
  const c = ensure();
  if (!c) return;
  const t = c.currentTime + 0.05;
  const notes = [783.99, 987.77, 1174.66, 1567.98, 1975.53, 2349.32];
  notes.forEach((f, i) => {
    const a = (i / notes.length) * Math.PI * 2;
    const p = panner(Math.sin(a) * 1.6, 0.2 + i * 0.12, -Math.cos(a) * 1.6, 0);
    p.connect(chimeBus);
    send(p, 0.2);
    bell(t + i * 0.085, f, p, 0.16);
  });
}

// ---------------------------------------------------------------------------
// Ambient scenes. Each builds a graph into `out` and may return a tick()
// that schedules one-off events (rain drops, waves, crackles) ahead of time.

function aroundListener(minR, maxR) {
  const a = Math.random() * Math.PI * 2;
  const r = rand(minR, maxR);
  return [Math.cos(a) * r, Math.sin(a) * r];
}

const SCENES = {
  rain(out) {
    for (const x of [-2.2, 2.2]) {
      const hp = filter('highpass', 450);
      const lp = filter('lowpass', 6500);
      const p = panner(x, 1.2, -0.4);
      noiseSource('pink').connect(hp).connect(lp).connect(gain(0.45, p));
      p.connect(out);
    }
    const rumble = filter('lowpass', 260);
    noiseSource('brown').connect(rumble).connect(gain(0.35, out));

    let next = ctx.currentTime + 0.05;
    let thunderAt = ctx.currentTime + rand(30, 70);

    function drop(t) {
      const [x, z] = aroundListener(1, 6);
      const p = panner(x, rand(-1.5, 2.5), z, 1);
      const g = gain(0.0001, p);
      p.connect(out);
      if (Math.random() < 0.3) {
        const f = rand(1600, 3600);
        const o = osc('sine', f);
        sweep(o.frequency, f, f * rand(1.2, 1.5), t, 0.025);
        envelope(g, t, 0.001, rand(0.02, 0.07), rand(0.02, 0.045));
        o.connect(g);
        o.start(t);
        o.stop(t + 0.08);
      } else {
        const bp = filter('bandpass', rand(1800, 6500), 1.4);
        noiseSource('white', t, 0.04).connect(bp).connect(g);
        envelope(g, t, 0.001, rand(0.1, 0.35), rand(0.008, 0.03));
      }
    }

    function thunder(t) {
      const p = panner(rand(-10, 10), 4, rand(-14, -6), 0.15);
      p.connect(out);
      const lp = filter('lowpass', 160);
      lp.frequency.setValueAtTime(160, t);
      lp.frequency.linearRampToValueAtTime(420, t + 0.8);
      lp.frequency.linearRampToValueAtTime(140, t + 6);
      const g = gain(0.0001, p);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(1.2, t + 0.7);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 7);
      noiseSource('brown', t, 7).connect(lp).connect(g);
    }

    return (until) => {
      while (next < until) {
        drop(next);
        next += rand(0.012, 0.075);
      }
      if (thunderAt < until) {
        thunder(thunderAt);
        thunderAt += rand(50, 140);
      }
    };
  },

  waves(out) {
    noiseSource('brown').connect(filter('lowpass', 320)).connect(gain(0.22, out));
    let next = ctx.currentTime + 0.1;

    function wave(t) {
      const dur = rand(7, 10.5);
      const crash = t + dur * 0.42;
      const side = rand(-1, 1);
      const p = panner(side * 5, 0, -9);
      place(p, side * 5, 0, -9, t);
      glide(p, -side * 1.2, -0.5, -1.4, crash);
      glide(p, -side * 3.5, -0.9, 2, t + dur);
      p.connect(out);

      const lp = filter('lowpass', 260, 0.8);
      lp.frequency.setValueAtTime(260, t);
      lp.frequency.linearRampToValueAtTime(1500, crash);
      lp.frequency.exponentialRampToValueAtTime(300, t + dur);
      const g = gain(0, p);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(rand(0.75, 1), crash);
      g.gain.setTargetAtTime(0, crash, dur * 0.17);
      noiseSource('brown', t, dur + 1).connect(lp).connect(g);

      const hp = filter('highpass', 1300);
      const fg = gain(0, p);
      fg.gain.setValueAtTime(0, crash - dur * 0.08);
      fg.gain.linearRampToValueAtTime(rand(0.3, 0.5), crash + dur * 0.04);
      fg.gain.setTargetAtTime(0, crash + dur * 0.04, dur * 0.14);
      noiseSource('pink', crash - dur * 0.08, dur * 0.7).connect(hp).connect(fg);
    }

    return (until) => {
      while (next < until) {
        wave(next);
        next += rand(5, 8.5);
      }
    };
  },

  fire(out) {
    const hearth = panner(0, -0.7, -1.5);
    hearth.connect(out);
    noiseSource('brown').connect(filter('lowpass', 520)).connect(gain(0.6, hearth));
    noiseSource('pink').connect(filter('bandpass', 2600, 0.6)).connect(gain(0.035, hearth));
    let next = ctx.currentTime + 0.05;

    function crackle(t, big) {
      const p = panner(rand(-0.8, 0.8), rand(-0.9, -0.3), rand(-1.9, -1.1), 1);
      p.connect(out);
      const dur = big ? rand(0.02, 0.05) : rand(0.003, 0.014);
      const f = big ? filter('bandpass', rand(500, 1100), 1.2) : filter('highpass', rand(1400, 5000));
      const g = gain(0.0001, p);
      envelope(g, t, 0.0008, big ? rand(0.4, 0.8) : rand(0.08, 0.5), dur);
      noiseSource('white', t, dur + 0.02).connect(f).connect(g);
    }

    return (until) => {
      while (next < until) {
        crackle(next, Math.random() < 0.06);
        next += Math.random() < 0.2 ? rand(0.008, 0.04) : rand(0.06, 0.5);
      }
    };
  },

  night(out) {
    // Crickets dotted around you in the dark, each with its own voice.
    const crickets = Array.from({ length: 6 }, () => {
      const [x, z] = aroundListener(2, 8);
      const p = panner(x, rand(-1.2, 0.3), z, 0.9);
      p.connect(out);
      return {
        p,
        f: rand(4000, 5400),
        pulses: 2 + Math.floor(Math.random() * 3),
        gap: rand(0.026, 0.04),
        every: rand(0.45, 1.15),
        level: rand(0.05, 0.13),
        next: ctx.currentTime + rand(0.1, 1.5),
        restUntil: 0,
      };
    });

    function chirp(c, t) {
      const o = osc('sine', c.f);
      const g = gain(0, c.p);
      for (let k = 0; k < c.pulses; k++) {
        const s0 = t + k * c.gap;
        g.gain.setValueAtTime(0, s0);
        g.gain.linearRampToValueAtTime(c.level, s0 + 0.004);
        g.gain.linearRampToValueAtTime(c.level * 0.6, s0 + 0.012);
        g.gain.linearRampToValueAtTime(0, s0 + 0.019);
      }
      o.connect(g);
      o.start(t);
      o.stop(t + c.pulses * c.gap + 0.03);
    }

    // A breeze that wanders around you.
    const now = ctx.currentTime;
    const windP = panner(-3, 1, -2, 0.3);
    place(windP, -3, 1, -2, now);
    windP.connect(out);
    const bp = filter('bandpass', 380, 0.6);
    bp.frequency.setValueAtTime(380, now);
    const wg = gain(0.2, windP);
    wg.gain.setValueAtTime(0.2, now);
    noiseSource('pink').connect(bp).connect(wg);
    let windNext = now;

    let owlAt = now + rand(15, 40);
    function owl(t) {
      const [x, z] = aroundListener(10, 16);
      const p = panner(x, 3, z, 0.25);
      p.connect(out);
      send(p, 0.5);
      [[0, 0.42], [0.55, 0.22], [0.9, 0.75]].forEach(([d, len]) => {
        const s0 = t + d;
        const o = osc('sine', 0);
        o.frequency.setValueAtTime(400, s0);
        o.frequency.linearRampToValueAtTime(385, s0 + len);
        const vib = osc('sine', 5.5);
        const depth = gain(5);
        vib.connect(depth).connect(o.frequency);
        const g = gain(0, p);
        g.gain.setValueAtTime(0, s0);
        g.gain.linearRampToValueAtTime(0.35, s0 + 0.08);
        g.gain.setValueAtTime(0.35, s0 + len - 0.12);
        g.gain.linearRampToValueAtTime(0, s0 + len);
        o.connect(g);
        o.start(s0);
        vib.start(s0);
        o.stop(s0 + len + 0.05);
        vib.stop(s0 + len + 0.05);
      });
    }

    return (until) => {
      for (const c of crickets) {
        while (c.next < until) {
          if (c.next >= c.restUntil) chirp(c, c.next);
          c.next += c.every * rand(0.93, 1.07);
          if (Math.random() < 0.02) c.restUntil = c.next + rand(2, 6);
        }
      }
      while (windNext < until) {
        const dur = rand(2, 4.5);
        wg.gain.linearRampToValueAtTime(rand(0.06, 0.38), windNext + dur);
        bp.frequency.linearRampToValueAtTime(rand(250, 750), windNext + dur);
        glide(windP, rand(-4, 4), rand(0, 2), rand(-4, 4), windNext + dur);
        windNext += dur;
      }
      if (owlAt < until) {
        owl(owlAt);
        owlAt += rand(45, 110);
      }
    };
  },

  clock(out) {
    // An old clock on the wall to your left, in a quiet room.
    const wall = panner(-2.4, 0.9, -0.6, 0.5);
    wall.connect(out);
    send(wall, 0.6);
    noiseSource('brown').connect(filter('lowpass', 180)).connect(gain(0.06, out));
    let next = Math.ceil(ctx.currentTime + 0.1);
    let tock = false;

    function tick(t, low) {
      const bp = filter('bandpass', low ? 2100 : 2900, 6);
      const g = gain(0.0001, wall);
      envelope(g, t, 0.0005, 0.9, 0.025);
      noiseSource('white', t, 0.03).connect(bp).connect(g);
      const o = osc('sine', low ? 1150 : 1520);
      const g2 = gain(0.0001, wall);
      envelope(g2, t, 0.001, 0.1, 0.05);
      o.connect(g2);
      o.start(t);
      o.stop(t + 0.08);
      const body = osc('triangle', low ? 170 : 210);
      const g3 = gain(0.0001, wall);
      envelope(g3, t, 0.001, 0.12, 0.06);
      body.connect(g3);
      body.start(t);
      body.stop(t + 0.1);
    }

    return (until) => {
      while (next < until) {
        tick(next, tock);
        tock = !tock;
        next += 1;
      }
    };
  },

  brown(out) {
    for (const x of [-1.6, 1.6]) {
      const p = panner(x, 0, -0.3);
      noiseSource('brown').connect(filter('lowpass', 900)).connect(gain(0.6, p));
      p.connect(out);
    }
  },

  fan(out) {
    const fan = panner(2, 0.2, -1.1);
    fan.connect(out);
    const air = gain(0.42, fan);
    noiseSource('white').connect(filter('lowpass', 2100)).connect(filter('highpass', 110)).connect(air);
    const flutter = track(osc('sine', 13.5));
    flutter.connect(gain(0.07)).connect(air.gain);
    flutter.start();
    [[118, 0.018], [236, 0.007]].forEach(([f, v]) => {
      const hum = track(osc('sine', f));
      hum.connect(gain(v, fan));
      hum.start();
    });
    const wall = panner(-1.8, 0, 0.6);
    wall.connect(out);
    noiseSource('pink').connect(filter('lowpass', 800)).connect(gain(0.16, wall));
  },
};

export const ambientKinds = Object.keys(SCENES);

/** Switch the ambient scene. 'off' (or anything unknown) fades to silence. */
export function setAmbient(kind) {
  const c = ensure();
  if (!c) return;
  stopScene();
  if (!SCENES[kind]) return;

  const t = c.currentTime;
  const out = c.createGain();
  out.gain.setValueAtTime(0.0001, t);
  out.gain.exponentialRampToValueAtTime(1, t + 1.4);
  out.connect(ambientBus);

  tracked = [];
  const tick = SCENES[kind](out);
  scene = { out, nodes: tracked };
  tracked = null;

  if (tick) {
    const run = () => tick(c.currentTime + 1.2);
    run();
    sceneTimer = setInterval(run, 250);
  }
}

function stopScene() {
  clearInterval(sceneTimer);
  if (!scene) return;
  const { out, nodes } = scene;
  scene = null;
  const t = ctx.currentTime;
  out.gain.cancelScheduledValues(t);
  out.gain.setValueAtTime(out.gain.value, t);
  out.gain.linearRampToValueAtTime(0, t + 0.6);
  setTimeout(() => {
    nodes.forEach((n) => { try { n.stop(); } catch { /* already stopped */ } });
    out.disconnect();
  }, 750);
}
