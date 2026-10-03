import * as audio from './audio.js?v=33';
import * as fx from './fx.js?v=33';
import { toast } from './toast.js?v=33';
import * as effects from './effects.js?v=33';
import * as scenery from './scenery.js?v=33';
import * as pip from './pip.js?v=33';
import { shareCard } from './share.js?v=33';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const STORE_KEY = 'tempo:v1';
const DAY = 864e5;
const MODES = {
  focus: { label: 'Focus', note: (pos, n) => `Session ${pos} of ${n}` },
  short: { label: 'Short break', note: () => 'Stretch · sip some water' },
  long: { label: 'Long break', note: () => 'Step away for a while' },
};
const MODE_ORDER = ['focus', 'short', 'long'];
const DEFAULTS = {
  focus: 25,
  short: 5,
  long: 15,
  longEvery: 4,
  goal: 4,
  autoBreaks: false,
  autoFocus: false,
  breathing: true,
  chime: true,
  sfx: true,
  notify: false,
  wakeLock: false,
  theme: 'auto',
  palette: 'sunset',
  scenery: true,
  soundsWithTimer: false,
  chimeStyle: 'bells',
};
const PALETTES = ['sunset', 'ocean', 'forest', 'lavender', 'rose', 'mono'];
const LIMITS = { focus: [1, 180], short: [1, 60], long: [1, 90], longEvery: [2, 12], goal: [1, 24] };
const RING_C = 2 * Math.PI * 100;

// ---------------------------------------------------------------------------
// State

const obj = (v) => (v && typeof v === 'object' ? v : {});
const clampInt = (v, min, max, fallback) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

function readStore() {
  try {
    return obj(JSON.parse(localStorage.getItem(STORE_KEY) || '{}'));
  } catch {
    return {};
  }
}

const stored = readStore();

// Each piece of saved state is cleaned before use, so a damaged or old save
// can't break the app. The same cleaners keep other open tabs in sync.
function cleanSettings(raw) {
  const out = { ...DEFAULTS, ...obj(raw) };
  for (const [k, [min, max]] of Object.entries(LIMITS)) out[k] = clampInt(out[k], min, max, DEFAULTS[k]);
  if (!['auto', 'light', 'dark'].includes(out.theme)) out.theme = 'auto';
  if (!PALETTES.includes(out.palette)) out.palette = 'sunset';
  if (!audio.chimeStyles.includes(out.chimeStyle)) out.chimeStyle = 'bells';
  return out;
}

function cleanTimer(raw) {
  const out = { mode: 'focus', running: false, endAt: 0, total: null, paused: null, cycle: 0, ...obj(raw) };
  if (!MODES[out.mode]) out.mode = 'focus';
  out.cycle = clampInt(out.cycle, 0, 1e6, 0);
  out.distractions = clampInt(out.distractions, 0, 99, 0);
  out.running = Boolean(out.running) && Number.isFinite(out.endAt);
  return out;
}

function cleanTasks(raw) {
  return (Array.isArray(raw) ? raw : [])
    .filter((t) => t && typeof t.title === 'string' && t.id)
    .map((t) => ({
      id: String(t.id),
      title: t.title.slice(0, 120),
      est: clampInt(t.est, 1, 20, 1),
      pomos: clampInt(t.pomos, 0, 999, 0),
      done: Boolean(t.done),
      ...(t.counted ? { counted: true } : {}),
    }));
}

function cleanHistory(raw) {
  return (Array.isArray(raw) ? raw : [])
    .filter((h) => h && Number.isFinite(h.t) && Number.isFinite(h.m) && h.t > Date.now() - 400 * DAY)
    .map((h) => ({
      t: h.t,
      m: h.m,
      s: h.s ? 1 : 0,
      ...(typeof h.task === 'string' ? { task: h.task.slice(0, 120) } : {}),
      ...(Number.isInteger(h.r) && h.r >= 1 && h.r <= 4 ? { r: h.r } : {}),
      ...(Number.isInteger(h.d) && h.d > 0 ? { d: Math.min(h.d, 99) } : {}),
    }));
}

function cleanCounters(raw) {
  const out = { tasksDone: 0, soundsTried: [], ...obj(raw) };
  if (!Array.isArray(out.soundsTried)) out.soundsTried = [];
  return out;
}

const settings = cleanSettings(stored.settings);
const timer = cleanTimer(stored.timer);
let tasks = cleanTasks(stored.tasks);
let activeTaskId = tasks.some((t) => t.id === stored.activeTaskId) ? stored.activeTaskId : null;
let history = cleanHistory(stored.history);
const achievements = { ...obj(stored.achievements) };
const counters = cleanCounters(stored.counters);

const clampNum = (v, min, max, fallback) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Math.min(max, Math.max(min, Number(v))) : fallback);
const sound = { volume: 50, ...obj(stored.sound) };
sound.volume = clampInt(sound.volume, 0, 100, 50);
sound.mix = obj(sound.mix);
// Earlier versions played one sound at a time.
if (typeof sound.kind === 'string' && audio.ambientKinds.includes(sound.kind) && !Object.keys(sound.mix).length) {
  sound.mix[sound.kind] = { on: true };
}
delete sound.kind;
for (const k of Object.keys(sound.mix)) {
  if (!audio.ambientKinds.includes(k)) {
    delete sound.mix[k];
    continue;
  }
  const m = obj(sound.mix[k]);
  const [dx, dz] = audio.defaultAnchor(k);
  sound.mix[k] = { on: Boolean(m.on), vol: clampNum(m.vol, 0, 1, k === 'binaural' ? 0.5 : 0.8), x: clampNum(m.x, -4, 4, dx), z: clampNum(m.z, -4, 4, dz), orbit: Boolean(m.orbit) };
}

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ settings, timer, tasks, activeTaskId, history, sound, achievements, counters }));
  } catch {
    /* storage full or blocked: the app still works for this visit */
  }
}

// ---------------------------------------------------------------------------
// Elements

const el = {
  body: document.body,
  metaTheme: $('meta[name="theme-color"]'),
  modes: $('.modes'),
  tabs: $$('.mode-tab'),
  dial: $('#dial'),
  ring: $('#ring-progress'),
  head: $('#ring-head'),
  time: $('#time'),
  sessionLabel: $('#session-label'),
  toggle: $('#btn-toggle'),
  toggleLabel: $('#toggle-label'),
  reset: $('#btn-reset'),
  skip: $('#btn-skip'),
  currentTask: $('#current-task'),
  currentTaskTitle: $('#current-task-title'),
  chips: $$('.chip'),
  volume: $('#volume'),
  taskForm: $('#task-form'),
  taskInput: $('#task-input'),
  taskEst: $('#task-est'),
  taskList: $('#task-list'),
  taskSummary: $('#task-summary'),
  clearDone: $('#btn-clear-done'),
  announcer: $('#announcer'),
  statsDialog: $('#stats-dialog'),
  settingsDialog: $('#settings-dialog'),
  settingsForm: $('#settings-form'),
  install: $('#btn-install'),
  zen: $('#btn-zen'),
  miniTime: $('#mini-time'),
  miniMode: $('#mini-mode'),
  navBadge: $('#nav-badge'),
  extend: $('#btn-extend'),
  distract: $('#btn-distract'),
  distractCount: $('#distract-count'),
  pip: $('#btn-pip'),
  mixer: $('#mixer'),
  mixes: $('#mixes'),
  mixList: $('#mix-list'),
  room: $('#room'),
  dots: $('#cycle-dots'),
  helpDialog: $('#help-dialog'),
  favicon: $('link[rel="icon"]'),
  goal: $('#goal-pill'),
  goalFill: $('#goal-fill'),
  goalCount: $('#goal-count'),
  goalTarget: $('#goal-target'),
};

el.ring.style.strokeDasharray = `${RING_C}`;
const wakeGlow = effects.initAudioGlow(el.dial);
const updateTicks = effects.makeTicks($('.ring'));

// ---------------------------------------------------------------------------
// Timer

const durationOf = (mode) => settings[mode] * 60000;
const totalMs = () => timer.total ?? durationOf(timer.mode);
const remainingMs = () => (timer.running ? Math.max(0, timer.endAt - Date.now()) : timer.paused ?? totalMs());
const isFresh = () => !timer.running && timer.total == null;

let tickTimer = 0;
let endTimer = 0;

function schedule() {
  clearTimeout(tickTimer);
  clearTimeout(endTimer);
  if (!timer.running) return;
  const rem = timer.endAt - Date.now();
  if (rem <= 0) {
    complete({ late: -rem });
    return;
  }
  // One un-chained timeout for the exact end (browsers throttle chained timers
  // in background tabs), plus a per-second tick for the display.
  endTimer = setTimeout(onTick, rem + 20);
  tickTimer = setTimeout(onTick, ((rem - 1) % 1000) + 1 + 15);
}

function onTick() {
  if (timer.running && Date.now() >= timer.endAt) {
    complete({ late: Date.now() - timer.endAt });
    return;
  }
  renderTimer();
  schedule();
}

function start() {
  if (timer.running) return;
  if (timer.total == null) timer.total = durationOf(timer.mode);
  timer.endAt = Date.now() + (timer.paused ?? timer.total);
  timer.paused = null;
  timer.running = true;
  afterTimerChange();
}

function pause() {
  if (!timer.running) return;
  timer.paused = Math.max(0, timer.endAt - Date.now());
  timer.running = false;
  afterTimerChange();
}

/** Stretch or trim the current session (not before it has started). */
function addTime(ms, source) {
  if (isFresh()) return false;
  const rem = remainingMs();
  // Never trim below 10 seconds left (and never let "minus" add time).
  const change = ms >= 0 ? ms : Math.min(0, Math.max(ms, 10000 - rem));
  if (change === 0) return false;
  timer.total = Math.max(totalMs() + change, 10000);
  if (timer.running) timer.endAt += change;
  else timer.paused = rem + change;
  afterTimerChange();
  if (source) {
    fx.pop(source, 1.12);
    audio.sfx(change > 0 ? 'on' : 'off', source);
  }
  fx.pop(el.time, 1.04);
  return true;
}

const RATINGS = ['😫', '😐', '🙂', '🤩'];
const RATING_NAMES = ['Rough', 'Okay', 'Good', 'Great'];

function noteDistraction(source) {
  if (timer.mode !== 'focus' || isFresh()) return;
  timer.distractions = Math.min(99, (timer.distractions || 0) + 1);
  save();
  renderDistractions();
  audio.sfx('tick', source || el.distract);
  fx.pop(el.distract, 1.12);
  if (timer.distractions === 1) {
    toast({ icon: '⚡', title: 'Noted. Back to it!', body: 'Jot the thought down as a task if it matters, then refocus.', duration: 3500 });
  }
}

function renderDistractions() {
  const n = timer.distractions || 0;
  el.distract.hidden = timer.mode !== 'focus' || isFresh();
  el.distractCount.textContent = n ? String(n) : 'Distracted';
  el.distract.setAttribute('aria-label', n ? `Distractions this session: ${n}. Tap to add one.` : 'Note a distraction');
}

function clearSession() {
  timer.running = false;
  timer.total = null;
  timer.paused = null;
  timer.distractions = 0;
}

function reset() {
  clearSession();
  afterTimerChange();
}

function afterTimerChange() {
  save();
  schedule();
  renderTimer(true);
  syncWakeLock();
  syncSoundGate();
}

// With "only while the timer runs", ambient sound fades with the timer.
function syncSoundGate() {
  const open = !settings.soundsWithTimer || timer.running;
  audio.setAmbientGate(open);
  scenery.setScenes(open ? activeKinds() : []);
  el.body.classList.toggle('sounds-gated', !open && activeKinds().length > 0);
}

function nextAfter(mode) {
  if (mode !== 'focus') return 'focus';
  return timer.cycle % settings.longEvery === 0 ? 'long' : 'short';
}

function switchTo(mode) {
  timer.mode = mode;
  clearSession();
  applyMode();
  afterTimerChange();
  renderTasks();
}

function complete({ late = 0 } = {}) {
  const ended = timer.mode;
  const endedAt = timer.running ? timer.endAt : Date.now();
  if (ended === 'focus') {
    const task = tasks.find((t) => t.id === activeTaskId);
    // Another open tab may have recorded this same session already.
    if (!history.some((h) => h.s && h.t === endedAt)) {
      history.push({
        t: endedAt,
        m: Math.round(totalMs() / 60000),
        s: 1,
        ...(task ? { task: task.title } : {}),
        ...(timer.distractions ? { d: timer.distractions } : {}),
      });
    }
    if (task && !task.done) task.pomos += 1;
    timer.cycle += 1;
  } else if (ended === 'long') {
    timer.cycle = 0;
  }
  const next = nextAfter(ended);
  switchTo(next);
  renderGoal();

  // Stay quiet about a session that ended long ago while the page was closed.
  if (late > 60000) {
    if (ended === 'focus') checkFocusAchievements(endedAt, next, { quiet: true });
    return;
  }

  if (settings.chime) audio.chime(next === 'focus' ? 'focus' : 'break', settings.chimeStyle);
  if (ended === 'focus' && isZen()) unlock('zen', { delay: 1600 });
  if (settings.sfx) fx.haptic([140, 90, 140, 90, 260]);
  notify(ended, next);
  if (ended === 'focus') fx.celebrate(el.dial);
  else fx.burst(el.dial, { count: 18, spread: 150, size: 8 });
  fx.pop(el.dial, 1.04);
  announce(
    ended === 'focus'
      ? `Focus session complete. Time for a ${next === 'long' ? 'long' : 'short'} break.`
      : 'Break over. Time to focus.',
  );
  const auto = next === 'focus' ? settings.autoFocus : settings.autoBreaks;
  if (auto) start();
  const startAction = { label: next === 'focus' ? 'Start focus' : 'Start break', onClick: () => { if (!timer.running) toggleTimer(el.toggle); } };
  if (ended === 'focus') {
    // One tap to note how the session went.
    const rate = (r) => () => {
      const h = history.find((x) => x.s && x.t === endedAt);
      if (h) h.r = r;
      save();
      audio.sfx('pop', el.toggle);
    };
    toast({
      icon: '☕',
      title: 'Focus session done. How did it go?',
      body: auto ? `Your ${settings[next]}-minute break has started.` : `Time for a ${settings[next]}-minute break.`,
      duration: 12000,
      actions: [
        ...RATINGS.map((emoji, i) => ({ label: emoji, kind: 'emoji', ariaLabel: RATING_NAMES[i], title: RATING_NAMES[i], onClick: rate(i + 1) })),
        ...(auto ? [] : [startAction]),
      ],
    });
  } else if (!auto) {
    toast({ icon: '🎯', title: 'Break is over', body: 'Ready when you are.', duration: 9000, action: startAction });
  }
  if (ended === 'focus') {
    const today = dayTotals(new Date());
    const hitGoal = today.s === settings.goal;
    if (hitGoal) {
      setTimeout(() => {
        toast({ icon: '🎯', title: 'Daily goal reached!', body: `${today.s} focus sessions today. Brilliant work.`, tone: 'gold' });
        fx.celebrate(el.goal);
        fx.pop(el.goal, 1.2);
        audio.fanfare();
      }, 1400);
    }
    checkFocusAchievements(endedAt, next, { delay: hitGoal ? 3000 : 1400 });
  }
}

function skip() {
  const ended = timer.mode;
  if (ended === 'focus') {
    const elapsed = totalMs() - remainingMs();
    const task = tasks.find((t) => t.id === activeTaskId);
    if (!isFresh() && elapsed >= 60000) {
      history.push({
        t: Date.now(),
        m: Math.floor(elapsed / 60000),
        s: 0,
        ...(task ? { task: task.title } : {}),
        ...(timer.distractions ? { d: timer.distractions } : {}),
      });
    }
    timer.cycle += 1;
  } else if (ended === 'long') {
    timer.cycle = 0;
  }
  switchTo(nextAfter(ended));
}

// ---------------------------------------------------------------------------
// Rendering: timer

const pad = (n) => String(n).padStart(2, '0');
const fmtClock = (secs) => `${pad(Math.floor(secs / 60))}:${pad(secs % 60)}`;

let lastClock = '';
let lastFraction = 1;

function renderDigits(text, animate) {
  const spans = el.time.children;
  while (spans.length < text.length) el.time.appendChild(document.createElement('span'));
  while (spans.length > text.length) el.time.lastChild.remove();
  for (let i = 0; i < text.length; i++) {
    const s = spans[i];
    const ch = text[i];
    if (s.textContent === ch) continue;
    s.textContent = ch;
    s.className = ch === ':' ? 'colon' : 'digit';
    if (animate && ch !== ':' && fx.motionOK()) {
      s.animate(
        [
          { transform: 'translateY(-38%)', opacity: 0, filter: 'blur(2px)' },
          { transform: 'translateY(0)', opacity: 1, filter: 'blur(0)' },
        ],
        { duration: 320, easing: 'cubic-bezier(.2,.8,.2,1)' },
      );
    }
  }
}

function renderTimer(force = false) {
  const rem = remainingMs();
  const secs = Math.ceil(rem / 1000);
  const clock = fmtClock(secs);

  if (clock !== lastClock || force) {
    renderDigits(clock, !force && timer.running);
    lastClock = clock;
    el.time.setAttribute('aria-label', `${Math.floor(secs / 60)} minutes ${secs % 60} seconds remaining`);
    const emoji = { focus: '🎯', short: '☕', long: '🌿' }[timer.mode];
    document.title = isFresh() ? 'Tempo · Focus Timer' : `${emoji} ${clock} · ${MODES[timer.mode].label} · Tempo`;

    if (timer.running && secs > 0 && secs <= 3 && !force && document.visibilityState === 'visible') {
      audio.sfx('tick', el.time);
      fx.pop(el.time, 1.05);
    }
  }

  const f = Math.max(0, Math.min(1, rem / totalMs()));
  lastFraction = f;
  el.ring.style.strokeDashoffset = `${RING_C * (1 - f)}`;
  updateTicks(f);
  renderBreath(rem);
  renderFavicon(f);
  pip.update(force);
  const a = f * Math.PI * 2;
  el.head.setAttribute('cx', `${110 + 100 * Math.cos(a)}`);
  el.head.setAttribute('cy', `${110 + 100 * Math.sin(a)}`);

  el.body.classList.toggle('is-running', timer.running);
  el.miniTime.textContent = clock;
  el.miniMode.textContent = MODES[timer.mode].label;
  el.extend.hidden = isFresh();
  renderDistractions();
  el.toggle.setAttribute('aria-pressed', String(timer.running));
  el.toggleLabel.textContent = timer.running ? 'Pause' : isFresh() ? 'Start' : 'Resume';
}

// Box breathing during breaks: 4s in, 4s hold, 4s out, 4s hold.
const BREATH = [
  ['in', 'Breathe in'],
  ['hold-in', 'Hold'],
  ['out', 'Breathe out'],
  ['hold-out', 'Hold'],
];
let breathPhase = -1;

function renderBreath(rem) {
  const on = settings.breathing && timer.running && timer.mode !== 'focus';
  if (!on) {
    if (breathPhase !== -1) {
      breathPhase = -1;
      delete el.dial.dataset.breath;
      el.sessionLabel.textContent = sessionNote();
    }
    return;
  }
  const elapsed = Math.max(0, totalMs() - rem);
  const phase = Math.floor((elapsed % 16000) / 4000);
  if (phase === breathPhase) return;
  breathPhase = phase;
  el.dial.dataset.breath = BREATH[phase][0];
  el.sessionLabel.textContent = BREATH[phase][1];
}

// The browser-tab icon becomes a tiny progress ring while a session is on.
const FAV_DEFAULT = { href: el.favicon.href, type: el.favicon.type };
const favCanvas = document.createElement('canvas');
favCanvas.width = favCanvas.height = 64;
let favKey = '';

function renderFavicon(f) {
  if (isFresh()) {
    if (favKey !== 'idle') {
      favKey = 'idle';
      el.favicon.type = FAV_DEFAULT.type;
      el.favicon.href = FAV_DEFAULT.href;
    }
    return;
  }
  const key = `${timer.mode}:${Math.round(f * 60)}:${timer.running}`;
  if (key === favKey) return;
  favKey = key;
  const c = favCanvas.getContext('2d');
  const accent = getComputedStyle(el.body).getPropertyValue('--accent').trim() || '#e5512f';
  c.clearRect(0, 0, 64, 64);
  c.lineWidth = 10;
  c.lineCap = 'round';
  c.strokeStyle = 'rgba(140, 125, 117, .35)';
  c.beginPath();
  c.arc(32, 32, 25, 0, Math.PI * 2);
  c.stroke();
  c.strokeStyle = accent;
  c.beginPath();
  c.arc(32, 32, 25, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.max(0.001, f));
  c.stroke();
  c.fillStyle = accent;
  if (timer.running) {
    c.beginPath();
    c.arc(32, 32, 8, 0, Math.PI * 2);
    c.fill();
  } else {
    c.fillRect(23, 21, 6, 22);
    c.fillRect(35, 21, 6, 22);
  }
  el.favicon.type = 'image/png';
  el.favicon.href = favCanvas.toDataURL('image/png');
}

function renderDots() {
  const n = settings.longEvery;
  const filled = timer.mode === 'long' ? n : timer.cycle % n;
  el.dots.replaceChildren(
    ...Array.from({ length: n }, (_, i) => {
      const dot = document.createElement('i');
      if (i < filled) dot.className = 'is-done';
      else if (i === filled && timer.mode === 'focus') dot.className = 'is-current';
      return dot;
    }),
  );
}

function sessionNote() {
  const pos = (timer.cycle % settings.longEvery) + 1;
  return MODES[timer.mode].note(pos, settings.longEvery);
}

function applyMode() {
  const mode = timer.mode;
  el.body.dataset.mode = mode;
  el.tabs.forEach((t) => t.setAttribute('aria-selected', String(t.dataset.mode === mode)));
  el.modes.style.setProperty('--i', String(MODE_ORDER.indexOf(mode)));
  breathPhase = -1;
  delete el.dial.dataset.breath;
  el.sessionLabel.textContent = sessionNote();
  renderDots();
  updateThemeColor();
  renderTimer(true);
}

function updateThemeColor() {
  requestAnimationFrame(() => {
    const c = getComputedStyle(el.body).getPropertyValue('--bg').trim();
    if (c && el.metaTheme) el.metaTheme.content = c;
    scenery.refresh();
  });
}

function applyTheme() {
  if (settings.theme === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = settings.theme;
  el.body.dataset.palette = settings.palette;
  favKey = '';
  renderFavicon(Math.max(0, Math.min(1, remainingMs() / totalMs())));
  updateThemeColor();
}

function announce(msg) {
  el.announcer.textContent = '';
  setTimeout(() => { el.announcer.textContent = msg; }, 50);
}

// ---------------------------------------------------------------------------
// Floating mini timer (picture-in-picture)

pip.init({
  getState() {
    const cs = getComputedStyle(el.body);
    const v = (n) => cs.getPropertyValue(`--${n}`).trim();
    const paused = !timer.running && !isFresh();
    return {
      clock: lastClock,
      mode: `${MODES[timer.mode].label}${paused ? ' · paused' : ''}`,
      fraction: lastFraction,
      running: timer.running,
      colors: Object.fromEntries(['accent', 'accent-soft', 'bg', 'ink', 'ink-2', 'track', 'on-accent'].map((n) => [n, v(n)])),
    };
  },
  onToggle: () => toggleTimer(el.toggle),
  onSkip: () => el.skip.click(),
  onClose: () => el.pip.setAttribute('aria-pressed', 'false'),
});

async function togglePip() {
  try {
    await pip.toggle();
    el.pip.setAttribute('aria-pressed', String(pip.isOpen()));
    audio.sfx(pip.isOpen() ? 'open' : 'close', el.pip);
  } catch {
    toast({ icon: '🪟', title: "Couldn't open the mini timer", body: 'Your browser blocked the floating window.' });
  }
}

// ---------------------------------------------------------------------------
// Zen mode: a fullscreen, distraction-free timer

const isZen = () => el.body.classList.contains('is-zen');

function setZen(on) {
  if (on === isZen()) return;
  const apply = () => {
    el.body.classList.toggle('is-zen', on);
    el.zen.setAttribute('aria-pressed', String(on));
    el.zen.setAttribute('aria-label', on ? 'Leave zen mode' : 'Zen mode');
  };
  if (document.startViewTransition && fx.motionOK()) document.startViewTransition(apply);
  else apply();
  audio.sfx(on ? 'open' : 'close', el.zen);
  const root = document.documentElement;
  if (on && root.requestFullscreen && !document.fullscreenElement) root.requestFullscreen().catch(() => {});
  if (!on && document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && isZen()) setZen(false);
});

// ---------------------------------------------------------------------------
// Wake lock & notifications

let wakeLock = null;

async function syncWakeLock() {
  const want = settings.wakeLock && timer.running && document.visibilityState === 'visible' && 'wakeLock' in navigator;
  if (want && !wakeLock) {
    try {
      const lock = await navigator.wakeLock.request('screen');
      lock.addEventListener('release', () => { if (wakeLock === lock) wakeLock = null; });
      wakeLock = lock;
      // Paused (or hidden) while the request was pending? Let go again.
      if (!(settings.wakeLock && timer.running && document.visibilityState === 'visible')) syncWakeLock();
    } catch {
      wakeLock = null;
    }
  } else if (!want && wakeLock) {
    const lock = wakeLock;
    wakeLock = null;
    try { await lock.release(); } catch { /* already released */ }
  }
}

async function notify(ended, next) {
  if (!settings.notify || !('Notification' in window) || Notification.permission !== 'granted') return;
  const title = ended === 'focus' ? 'Focus session done' : 'Break is over';
  const body =
    next === 'focus'
      ? 'Ready for the next focus session?'
      : `Nice work. Take ${settings[next]} minutes to recharge.`;
  const opts = { body, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', tag: 'tempo', renotify: true };
  try {
    const reg = navigator.serviceWorker && (await navigator.serviceWorker.getRegistration());
    if (reg) {
      await reg.showNotification(title, opts);
      return;
    }
  } catch {
    /* fall through */
  }
  try { new Notification(title, opts); } catch { /* not allowed here */ }
}

// ---------------------------------------------------------------------------
// Tasks

const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`);

const ICON_GRIP = '<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>';
const ICON_EDIT = '<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4"/></svg>';
const ICON_ORBIT = '<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.3-5.6"/><path d="M20 4v4h-4"/><circle cx="12" cy="12" r="2.2"/></svg>';
const ICON_X = '<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17"/></svg>';

function taskRow(task) {
  const li = document.createElement('li');
  li.className = 'task';
  li.dataset.id = task.id;
  li.classList.toggle('is-active', task.id === activeTaskId);
  li.classList.toggle('is-done', task.done);

  const check = document.createElement('input');
  check.type = 'checkbox';
  check.className = 'task-check';
  check.checked = task.done;
  check.setAttribute('aria-label', `Mark "${task.title}" as done`);

  const select = document.createElement('button');
  select.type = 'button';
  select.className = 'task-select';
  select.setAttribute('aria-pressed', String(task.id === activeTaskId));
  select.title = task.id === activeTaskId ? 'Current task' : 'Work on this task';
  const title = document.createElement('span');
  title.className = 'task-title';
  title.textContent = task.title;
  const count = document.createElement('span');
  count.className = 'task-count';
  count.textContent = `${task.pomos}/${task.est}`;
  count.setAttribute('aria-label', `${task.pomos} of ${task.est} pomodoros`);
  select.append(title, count);

  const grip = document.createElement('button');
  grip.type = 'button';
  grip.className = 'task-grip';
  grip.setAttribute('aria-label', `Reorder "${task.title}". Use the up and down arrow keys.`);
  grip.title = 'Drag to reorder';
  grip.innerHTML = ICON_GRIP;

  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'task-edit-btn pressable';
  edit.setAttribute('aria-label', `Edit "${task.title}"`);
  edit.title = 'Edit';
  edit.innerHTML = ICON_EDIT;

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'task-delete pressable';
  del.setAttribute('aria-label', `Delete "${task.title}"`);
  del.title = 'Delete';
  del.innerHTML = ICON_X;

  li.append(grip, check, select, edit, del);
  return li;
}

// Inline editing of a task's name and estimate.
function startEdit(li) {
  const task = tasks.find((t) => t.id === li.dataset.id);
  const select = li.querySelector('.task-select');
  if (!task || !select) return;

  const form = document.createElement('div');
  form.className = 'task-edit';
  const input = document.createElement('input');
  input.type = 'text';
  input.maxLength = 120;
  input.value = task.title;
  input.setAttribute('aria-label', 'Task name');
  const est = document.createElement('input');
  est.type = 'number';
  est.min = '1';
  est.max = '20';
  est.inputMode = 'numeric';
  est.value = String(task.est);
  est.setAttribute('aria-label', 'Estimated pomodoros');
  form.append(input, est);
  select.replaceWith(form);
  li.classList.add('is-editing');
  input.focus();
  input.select();
  audio.sfx('open', li);

  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    if (commit) {
      const title = input.value.trim();
      if (title) task.title = title.slice(0, 120);
      task.est = clampInt(est.value, 1, 20, task.est);
      save();
      audio.sfx('on', li);
    } else {
      audio.sfx('off', li);
    }
    renderTasks();
    const row = el.taskList.querySelector(`[data-id="${CSS.escape(task.id)}"]`);
    if (row) {
      fx.pop(row, 1.02);
      row.querySelector('.task-edit-btn')?.focus();
    }
  };
  form.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      finish(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      finish(false);
    }
  });
  form.addEventListener('focusout', (e) => {
    if (!form.contains(e.relatedTarget)) finish(true);
  });
}

// Phones: swipe a task right to tick it off, left to delete it.
function initTaskSwipe() {
  const THRESHOLD = 90;
  el.taskList.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    const li = e.target.closest('.task');
    if (!li || e.target.closest('.task-grip, .task-edit, input')) return;
    const x0 = e.clientX;
    const y0 = e.clientY;
    let dx = 0;
    let active = false;

    const cleanup = () => {
      li.removeEventListener('pointermove', move);
      li.removeEventListener('pointerup', up);
      li.removeEventListener('pointercancel', up);
    };
    const move = (ev) => {
      const mx = ev.clientX - x0;
      const my = ev.clientY - y0;
      if (!active) {
        if (Math.abs(my) > 10 && Math.abs(my) > Math.abs(mx)) {
          cleanup();
          return;
        }
        if (Math.abs(mx) < 12) return;
        active = true;
        li.setPointerCapture(ev.pointerId);
        li.classList.add('is-swiping');
      }
      dx = mx;
      const p = Math.min(1, Math.abs(dx) / THRESHOLD);
      li.style.transform = `translateX(${dx}px)`;
      li.dataset.swipe = dx > 0 ? 'right' : 'left';
      li.style.setProperty('--p', p.toFixed(2));
      if (p >= 1 && !li.dataset.armed) {
        li.dataset.armed = '1';
        fx.haptic(12);
        audio.sfx('tick', li);
      } else if (p < 1 && li.dataset.armed) {
        delete li.dataset.armed;
      }
    };
    const up = () => {
      cleanup();
      if (!active) return;
      // The swipe shouldn't also count as a tap on the task.
      const swallow = (ce) => {
        ce.stopPropagation();
        ce.preventDefault();
      };
      li.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => li.removeEventListener('click', swallow, { capture: true }), 350);
      li.classList.remove('is-swiping');
      delete li.dataset.armed;
      if (dx > THRESHOLD) {
        const check = li.querySelector('.task-check');
        check.checked = !check.checked;
        check.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (dx < -THRESHOLD) {
        li.style.transform = 'translateX(-105%)';
        removeTasks([li.dataset.id], li);
      } else {
        li.style.transform = '';
        delete li.dataset.swipe;
      }
    };
    li.addEventListener('pointermove', move);
    li.addEventListener('pointerup', up);
    li.addEventListener('pointercancel', up);
  });
}

function moveTask(from, to) {
  if (to < 0 || to >= tasks.length || to === from) return false;
  const [t] = tasks.splice(from, 1);
  tasks.splice(to, 0, t);
  save();
  return true;
}

// Drag to reorder with the grip (mouse and touch). Rows slide out of the way.
function initTaskDrag() {
  el.taskList.addEventListener('pointerdown', (e) => {
    const grip = e.target.closest('.task-grip');
    if (!grip || e.button > 0) return;
    e.preventDefault();
    const li = grip.closest('.task');
    const rows = [...el.taskList.children];
    const from = rows.indexOf(li);
    const rects = rows.map((r) => r.getBoundingClientRect());
    const step = rects[from].height + 6;
    const startY = e.clientY;
    let to = from;

    li.classList.add('is-dragging');
    el.taskList.classList.add('is-sorting');
    grip.setPointerCapture(e.pointerId);
    audio.sfx('tap', grip);
    fx.haptic(10);

    const move = (ev) => {
      const min = rects[0].top - rects[from].top;
      const max = rects[rects.length - 1].bottom - rects[from].bottom;
      const dy = Math.max(min - 12, Math.min(max + 12, ev.clientY - startY));
      li.style.transform = `translateY(${dy}px) scale(1.03)`;
      const center = rects[from].top + rects[from].height / 2 + dy;
      let idx = from;
      rows.forEach((r, i) => {
        const mid = rects[i].top + rects[i].height / 2;
        if (i < from && center < mid) idx = Math.min(idx, i);
        if (i > from && center > mid) idx = Math.max(idx, i);
      });
      if (idx === to) return;
      to = idx;
      audio.sfx('tick', li);
      fx.haptic(4);
      rows.forEach((r, i) => {
        if (i === from) return;
        let shift = 0;
        if (from < to && i > from && i <= to) shift = -step;
        if (from > to && i >= to && i < from) shift = step;
        r.style.transform = shift ? `translateY(${shift}px)` : '';
      });
    };

    const up = () => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      grip.removeEventListener('pointercancel', up);
      const before = li.getBoundingClientRect();
      rows.forEach((r) => { r.style.transform = ''; });
      li.classList.remove('is-dragging');
      el.taskList.classList.remove('is-sorting');
      if (!moveTask(from, to)) return;
      renderTasks();
      audio.sfx('pop', grip);
      const row = el.taskList.querySelector(`[data-id="${CSS.escape(li.dataset.id)}"]`);
      if (row && row.animate && fx.motionOK()) {
        const after = row.getBoundingClientRect();
        row.animate(
          [{ transform: `translateY(${before.top - after.top}px) scale(1.03)` }, { transform: 'none' }],
          { duration: 380, easing: 'cubic-bezier(.3,1.4,.5,1)' },
        );
      }
    };

    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
    grip.addEventListener('pointercancel', up);
  });

  // Keyboard: arrow keys on the grip move the task.
  el.taskList.addEventListener('keydown', (e) => {
    const grip = e.target.closest('.task-grip');
    if (!grip || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    const id = grip.closest('.task').dataset.id;
    const from = tasks.findIndex((t) => t.id === id);
    if (!moveTask(from, from + (e.key === 'ArrowUp' ? -1 : 1))) return;
    renderTasks();
    audio.sfx('tick', grip);
    el.taskList.querySelector(`[data-id="${CSS.escape(id)}"] .task-grip`)?.focus();
  });
}

function renderTasks({ entering } = {}) {
  el.taskList.replaceChildren(...tasks.map(taskRow));
  for (const id of [].concat(entering || [])) {
    const li = el.taskList.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (li) fx.enter(li);
  }

  const open = tasks.filter((t) => !t.done).length;
  el.navBadge.hidden = open === 0;
  el.navBadge.textContent = String(open);

  const active = tasks.find((t) => t.id === activeTaskId);
  el.currentTask.hidden = !active;
  if (active) el.currentTaskTitle.textContent = active.title;
  el.clearDone.hidden = !tasks.some((t) => t.done);
  renderSummary();
}

function renderSummary() {
  if (!tasks.length) {
    el.taskSummary.hidden = true;
    return;
  }
  const done = tasks.reduce((n, t) => n + t.pomos, 0);
  const planned = tasks.reduce((n, t) => n + Math.max(t.est, t.pomos), 0);
  const left = tasks.filter((t) => !t.done).reduce((n, t) => n + Math.max(0, t.est - t.pomos), 0);
  let text = `<strong>${done}/${planned}</strong> pomodoros`;
  if (left > 0) {
    const at = new Date(estimateFinish(left));
    const time = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const sameDay = at.toDateString() === new Date().toDateString();
    text += ` · finish around <strong>${time}${sameDay ? '' : ' tomorrow'}</strong>`;
  } else {
    text += ' · everything planned is done';
  }
  el.taskSummary.innerHTML = text;
  el.taskSummary.hidden = false;
}

function estimateFinish(focusLeft) {
  let t = Date.now();
  let mode = timer.mode;
  let rem = remainingMs();
  let cycle = timer.cycle;
  let need = focusLeft;
  for (let guard = 0; guard < 500; guard++) {
    t += rem;
    if (mode === 'focus') {
      need -= 1;
      cycle += 1;
      if (need <= 0) break;
      mode = cycle % settings.longEvery === 0 ? 'long' : 'short';
    } else {
      if (mode === 'long') cycle = 0;
      mode = 'focus';
    }
    rem = durationOf(mode);
  }
  return t;
}

function addTask(title, est) {
  const task = { id: newId(), title, est, pomos: 0, done: false };
  tasks.push(task);
  if (!activeTaskId) activeTaskId = task.id;
  save();
  renderTasks({ entering: task.id });
}

async function removeTasks(ids, source) {
  const rows = ids
    .map((id) => el.taskList.querySelector(`[data-id="${CSS.escape(id)}"]`))
    .filter(Boolean);
  audio.sfx('remove', source);
  await Promise.all(rows.map((r, i) => new Promise((res) => setTimeout(() => fx.exit(r).then(res), i * 50))));
  const removed = tasks.map((t, i) => ({ t, i })).filter(({ t }) => ids.includes(t.id));
  const prevActive = activeTaskId;
  tasks = tasks.filter((t) => !ids.includes(t.id));
  if (ids.includes(activeTaskId)) activeTaskId = null;
  save();
  renderTasks();
  if (!removed.length) return;

  toast({
    icon: '🗑️',
    title: removed.length === 1 ? 'Task deleted' : `${removed.length} tasks cleared`,
    body: removed.length === 1 ? removed[0].t.title : '',
    duration: 5500,
    action: {
      label: 'Undo',
      onClick: (btn) => {
        removed.forEach(({ t, i }) => {
          if (!tasks.some((x) => x.id === t.id)) tasks.splice(Math.min(i, tasks.length), 0, t);
        });
        if (removed.some(({ t }) => t.id === prevActive)) activeTaskId = prevActive;
        save();
        renderTasks({ entering: removed.map(({ t }) => t.id) });
        audio.sfx('pop', btn);
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Daily goal & achievements

const ACHIEVEMENTS = [
  { id: 'first', icon: '🌱', name: 'First focus', desc: 'Finish your first focus session' },
  { id: 'hattrick', icon: '🎩', name: 'Hat trick', desc: 'Three focus sessions in one day' },
  { id: 'goal', icon: '🎯', name: 'Goal getter', desc: 'Hit your daily goal' },
  { id: 'deep', icon: '🧠', name: 'Deep work', desc: 'Earn a long break' },
  { id: 'streak3', icon: '🔥', name: 'On a roll', desc: 'Focus three days in a row' },
  { id: 'streak7', icon: '⚡', name: 'Unstoppable', desc: 'Focus seven days in a row' },
  { id: 'ten', icon: '🔟', name: 'Ten down', desc: 'Ten focus sessions in total' },
  { id: 'fifty', icon: '🏅', name: 'Half century', desc: 'Fifty focus sessions in total' },
  { id: 'early', icon: '🌅', name: 'Early bird', desc: 'Finish a session before 8 am' },
  { id: 'night', icon: '🦉', name: 'Night owl', desc: 'Finish a session after 10 pm' },
  { id: 'finisher', icon: '✅', name: 'Finisher', desc: 'Complete five tasks' },
  { id: 'explorer', icon: '🎧', name: 'Sound explorer', desc: 'Try every ambient sound' },
  { id: 'cleanslate', icon: '🧹', name: 'Clean slate', desc: 'Finish every task on a list of three or more' },
  { id: 'mixologist', icon: '🎛️', name: 'Mixologist', desc: 'Save your own sound mix' },
  { id: 'orbit', icon: '🪐', name: 'In orbit', desc: 'Send a sound circling around you' },
  { id: 'zen', icon: '🧘', name: 'Zen master', desc: 'Finish a focus session in zen mode' },
  { id: 'marathon', icon: '🏃', name: 'Marathon', desc: 'Four hours of focus in one day' },
];
const GOAL_C = 2 * Math.PI * 15;

function dayTotals(date) {
  const k = dayKey(date);
  let m = 0;
  let s = 0;
  for (const h of history) {
    if (dayKey(new Date(h.t)) !== k) continue;
    m += h.m;
    if (h.s) s += 1;
  }
  return { m, s };
}

function streakDays() {
  const active = new Set(history.filter((h) => h.m > 0).map((h) => dayKey(new Date(h.t))));
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  if (!active.has(dayKey(d))) d.setDate(d.getDate() - 1);
  let n = 0;
  while (active.has(dayKey(d))) {
    n += 1;
    d.setDate(d.getDate() - 1);
  }
  return n;
}

function renderGoal() {
  const { s } = dayTotals(new Date());
  const goal = settings.goal;
  const f = Math.min(1, s / goal);
  el.goalFill.style.strokeDasharray = `${GOAL_C}`;
  el.goalFill.style.strokeDashoffset = `${GOAL_C * (1 - f)}`;
  el.goalCount.textContent = String(s);
  el.goalTarget.textContent = String(goal);
  el.goal.classList.toggle('is-done', s >= goal);
  el.goal.setAttribute('aria-label', `Daily goal: ${s} of ${goal} focus sessions. Open stats.`);
  el.goal.title = s >= goal ? 'Daily goal reached!' : `Daily goal: ${goal} focus sessions`;
}

let celebrationAt = 0;

function unlock(id, { quiet = false, delay = 0 } = {}) {
  if (achievements[id]) return;
  const a = ACHIEVEMENTS.find((x) => x.id === id);
  if (!a) return;
  achievements[id] = Date.now();
  save();
  if (quiet) return;
  // Space out several unlocks so each one gets its own moment.
  const at = Math.max(Date.now() + delay, celebrationAt);
  celebrationAt = at + 1700;
  setTimeout(() => {
    toast({ icon: a.icon, title: `Achievement: ${a.name}`, body: a.desc, tone: 'gold', duration: 5000 });
    audio.fanfare();
    fx.burst({ x: window.innerWidth / 2, y: window.innerHeight - 90 }, {
      count: 26,
      spread: 140,
      gravity: 80,
      size: 8,
      confetti: true,
      colors: ['#ffc94d', '#ffb02e', '#fff1b8', getComputedStyle(document.body).getPropertyValue('--accent').trim()],
    });
  }, at - Date.now());
}

function checkFocusAchievements(endedAt, next, opts = {}) {
  const total = history.filter((h) => h.s).length;
  const today = dayTotals(new Date(endedAt));
  const hour = new Date(endedAt).getHours();
  const streak = streakDays();
  if (total >= 1) unlock('first', opts);
  if (today.s >= 3) unlock('hattrick', opts);
  if (today.s >= settings.goal) unlock('goal', opts);
  if (next === 'long') unlock('deep', opts);
  if (streak >= 3) unlock('streak3', opts);
  if (streak >= 7) unlock('streak7', opts);
  if (total >= 10) unlock('ten', opts);
  if (total >= 50) unlock('fifty', opts);
  if (hour >= 4 && hour < 8) unlock('early', opts);
  if (hour >= 22 || hour < 4) unlock('night', opts);
  if (today.m >= 240) unlock('marathon', opts);
}

function renderBadges() {
  const grid = $('#badge-grid');
  const count = ACHIEVEMENTS.filter((a) => achievements[a.id]).length;
  $('#badge-count').textContent = `${count}/${ACHIEVEMENTS.length}`;
  grid.replaceChildren(
    ...ACHIEVEMENTS.map((a, i) => {
      const li = document.createElement('li');
      const on = Boolean(achievements[a.id]);
      li.className = `badge${on ? ' is-unlocked' : ''}`;
      li.style.setProperty('--delay', `${i * 30}ms`);
      li.tabIndex = 0;
      li.title = a.desc;
      li.setAttribute('aria-label', `${a.name}: ${a.desc}. ${on ? 'Unlocked' : 'Locked'}.`);
      const icon = document.createElement('span');
      icon.className = 'badge-icon';
      icon.textContent = a.icon;
      icon.setAttribute('aria-hidden', 'true');
      const name = document.createElement('span');
      name.className = 'badge-name';
      name.textContent = a.name;
      li.append(icon, name);
      return li;
    }),
  );
}

// ---------------------------------------------------------------------------
// Stats

const dayKey = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

function fmtMinutes(m) {
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h}h ${r}m` : `${h}h`;
}

function niceMax(v) {
  const steps = [30, 60, 90, 120, 180, 240, 300, 360, 480, 600, 720, 960, 1200, 1440];
  return steps.find((s) => s >= v) ?? Math.ceil(v / 60) * 60;
}

function renderStats() {
  const byDay = new Map();
  for (const h of history) {
    const k = dayKey(new Date(h.t));
    const v = byDay.get(k) || { m: 0, s: 0 };
    v.m += h.m;
    v.s += h.s ? 1 : 0;
    byDay.set(k, v);
  }
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayStats = byDay.get(dayKey(today)) || { m: 0, s: 0 };

  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const v = byDay.get(dayKey(d)) || { m: 0, s: 0 };
    days.push({ date: d, m: v.m, s: v.s, today: i === 0 });
  }

  const cursor = new Date(today);
  if (!(todayStats.m > 0)) cursor.setDate(cursor.getDate() - 1);
  let streak = 0;
  while ((byDay.get(dayKey(cursor)) || { m: 0 }).m > 0) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }

  const week = days.reduce((n, d) => n + d.m, 0);
  const total = history.reduce((n, h) => n + h.m, 0);
  const sessions = history.reduce((n, h) => n + (h.s ? 1 : 0), 0);

  fx.countUp($('#stat-today'), fmtMinutes(todayStats.m));
  fx.countUp($('#stat-sessions'), String(todayStats.s));
  fx.countUp($('#stat-streak'), `${streak} ${streak === 1 ? 'day' : 'days'}`);
  fx.countUp($('#stat-week'), fmtMinutes(week));
  let prevWeek = 0;
  for (let i = 7; i < 14; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    prevWeek += (byDay.get(dayKey(d)) || { m: 0 }).m;
  }
  const delta = $('#stat-week-delta');
  if (prevWeek > 0 && week > 0) {
    const pct = Math.round(((week - prevWeek) / prevWeek) * 100);
    delta.textContent = `${pct >= 0 ? '▲' : '▼'} ${Math.abs(pct)}% vs the week before`;
    delta.className = `tile-delta ${pct >= 0 ? 'is-up' : 'is-down'}`;
  } else {
    delta.textContent = week > 0 ? 'Your first week. Nice start!' : '';
    delta.className = 'tile-delta';
  }
  $('#stat-total').textContent = sessions
    ? `All time: ${fmtMinutes(total)} of focus across ${sessions} ${sessions === 1 ? 'session' : 'sessions'}.`
    : 'Finish a focus session to start filling this in.';

  renderChart(days);
  renderHeatmap(byDay);
  renderHours();
  renderLog();
  renderBadges();
}

// Minutes of focus by hour of day, to show when you focus best.
function renderHours() {
  const mins = new Array(24).fill(0);
  for (const h of history) mins[new Date(h.t).getHours()] += h.m;
  const max = Math.max(...mins);
  const peak = mins.indexOf(max);
  const hourName = (h) => new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: 'numeric' });
  $('#hours-note').textContent = max > 0 ? `You focus most around ${hourName(peak)}` : 'Finish a few sessions to see your best hours';
  $('#hours').replaceChildren(
    ...mins.map((m, h) => {
      const bar = document.createElement('span');
      bar.className = `hour${h === peak && max > 0 ? ' is-peak' : ''}${m === 0 ? ' is-zero' : ''}`;
      bar.style.setProperty('--h', `${max ? Math.max(4, (m / max) * 100) : 4}%`);
      bar.style.setProperty('--delay', `${h * 15}ms`);
      const label = `${hourName(h)}: ${fmtMinutes(m)}`;
      bar.title = label;
      bar.setAttribute('role', 'img');
      bar.setAttribute('aria-label', label);
      return bar;
    }),
  );
}

function fmtWhen(ts) {
  const d = new Date(ts);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const day = new Date(d);
  day.setHours(0, 0, 0, 0);
  const diff = Math.round((today - day) / DAY);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (diff === 0) return `Today ${time}`;
  if (diff === 1) return `Yesterday ${time}`;
  return `${d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })} ${time}`;
}

function renderLog() {
  const list = $('#session-log');
  const lastFocus = history.filter((h) => h.s).slice(-20);
  const rated = lastFocus.filter((h) => h.r);
  const parts = [];
  if (rated.length) {
    const avg = Math.round(rated.reduce((n, h) => n + h.r, 0) / rated.length);
    parts.push(`Sessions feel ${RATING_NAMES[avg - 1].toLowerCase()} on average ${RATINGS[avg - 1]}`);
  }
  // Average only over sessions since you started noting distractions.
  const firstNoted = lastFocus.findIndex((h) => h.d);
  const tracked = firstNoted >= 0 ? lastFocus.slice(firstNoted) : [];
  if (tracked.length >= 3) {
    const per = tracked.reduce((n, h) => n + (h.d || 0), 0) / tracked.length;
    parts.push(`${per.toFixed(1)} distractions per session`);
  }
  $('#log-summary').textContent = parts.join(' · ');
  const recent = history.slice(-12).reverse();
  if (!recent.length) {
    const li = document.createElement('li');
    li.className = 'log-empty';
    li.textContent = 'Your finished sessions will appear here.';
    list.replaceChildren(li);
    return;
  }
  list.replaceChildren(
    ...recent.map((h) => {
      const li = document.createElement('li');
      li.className = `log-item${h.s ? '' : ' is-partial'}`;
      const when = document.createElement('span');
      when.className = 'log-when';
      when.textContent = fmtWhen(h.t);
      const what = document.createElement('span');
      what.className = 'log-what';
      what.textContent = h.task || (h.s ? 'Focus session' : 'Focus (ended early)');
      if (h.r || h.d) {
        const meta = document.createElement('span');
        meta.className = 'log-meta';
        meta.textContent = [h.r ? RATINGS[h.r - 1] : '', h.d ? `⚡${h.d}` : ''].filter(Boolean).join(' ');
        meta.title = [h.r ? `Felt ${RATING_NAMES[h.r - 1].toLowerCase()}` : '', h.d ? `${h.d} distraction${h.d === 1 ? '' : 's'}` : ''].filter(Boolean).join(', ');
        what.append(' ', meta);
      }
      const dur = document.createElement('span');
      dur.className = 'log-dur';
      dur.textContent = fmtMinutes(h.m);
      li.append(when, what, dur);
      return li;
    }),
  );
}

function heatLevel(m) {
  if (m <= 0) return 0;
  if (m < 30) return 1;
  if (m < 60) return 2;
  if (m < 120) return 3;
  return 4;
}

function renderHeatmap(byDay) {
  const grid = $('#heatmap');
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const weekday = (today.getDay() + 6) % 7; // Monday = 0
  const start = new Date(today);
  start.setDate(start.getDate() - (7 * 11 + weekday));
  const cells = [];
  let activeDays = 0;
  for (let i = 0; i < 84; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const cell = document.createElement('span');
    if (d > today) {
      cell.className = 'heat is-future';
      cells.push(cell);
      continue;
    }
    const m = (byDay.get(dayKey(d)) || { m: 0 }).m;
    if (m > 0) activeDays += 1;
    cell.className = `heat l${heatLevel(m)}${d.getTime() === today.getTime() ? ' is-today' : ''}`;
    cell.style.setProperty('--delay', `${Math.floor(i / 7) * 25}ms`);
    const label = `${d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}: ${fmtMinutes(m)}`;
    cell.title = label;
    cell.setAttribute('role', 'img');
    cell.setAttribute('aria-label', label);
    cells.push(cell);
  }
  grid.replaceChildren(...cells);
  $('#heat-summary').textContent = `${activeDays} active ${activeDays === 1 ? 'day' : 'days'}`;
}

function renderChart(days) {
  const plot = $('#chart');
  const daysRow = $('#chart-days');
  const tooltip = $('#chart-tooltip');
  const tbody = $('#chart-table tbody');
  const max = Math.max(...days.map((d) => d.m));
  const top = niceMax(max);
  const maxIndex = max > 0 ? days.findIndex((d) => d.m === max) : -1;
  const weekday = (d) => d.toLocaleDateString([], { weekday: 'short' });

  const grid = document.createElement('div');
  grid.className = 'chart-grid';
  const gridLabel = document.createElement('span');
  gridLabel.textContent = fmtMinutes(top);
  grid.appendChild(gridLabel);

  const slots = days.map((d, i) => {
    const slot = document.createElement('div');
    slot.className = 'bar-slot';
    slot.classList.toggle('is-today', d.today);
    slot.tabIndex = 0;
    slot.setAttribute('role', 'img');
    const label = `${d.today ? 'Today' : d.date.toLocaleDateString([], { weekday: 'long' })}: ${fmtMinutes(d.m)}${d.s ? `, ${d.s} ${d.s === 1 ? 'session' : 'sessions'}` : ''}`;
    slot.setAttribute('aria-label', label);
    slot.dataset.tip = label;

    const pct = d.m > 0 ? Math.max(2, (d.m / top) * 100) : 0;
    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.classList.toggle('is-zero', d.m === 0);
    bar.style.height = d.m > 0 ? `${pct}%` : '2px';
    bar.style.setProperty('--delay', `${i * 45}ms`);
    slot.appendChild(bar);

    if (d.m > 0 && (d.today || i === maxIndex)) {
      const v = document.createElement('span');
      v.className = 'bar-value';
      v.style.bottom = `calc(${pct}% + 4px)`;
      v.textContent = fmtMinutes(d.m);
      slot.appendChild(v);
    }
    return slot;
  });
  plot.replaceChildren(grid, ...slots);

  daysRow.replaceChildren(
    ...days.map((d) => {
      const s = document.createElement('span');
      s.textContent = d.today ? 'Today' : weekday(d.date);
      s.classList.toggle('is-today', d.today);
      return s;
    }),
  );

  tbody.replaceChildren(
    ...days.map((d) => {
      const tr = document.createElement('tr');
      const th = document.createElement('th');
      th.scope = 'row';
      th.textContent = d.date.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
      const td = document.createElement('td');
      td.textContent = String(d.m);
      tr.append(th, td);
      return tr;
    }),
  );

  const figure = plot.closest('figure');
  const show = (slot) => {
    const fr = figure.getBoundingClientRect();
    const br = slot.querySelector('.bar').getBoundingClientRect();
    tooltip.textContent = slot.dataset.tip;
    tooltip.hidden = false;
    const half = tooltip.offsetWidth / 2;
    const x = Math.min(Math.max(br.left + br.width / 2 - fr.left, half), fr.width - half);
    tooltip.style.left = `${x}px`;
    tooltip.style.top = `${br.top - fr.top - 8}px`;
  };
  const hide = () => { tooltip.hidden = true; };
  slots.forEach((slot) => {
    slot.addEventListener('pointerenter', () => show(slot));
    slot.addEventListener('pointerleave', hide);
    slot.addEventListener('focus', () => show(slot));
    slot.addEventListener('blur', hide);
  });
  hide();
}

// ---------------------------------------------------------------------------
// Dialogs

function openSheet(dialog, from) {
  if (dialog.open) return;
  dialog.showModal();
  audio.sfx('open', from);
}

function closeSheet(dialog) {
  if (!dialog.open || dialog.classList.contains('is-closing')) return;
  audio.sfx('close', dialog);
  if (!fx.motionOK()) {
    dialog.close();
    return;
  }
  dialog.classList.add('is-closing');
  // A timer rather than animationend: the event can be skipped (background
  // tab, interrupted animation) and a modal must never get stuck open.
  setTimeout(() => {
    dialog.classList.remove('is-closing');
    dialog.close();
  }, 200);
}

$$('dialog.sheet').forEach((dialog) => {
  dialog.addEventListener('cancel', (e) => {
    e.preventDefault();
    closeSheet(dialog);
  });
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog || e.target.closest('[data-close]')) closeSheet(dialog);
  });
});

// ---------------------------------------------------------------------------
// Settings

function fillSettings() {
  const f = el.settingsForm;
  for (const k of Object.keys(LIMITS)) f.elements[k].value = settings[k];
  for (const k of ['autoBreaks', 'autoFocus', 'breathing', 'chime', 'sfx', 'notify', 'wakeLock', 'scenery', 'soundsWithTimer']) f.elements[k].checked = settings[k];
  f.elements.theme.value = settings.theme;
  f.elements.palette.value = settings.palette;
  f.elements.chimeStyle.value = settings.chimeStyle;
  markPreset();
}

function markPreset() {
  const current = `${settings.focus},${settings.short},${settings.long}`;
  $$('.preset[data-preset]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.preset === current)));
}

$$('.preset[data-preset]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const [focus, short, long] = btn.dataset.preset.split(',').map(Number);
    Object.assign(settings, { focus, short, long });
    const f = el.settingsForm;
    f.elements.focus.value = focus;
    f.elements.short.value = short;
    f.elements.long.value = long;
    markPreset();
    audio.sfx('pop', btn);
    fx.pop(btn, 1.06);
    ['focus', 'short', 'long'].forEach((k) => fx.pop(f.elements[k], 1.06));
    applyMode();
    renderSummary();
    save();
  });
});

el.settingsForm.addEventListener('submit', (e) => {
  e.preventDefault();
  closeSheet(el.settingsDialog);
});

el.settingsForm.addEventListener('change', async (e) => {
  const input = e.target;
  const name = input.name;
  if (name in LIMITS) {
    const [min, max] = LIMITS[name];
    settings[name] = clampInt(input.value, min, max, settings[name]);
    input.value = settings[name];
    audio.sfx('tick', input);
    applyMode();
    renderSummary();
    renderGoal();
    markPreset();
  } else if (name === 'theme') {
    settings.theme = input.value;
    applyTheme();
    audio.sfx('pop', input.closest('label'));
  } else if (name === 'chimeStyle') {
    settings.chimeStyle = input.value;
    audio.chime('break', settings.chimeStyle);
  } else if (name === 'palette') {
    settings.palette = input.value;
    applyTheme();
    audio.sfx('pop', input.closest('label'));
    fx.burst(input.closest('label'), { count: 10, spread: 34, size: 5 });
  } else if (input.type === 'checkbox') {
    settings[name] = input.checked;
    if (name === 'sfx') audio.setSfxEnabled(settings.sfx);
    audio.sfx(input.checked ? 'on' : 'off', input);
    if (name === 'notify' && input.checked) {
      const ok = await askNotificationPermission();
      if (!ok) {
        settings.notify = false;
        input.checked = false;
        fx.nudge(input.closest('label'));
        announce('Notifications are blocked for this site. You can allow them in your browser settings.');
      }
    }
    if (name === 'wakeLock') syncWakeLock();
    if (name === 'breathing') renderTimer(true);
    if (name === 'scenery') {
      scenery.setEnabled(settings.scenery);
      syncSoundGate();
    }
    if (name === 'soundsWithTimer') syncSoundGate();
  }
  save();
});

async function askNotificationPermission() {
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  try {
    return (await Notification.requestPermission()) === 'granted';
  } catch {
    return false;
  }
}

if (!('wakeLock' in navigator)) $('#wake-row').hidden = true;
if (!('Notification' in window)) $('#notify-row').hidden = true;

$('#btn-test-chime').addEventListener('click', () => audio.chime('break', settings.chimeStyle));
$('#btn-test-chime-2').addEventListener('click', () => audio.chime('break', settings.chimeStyle));

$('#btn-export').addEventListener('click', (e) => {
  save();
  let data = {};
  try { data = JSON.parse(localStorage.getItem(STORE_KEY) || '{}'); } catch { /* empty */ }
  const blob = new Blob([JSON.stringify({ app: 'tempo', version: 1, exportedAt: new Date().toISOString(), data }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `tempo-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  audio.sfx('pop', e.currentTarget);
  toast({ icon: '💾', title: 'Backup saved', body: a.download });
});

$('#import-file').addEventListener('change', async (e) => {
  const input = e.currentTarget;
  const file = input.files && input.files[0];
  input.value = '';
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    const data = parsed && parsed.app === 'tempo' ? parsed.data : parsed;
    if (!data || typeof data !== 'object' || Array.isArray(data) || !('settings' in data || 'tasks' in data || 'history' in data)) {
      throw new Error('not a Tempo backup');
    }
    if (!window.confirm('Replace your current tasks, stats and settings with this backup?')) return;
    localStorage.setItem(STORE_KEY, JSON.stringify(data));
    window.location.reload();
  } catch {
    fx.nudge($('#import-label'));
    toast({ icon: '⚠️', title: "That file isn't a Tempo backup", body: 'Choose a .json file saved with Export backup.' });
  }
});

$('#btn-reset-data').addEventListener('click', () => {
  if (!window.confirm('Erase all tasks, stats and settings? This cannot be undone.')) return;
  try { localStorage.removeItem(STORE_KEY); } catch { /* ignore */ }
  window.location.reload();
});

// ---------------------------------------------------------------------------
// Ambient sound: a mixer of layers you can place around you in a 3D room

const SOUND_INFO = {
  rain: { icon: '🌧️', name: 'Rain' },
  waves: { icon: '🌊', name: 'Waves' },
  fire: { icon: '🔥', name: 'Fireplace' },
  night: { icon: '🦗', name: 'Night' },
  clock: { icon: '🕰️', name: 'Clock' },
  brown: { icon: '🟤', name: 'Brown noise' },
  fan: { icon: '🌀', name: 'Fan' },
  lofi: { icon: '🎹', name: 'Lo-fi' },
  binaural: { icon: '〰️', name: 'Binaural', fixed: true },
  wind: { icon: '🍃', name: 'Wind' },
  stream: { icon: '💧', name: 'Stream' },
};
const ROOM_R = 4; // metres from you to the edge of the room
const ROOM_SPAN = 44; // % of the pad from its centre to that edge

let ambientStarted = false;
let gatedHintShown = false;
let mutedKinds = [];

const activeKinds = () => audio.ambientKinds.filter((k) => sound.mix[k] && sound.mix[k].on);
const layerOpts = (k) => ({ volume: sound.mix[k].vol, x: sound.mix[k].x, z: sound.mix[k].z });

function renderChips() {
  const on = activeKinds();
  el.chips.forEach((c) => {
    const kind = c.dataset.sound;
    const pressed = kind === 'off' ? on.length === 0 : on.includes(kind);
    c.setAttribute('aria-pressed', String(pressed));
    c.classList.toggle('is-live', kind !== 'off' && pressed && ambientStarted);
  });
}

function startAmbientIfPending() {
  if (ambientStarted) return;
  const kinds = activeKinds();
  if (!kinds.length) return;
  ambientStarted = true;
  kinds.forEach((k) => audio.setLayer(k, true, layerOpts(k)));
  wakeGlow();
  renderChips();
}

function setSound(kind, on) {
  if (on) {
    const [dx, dz] = audio.defaultAnchor(kind);
    sound.mix[kind] = { vol: kind === 'binaural' ? 0.5 : 0.8, x: dx, z: dz, orbit: false, ...(sound.mix[kind] || {}), on: true };
    if (!counters.soundsTried.includes(kind)) {
      counters.soundsTried.push(kind);
      if (audio.ambientKinds.every((k) => counters.soundsTried.includes(k))) unlock('explorer', { delay: 600 });
    }
  } else if (sound.mix[kind]) {
    sound.mix[kind].on = false;
  }
  startAmbientIfPending();
  ambientStarted = ambientStarted || on;
  audio.setLayer(kind, on, on ? layerOpts(kind) : undefined);
  if (on && settings.soundsWithTimer && !timer.running && !gatedHintShown) {
    gatedHintShown = true;
    toast({
      icon: '⏯️',
      title: 'Sounds start with the timer',
      body: 'You chose to hear ambient sound only while the timer runs.',
      duration: 6000,
      action: { label: 'Start', onClick: () => { if (!timer.running) toggleTimer(el.toggle); } },
    });
  }
  afterSoundChange();
}

function afterSoundChange() {
  // Remember the last thing that was playing, so M can bring it back.
  const playing = activeKinds();
  if (playing.length) sound.last = playing;
  renderMixes();
  syncSoundGate();
  syncOrbit();
  wakeGlow();
  renderChips();
  renderMixer();
  save();
}

el.chips.forEach((chip) => {
  chip.addEventListener('click', () => {
    const kind = chip.dataset.sound;
    audio.unlock();
    fx.pop(chip, 1.08);
    if (kind === 'off') {
      audio.sfx('off', chip);
      activeKinds().forEach((k) => setSound(k, false));
      afterSoundChange();
      return;
    }
    const on = !(sound.mix[kind] && sound.mix[kind].on);
    audio.sfx(on ? 'pop' : 'off', chip);
    setSound(kind, on);
  });
});

function toggleMute() {
  const on = activeKinds();
  if (on.length) {
    mutedKinds = on;
    on.forEach((k) => setSound(k, false));
    toast({ icon: '🔇', title: 'Ambient sound off', body: 'Press M to bring it back', duration: 2200 });
  } else {
    const remembered = (Array.isArray(sound.last) ? sound.last : []).filter((k) => audio.ambientKinds.includes(k));
    const back = mutedKinds.length ? mutedKinds : remembered.length ? remembered : ['rain'];
    back.forEach((k) => setSound(k, true));
    toast({ icon: '🔊', title: `${back.map((k) => SOUND_INFO[k].name).join(' + ')} back on`, duration: 2000 });
  }
}

// ----- Mixer rows and the room ---------------------------------------------

function orbPosition(k) {
  const m = sound.mix[k];
  return { left: `${50 + (m.x / ROOM_R) * ROOM_SPAN}%`, top: `${50 + (m.z / ROOM_R) * ROOM_SPAN}%` };
}

function describePosition(m) {
  const dist = Math.hypot(m.x, m.z);
  if (dist < 0.6) return 'all around you';
  const angle = (Math.atan2(m.x, -m.z) * 180) / Math.PI; // 0 = ahead, 90 = right
  const dirs = ['ahead', 'ahead right', 'to your right', 'behind right', 'behind you', 'behind left', 'to your left', 'ahead left'];
  const dir = dirs[Math.round(((angle + 360) % 360) / 45) % 8];
  return `${dist.toFixed(1)} m ${dir}`;
}

function renderMixer() {
  const kinds = activeKinds();
  el.mixer.hidden = kinds.length === 0;
  el.mixList.replaceChildren(
    ...kinds.map((k) => {
      const m = sound.mix[k];
      const row = document.createElement('div');
      row.className = 'mix-row';
      row.dataset.kind = k;
      const name = document.createElement('span');
      name.className = 'mix-name';
      name.textContent = `${SOUND_INFO[k].icon} ${SOUND_INFO[k].name}`;
      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = '0';
      slider.max = '100';
      slider.value = String(Math.round(m.vol * 100));
      slider.className = 'mix-vol';
      slider.style.setProperty('--fill', `${slider.value}%`);
      slider.setAttribute('aria-label', `${SOUND_INFO[k].name} volume`);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'mix-remove pressable';
      remove.setAttribute('aria-label', `Turn off ${SOUND_INFO[k].name}`);
      remove.innerHTML = ICON_X;
      let orbit;
      if (SOUND_INFO[k].fixed) {
        orbit = document.createElement('span');
        orbit.className = 'mix-note';
        orbit.textContent = 'headphones';
      } else {
        orbit = document.createElement('button');
        orbit.type = 'button';
        orbit.className = 'mix-orbit pressable';
        orbit.setAttribute('aria-pressed', String(Boolean(m.orbit)));
        orbit.setAttribute('aria-label', `Orbit ${SOUND_INFO[k].name} around you`);
        orbit.title = 'Orbit around you';
        orbit.innerHTML = ICON_ORBIT;
      }
      row.append(name, orbit, slider, remove);
      return row;
    }),
  );

  const orbs = kinds.filter((k) => !SOUND_INFO[k].fixed).map((k) => {
    const m = sound.mix[k];
    const orb = document.createElement('button');
    orb.type = 'button';
    orb.className = `orb${m.orbit ? ' is-orbiting' : ''}`;
    orb.dataset.kind = k;
    orb.textContent = SOUND_INFO[k].icon;
    Object.assign(orb.style, orbPosition(k));
    orb.title = `${SOUND_INFO[k].name}: drag to move, double-click to reset`;
    orb.setAttribute('aria-label', `${SOUND_INFO[k].name}, ${describePosition(m)}. Use arrow keys to move it.`);
    return orb;
  });
  el.room.querySelectorAll('.orb').forEach((o) => o.remove());
  el.room.append(...orbs);
}

// Orbiting sounds circle your head, one lap every 30 seconds.
const ORBIT_LAP = 30;
let orbitTimer = 0;
let orbitSavedAt = 0;
const dragging = new Set();

function syncOrbit() {
  const any = activeKinds().some((k) => sound.mix[k].orbit && !SOUND_INFO[k].fixed);
  if (any && !orbitTimer) orbitTimer = setInterval(orbitStep, 100);
  if (!any && orbitTimer) {
    clearInterval(orbitTimer);
    orbitTimer = 0;
    save();
  }
}

function orbitStep() {
  const step = ((Math.PI * 2) / ORBIT_LAP) * 0.1;
  for (const k of activeKinds()) {
    const m = sound.mix[k];
    if (!m.orbit || SOUND_INFO[k].fixed || dragging.has(k)) continue;
    const r = Math.max(1, Math.hypot(m.x, m.z));
    const a = Math.atan2(m.z, m.x) + step;
    moveSound(k, Math.cos(a) * r, Math.sin(a) * r);
  }
  if (Date.now() - orbitSavedAt > 5000) {
    orbitSavedAt = Date.now();
    save();
  }
}

// ----- Ready-made and saved mixes -----------------------------------------

const BUILT_IN_MIXES = [
  { id: 'cabin', icon: '🏡', name: 'Cozy cabin', mix: { rain: { vol: 0.7, x: -2.2, z: -1.6 }, fire: { vol: 0.85, x: 1.8, z: -1.4 }, clock: { vol: 0.45, x: -3.2, z: 0.4 } } },
  { id: 'seaside', icon: '🏖️', name: 'Seaside', mix: { waves: { vol: 0.9, x: 0, z: -3.2 }, brown: { vol: 0.25, x: 0, z: 2.4 } } },
  { id: 'campfire', icon: '🏕️', name: 'Campfire night', mix: { night: { vol: 0.8, x: 0, z: 1.5 }, fire: { vol: 0.9, x: 0, z: -1.6 } } },
  { id: 'cafe', icon: '☕', name: 'Rainy café', mix: { lofi: { vol: 0.7, x: 0, z: -2 }, rain: { vol: 0.55, x: -2, z: 1.8 } } },
  { id: 'deep', icon: '🧠', name: 'Deep focus', mix: { brown: { vol: 0.6, x: 0, z: 2.4 }, binaural: { vol: 0.4, x: 0, z: 0 } } },
  { id: 'stars', icon: '🌌', name: 'Starry beats', mix: { lofi: { vol: 0.6, x: 0, z: -2 }, night: { vol: 0.55, x: -2.2, z: 2 } } },
];
sound.presets = (Array.isArray(sound.presets) ? sound.presets : [])
  .filter((p) => p && typeof p.name === 'string' && p.mix && typeof p.mix === 'object')
  .slice(0, 12);

const allMixes = () => [...BUILT_IN_MIXES, ...sound.presets.map((p) => ({ ...p, icon: '⭐', custom: true }))];

function mixMatches(m) {
  const want = Object.keys(m.mix).sort().join();
  return want === activeKinds().sort().join();
}

function renderMixes() {
  el.mixes.replaceChildren(
    ...allMixes().map((m) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'mix-card pressable';
      b.dataset.mix = m.id;
      b.setAttribute('aria-pressed', String(mixMatches(m)));
      const icon = document.createElement('span');
      icon.className = 'mix-icon';
      icon.textContent = m.icon;
      icon.setAttribute('aria-hidden', 'true');
      const name = document.createElement('span');
      name.textContent = m.name;
      b.append(icon, name);
      b.title = Object.keys(m.mix).map((k) => (SOUND_INFO[k] ? SOUND_INFO[k].name : k)).join(' + ');
      if (!m.custom) return b;
      const wrap = document.createElement('span');
      wrap.className = 'mix-card-wrap';
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'mix-del pressable';
      del.dataset.del = m.id;
      del.setAttribute('aria-label', `Delete the mix "${m.name}"`);
      del.title = 'Delete this mix';
      del.innerHTML = ICON_X;
      wrap.append(b, del);
      return wrap;
    }),
  );
}

function applyMix(m, source) {
  audio.unlock();
  const want = m.mix;
  for (const k of audio.ambientKinds) {
    if (want[k]) {
      const [dx, dz] = audio.defaultAnchor(k);
      const w = want[k];
      sound.mix[k] = { vol: clampNum(w.vol, 0, 1, 0.8), x: clampNum(w.x, -4, 4, dx), z: clampNum(w.z, -4, 4, dz), orbit: Boolean(w.orbit), on: false };
      setSound(k, true);
    } else if (sound.mix[k] && sound.mix[k].on) {
      setSound(k, false);
    }
  }
  audio.sfx('pop', source);
  fx.burst(source, { count: 12, spread: 50, size: 6 });
  afterSoundChange();
}

el.mixes.addEventListener('click', (e) => {
  const del = e.target.closest('.mix-del');
  if (del) {
    deleteMix(del.dataset.del, del);
    return;
  }
  const card = e.target.closest('.mix-card');
  if (!card) return;
  const m = allMixes().find((x) => x.id === card.dataset.mix);
  if (m) applyMix(m, card);
});

function deleteMix(id, source) {
  const i = sound.presets.findIndex((p) => p.id === id);
  if (i < 0) return;
  const [gone] = sound.presets.splice(i, 1);
  audio.sfx('remove', source);
  save();
  renderMixes();
  toast({
    icon: '⭐',
    title: `Deleted "${gone.name}"`,
    action: { label: 'Undo', onClick: () => { sound.presets.splice(i, 0, gone); save(); renderMixes(); } },
  });
}

const saveForm = $('#save-mix');
const saveBtn = $('#btn-save-mix');
saveBtn.addEventListener('click', () => {
  saveBtn.hidden = true;
  saveForm.hidden = false;
  $('#save-mix-name').value = '';
  $('#save-mix-name').focus();
});
saveForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('#save-mix-name').value.trim();
  const kinds = activeKinds();
  if (!name || !kinds.length) {
    fx.nudge(saveForm);
    return;
  }
  const mix = Object.fromEntries(kinds.map((k) => [k, { vol: sound.mix[k].vol, x: sound.mix[k].x, z: sound.mix[k].z, orbit: sound.mix[k].orbit }]));
  sound.presets.push({ id: newId(), name: name.slice(0, 24), mix });
  if (sound.presets.length > 12) sound.presets.shift();
  save();
  saveForm.hidden = true;
  saveBtn.hidden = false;
  renderMixes();
  audio.sfx('check', saveBtn);
  unlock('mixologist', { delay: 1200 });
  toast({ icon: '⭐', title: `Saved "${name}"`, body: 'Find it with the mixes above.' });
});
saveForm.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.stopPropagation();
    saveForm.hidden = true;
    saveBtn.hidden = false;
  }
});

// ----- Sleep timer: fade the sounds out after a while --------------------------

let sleepAt = 0;
let sleepTimer = 0;
let sleepTick = 0;
const sleepSelect = $('#sleep-select');
const sleepLabel = $('#sleep-label');

function renderSleep() {
  if (!sleepAt) {
    sleepLabel.textContent = 'Sleep timer';
    return;
  }
  const mins = Math.max(1, Math.ceil((sleepAt - Date.now()) / 60000));
  sleepLabel.textContent = `Stops in ${mins} min`;
}

function setSleep(minutes) {
  clearTimeout(sleepTimer);
  clearInterval(sleepTick);
  sleepAt = minutes ? Date.now() + minutes * 60000 : 0;
  if (minutes) {
    sleepTimer = setTimeout(() => {
      mutedKinds = activeKinds();
      mutedKinds.forEach((k) => setSound(k, false));
      setSleep(0);
      sleepSelect.value = '0';
      toast({ icon: '🌙', title: 'Sounds faded out', body: 'Press M to bring them back.' });
    }, minutes * 60000);
    sleepTick = setInterval(renderSleep, 20000);
  }
  renderSleep();
}

sleepSelect.addEventListener('change', () => {
  setSleep(Number(sleepSelect.value));
  audio.sfx(Number(sleepSelect.value) ? 'on' : 'off', sleepSelect);
});

function moveSound(k, x, z) {
  const r = Math.hypot(x, z);
  if (r > ROOM_R) {
    x = (x / r) * ROOM_R;
    z = (z / r) * ROOM_R;
  }
  sound.mix[k].x = Math.round(x * 100) / 100;
  sound.mix[k].z = Math.round(z * 100) / 100;
  audio.moveLayer(k, sound.mix[k].x, sound.mix[k].z);
  const orb = el.room.querySelector(`.orb[data-kind="${k}"]`);
  if (orb) {
    Object.assign(orb.style, orbPosition(k));
    orb.setAttribute('aria-label', `${SOUND_INFO[k].name}, ${describePosition(sound.mix[k])}. Use arrow keys to move it.`);
  }
}

el.mixList.addEventListener('input', (e) => {
  if (!e.target.matches('.mix-vol')) return;
  const k = e.target.closest('.mix-row').dataset.kind;
  sound.mix[k].vol = Number(e.target.value) / 100;
  e.target.style.setProperty('--fill', `${e.target.value}%`);
  audio.setLayerVolume(k, sound.mix[k].vol);
});
el.mixList.addEventListener('change', (e) => {
  if (!e.target.matches('.mix-vol')) return;
  audio.sfx('tick', e.target);
  save();
});
el.mixList.addEventListener('click', (e) => {
  const orbitBtn = e.target.closest('.mix-orbit');
  if (orbitBtn) {
    const k = orbitBtn.closest('.mix-row').dataset.kind;
    const m = sound.mix[k];
    m.orbit = !m.orbit;
    if (m.orbit && Math.hypot(m.x, m.z) < 1) moveSound(k, 0, -2);
    if (m.orbit) unlock('orbit', { delay: 800 });
    orbitBtn.setAttribute('aria-pressed', String(m.orbit));
    el.room.querySelector(`.orb[data-kind="${k}"]`)?.classList.toggle('is-orbiting', m.orbit);
    audio.sfx(m.orbit ? 'on' : 'off', orbitBtn);
    fx.pop(orbitBtn, 1.15);
    syncOrbit();
    save();
    return;
  }
  const btn = e.target.closest('.mix-remove');
  if (!btn) return;
  audio.sfx('off', btn);
  setSound(btn.closest('.mix-row').dataset.kind, false);
});

el.room.addEventListener('pointerdown', (e) => {
  const orb = e.target.closest('.orb');
  if (!orb || e.button > 0) return;
  e.preventDefault();
  const k = orb.dataset.kind;
  orb.setPointerCapture(e.pointerId);
  orb.classList.add('is-dragging');
  dragging.add(k);
  audio.unlock();
  startAmbientIfPending();
  audio.sfx('tap', orb);
  const rect = el.room.getBoundingClientRect();
  const scale = (rect.width * ROOM_SPAN) / 100;
  const move = (ev) => {
    const x = ((ev.clientX - (rect.left + rect.width / 2)) / scale) * ROOM_R;
    const z = ((ev.clientY - (rect.top + rect.height / 2)) / scale) * ROOM_R;
    moveSound(k, x, z);
  };
  const up = () => {
    orb.removeEventListener('pointermove', move);
    orb.removeEventListener('pointerup', up);
    orb.removeEventListener('pointercancel', up);
    orb.classList.remove('is-dragging');
    dragging.delete(k);
    audio.sfx('pop', orb);
    save();
  };
  orb.addEventListener('pointermove', move);
  orb.addEventListener('pointerup', up);
  orb.addEventListener('pointercancel', up);
});

el.room.addEventListener('dblclick', (e) => {
  const orb = e.target.closest('.orb');
  if (!orb) return;
  const [dx, dz] = audio.defaultAnchor(orb.dataset.kind);
  moveSound(orb.dataset.kind, dx, dz);
  fx.pop(orb, 1.25);
  audio.sfx('pop', orb);
  save();
});

el.room.addEventListener('keydown', (e) => {
  const orb = e.target.closest('.orb');
  const step = { ArrowLeft: [-0.3, 0], ArrowRight: [0.3, 0], ArrowUp: [0, -0.3], ArrowDown: [0, 0.3] }[e.key];
  if (!orb || !step) return;
  e.preventDefault();
  const m = sound.mix[orb.dataset.kind];
  moveSound(orb.dataset.kind, m.x + step[0], m.z + step[1]);
  audio.sfx('tick', orb);
  save();
});

// ----- Turning around in the room ------------------------------------------

let yaw = 0;
const youEl = $('#room-you');
const trackBtn = $('#btn-track');

function setYaw(rad, { announce: say = false } = {}) {
  yaw = Math.atan2(Math.sin(rad), Math.cos(rad)); // keep within -π..π
  audio.setListenerYaw(yaw);
  const deg = Math.round((yaw * 180) / Math.PI);
  youEl.style.setProperty('--yaw', `${deg}deg`);
  youEl.setAttribute('aria-valuenow', String(deg));
  const text = Math.abs(deg) < 8 ? 'straight ahead' : `${Math.abs(deg)} degrees to the ${deg > 0 ? 'right' : 'left'}`;
  youEl.setAttribute('aria-valuetext', text);
  if (say) announce(`Facing ${text}`);
}

youEl.addEventListener('pointerdown', (e) => {
  if (e.button > 0) return;
  e.preventDefault();
  e.stopPropagation();
  youEl.setPointerCapture(e.pointerId);
  youEl.classList.add('is-turning');
  audio.unlock();
  startAmbientIfPending();
  const rect = el.room.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const move = (ev) => setYaw(Math.atan2(ev.clientX - cx, -(ev.clientY - cy)));
  const up = () => {
    youEl.removeEventListener('pointermove', move);
    youEl.removeEventListener('pointerup', up);
    youEl.removeEventListener('pointercancel', up);
    youEl.classList.remove('is-turning');
  };
  youEl.addEventListener('pointermove', move);
  youEl.addEventListener('pointerup', up);
  youEl.addEventListener('pointercancel', up);
});
youEl.addEventListener('dblclick', () => {
  setYaw(0, { announce: true });
  audio.sfx('pop', youEl);
});
youEl.addEventListener('keydown', (e) => {
  const step = { ArrowLeft: -15, ArrowRight: 15, ArrowDown: 15, ArrowUp: -15 }[e.key];
  if (e.key === 'Home') setYaw(0, { announce: true });
  else if (step) setYaw(yaw + (step * Math.PI) / 180, { announce: true });
  else return;
  e.preventDefault();
  audio.sfx('tick', youEl);
});

// Phones: turn with the phone and the sounds stay put in the room.
let tracking = false;
let alpha0 = null;
let trackRaf = 0;
let latestAlpha = null;

function onOrientation(e) {
  if (e.alpha == null) return;
  latestAlpha = e.alpha;
  if (alpha0 == null) alpha0 = e.alpha;
  if (trackRaf) return;
  trackRaf = requestAnimationFrame(() => {
    trackRaf = 0;
    // Turning left raises alpha; facing right is a positive yaw.
    setYaw((-(latestAlpha - alpha0) * Math.PI) / 180);
  });
}

async function setTracking(on) {
  if (on && typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
    try {
      if ((await DeviceOrientationEvent.requestPermission()) !== 'granted') on = false;
    } catch {
      on = false;
    }
  }
  tracking = on;
  alpha0 = null;
  cancelAnimationFrame(trackRaf);
  trackRaf = 0;
  trackBtn.setAttribute('aria-pressed', String(on));
  el.room.classList.toggle('is-tracking', on);
  if (on) {
    window.addEventListener('deviceorientation', onOrientation);
    toast({ icon: '🧭', title: 'Turn with your phone', body: 'Hold it in front of you and turn around. The sounds stay where they are.' });
  } else {
    window.removeEventListener('deviceorientation', onOrientation);
    setYaw(0);
  }
}

if ('DeviceOrientationEvent' in window && window.matchMedia('(pointer: coarse)').matches) trackBtn.hidden = false;
trackBtn.addEventListener('click', () => {
  audio.sfx(tracking ? 'off' : 'on', trackBtn);
  setTracking(!tracking);
});

el.volume.value = String(sound.volume);
audio.setAmbientVolume(sound.volume / 100);
el.volume.style.setProperty('--fill', `${sound.volume}%`);
el.volume.addEventListener('input', () => {
  sound.volume = Number(el.volume.value);
  el.volume.style.setProperty('--fill', `${sound.volume}%`);
  audio.setAmbientVolume(sound.volume / 100);
});
el.volume.addEventListener('change', () => {
  audio.sfx('tick', el.volume);
  save();
});

// ---------------------------------------------------------------------------
// Phones: app-style sections with a bottom navigation bar

const VIEWS = ['timer', 'sounds', 'tasks'];
const navBtns = $$('.nav-btn');
const phoneLayout = window.matchMedia('(max-width: 760px)');

function setView(view, { scroll = true } = {}) {
  if (!VIEWS.includes(view)) view = 'timer';
  const changed = el.body.dataset.view !== view;
  el.body.dataset.view = view;
  navBtns.forEach((b) => {
    if (b.dataset.view === view) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  $('#bottom-nav').style.setProperty('--i', String(VIEWS.indexOf(view)));
  if (changed && phoneLayout.matches) {
    const target = view === 'timer' ? $('.timer-card') : view === 'sounds' ? $('.sounds-panel') : $('.tasks-panel');
    fx.enter(target);
    if (scroll) window.scrollTo({ top: 0 });
  }
}

navBtns.forEach((b) => {
  b.addEventListener('click', () => {
    if (b.getAttribute('aria-current') === 'page') {
      fx.pop(b, 1.08);
      return;
    }
    audio.sfx('tap', b);
    fx.haptic(6);
    setView(b.dataset.view);
  });
});

$('#mini-main').addEventListener('click', (e) => {
  audio.sfx('tap', e.currentTarget);
  setView('timer');
});
$('#mini-toggle').addEventListener('click', (e) => toggleTimer(e.currentTarget));

// ---------------------------------------------------------------------------
// Wiring

function toggleTimer(source) {
  audio.unlock();
  if (timer.running) {
    pause();
    audio.sfx('pause', source);
  } else {
    start();
    audio.sfx('start', source);
    fx.burst(el.toggle, { count: 12, spread: 70, size: 6 });
  }
  fx.pop(el.toggle, 1.06);
}

el.toggle.addEventListener('click', () => toggleTimer(el.toggle));

el.reset.addEventListener('click', () => {
  if (isFresh()) {
    fx.nudge(el.reset);
    audio.sfx('off', el.reset);
    return;
  }
  reset();
  audio.sfx('off', el.reset);
  el.reset.classList.remove('spin');
  void el.reset.offsetWidth;
  el.reset.classList.add('spin');
});

el.zen.addEventListener('click', () => setZen(!isZen()));
el.extend.addEventListener('click', () => addTime(60000, el.extend));
el.distract.addEventListener('click', () => noteDistraction(el.distract));
el.pip.hidden = !pip.supported();
el.pip.addEventListener('click', togglePip);

el.skip.addEventListener('click', () => {
  skip();
  audio.sfx('pop', el.skip);
  fx.burst(el.skip, { count: 8, spread: 40, size: 5 });
});

el.tabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    const mode = tab.dataset.mode;
    if (mode === timer.mode) {
      fx.pop(tab, 1.05);
      return;
    }
    const elapsed = totalMs() - remainingMs();
    if (timer.running && elapsed > 5000 && !window.confirm('The timer is running. Switch anyway?')) return;
    audio.sfx('tap', tab);
    switchTo(mode);
  });
});

el.taskForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const title = el.taskInput.value.trim();
  if (!title) {
    fx.nudge(el.taskForm);
    return;
  }
  const est = clampInt(el.taskEst.value, 1, 20, 1);
  addTask(title, est);
  const addBtn = $('.add-btn', el.taskForm);
  audio.sfx('pop', addBtn);
  fx.pop(addBtn, 1.15);
  fx.burst(addBtn, { count: 10, spread: 44, size: 5 });
  el.taskInput.value = '';
  el.taskEst.value = '1';
  el.taskInput.focus();
});

el.taskEst.addEventListener('change', () => audio.sfx('tick', el.taskEst));

el.taskList.addEventListener('change', (e) => {
  if (!e.target.matches('.task-check')) return;
  const li = e.target.closest('.task');
  const task = tasks.find((t) => t.id === li.dataset.id);
  if (!task) return;
  task.done = e.target.checked;
  if (task.done) {
    if (!task.counted) {
      task.counted = true;
      counters.tasksDone += 1;
      if (counters.tasksDone >= 5) unlock('finisher', { delay: 500 });
    }
    audio.sfx('check', e.target);
    fx.burst(e.target, { count: 12, spread: 34, size: 5 });
    if (activeTaskId === task.id) activeTaskId = tasks.find((t) => !t.done)?.id ?? null;
    if (tasks.length >= 2 && tasks.every((t) => t.done)) {
      setTimeout(() => {
        fx.celebrate(el.taskList);
        audio.fanfare();
        toast({ icon: '🎉', title: 'All tasks done!', body: 'That whole list is finished. Take a moment to enjoy it.', tone: 'gold' });
      }, 350);
      if (tasks.length >= 3) unlock('cleanslate', { delay: 2600 });
    }
  } else {
    audio.sfx('uncheck', e.target);
  }
  save();
  renderTasks();
  const again = el.taskList.querySelector(`[data-id="${CSS.escape(task.id)}"] .task-check`);
  if (again) {
    again.focus();
    fx.pop(again, 1.3);
  }
});

el.taskList.addEventListener('click', (e) => {
  const li = e.target.closest('.task');
  if (!li) return;
  const id = li.dataset.id;
  if (e.target.closest('.task-delete')) {
    removeTasks([id], e.target.closest('.task-delete'));
    return;
  }
  if (e.target.closest('.task-edit-btn')) {
    startEdit(li);
    return;
  }
  const select = e.target.closest('.task-select');
  if (select) {
    activeTaskId = activeTaskId === id ? null : id;
    audio.sfx(activeTaskId ? 'on' : 'off', select);
    save();
    renderTasks();
    const row = el.taskList.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (row) {
      fx.pop(row, 1.02);
      row.querySelector('.task-select').focus();
    }
  }
});

el.taskList.addEventListener('dblclick', (e) => {
  const li = e.target.closest('.task');
  if (li && e.target.closest('.task-title')) startEdit(li);
});

el.clearDone.addEventListener('click', () => {
  removeTasks(tasks.filter((t) => t.done).map((t) => t.id), el.clearDone);
});

el.goal.addEventListener('click', (e) => {
  renderStats();
  openSheet(el.statsDialog, e.currentTarget);
});

$('#btn-help').addEventListener('click', (e) => openSheet(el.helpDialog, e.currentTarget));
$('#btn-open-help').addEventListener('click', (e) => {
  closeSheet(el.settingsDialog);
  setTimeout(() => openSheet(el.helpDialog, e.target), 220);
});

// Stats tabs
const statTabs = $$('#stats-dialog [role="tab"]');
let statTab = 0;

function selectStatTab(i, { focus = false, animate = true } = {}) {
  statTab = (i + statTabs.length) % statTabs.length;
  statTabs.forEach((t, n) => {
    const on = n === statTab;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
    const panel = $(`#${t.getAttribute('aria-controls')}`);
    panel.hidden = !on;
    if (on && animate) fx.enter(panel);
  });
  $('#stats-dialog .tabs').style.setProperty('--i', String(statTab));
  if (focus) statTabs[statTab].focus();
}

statTabs.forEach((t, i) => {
  t.addEventListener('click', () => {
    if (i === statTab) return;
    audio.sfx('tap', t);
    selectStatTab(i);
  });
  t.addEventListener('keydown', (e) => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    if (step) {
      e.preventDefault();
      audio.sfx('tick', t);
      selectStatTab(statTab + step, { focus: true });
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      selectStatTab(e.key === 'Home' ? 0 : statTabs.length - 1, { focus: true });
    }
  });
});

// First visit: a short welcome.
function maybeWelcome() {
  if (settings.welcomed) return;
  settings.welcomed = true;
  save();
  setTimeout(() => openSheet($('#welcome-dialog'), el.toggle), 700);
}
$('#welcome-tips').addEventListener('click', (e) => {
  closeSheet($('#welcome-dialog'));
  setTimeout(() => openSheet(el.helpDialog, e.target), 220);
});

$('#btn-share').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  audio.sfx('pop', btn);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const week = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    week.push({ label: i === 0 ? 'Today' : d.toLocaleDateString([], { weekday: 'short' }), m: dayTotals(d).m, today: i === 0 });
  }
  const cs = getComputedStyle(el.body);
  const v = (n) => cs.getPropertyValue(`--${n}`).trim();
  const t = dayTotals(today);
  const result = await shareCard({
    today: fmtMinutes(t.m),
    sessions: t.s,
    streak: streakDays(),
    week,
    date: today.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }),
    colors: { accent: v('accent'), accent2: v('accent-2'), bg: v('bg'), ink: v('ink'), ink2: v('ink-2'), track: v('track'), card: v('surface') },
  }).catch(() => 'failed');
  if (result === 'downloaded') toast({ icon: '🖼️', title: 'Image saved', body: 'Your focus card is in your downloads.' });
  else if (result === 'failed') toast({ icon: '⚠️', title: "Couldn't make the image" });
});

$('#btn-stats').addEventListener('click', (e) => {
  renderStats();
  openSheet(el.statsDialog, e.currentTarget);
});

$('#btn-settings').addEventListener('click', (e) => {
  fillSettings();
  openSheet(el.settingsDialog, e.currentTarget);
});

// Every button: ripple + haptic on press, generic click sound where tagged.
document.addEventListener(
  'pointerdown',
  (e) => {
    audio.unlock();
    startAmbientIfPending();
    const target = e.target.closest('.pressable');
    if (!target || target.disabled) return;
    fx.ripple(target, e);
    if (settings.sfx) fx.haptic(6);
  },
  { passive: true },
);

document.addEventListener('click', (e) => {
  const target = e.target.closest('[data-sfx]');
  if (target) audio.sfx(target.dataset.sfx, target);
});

document.addEventListener('keydown', (e) => {
  audio.unlock();
  startAmbientIfPending();
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
  if ($('dialog[open]')) return;
  const t = e.target;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable) return;
  const key = e.key.toLowerCase();
  // Holding a key down repeats it; only the "adjust" keys should repeat.
  if (e.repeat && !['+', '=', '-', '_', '[', ']'].includes(key)) return;
  if (key === ' ') {
    if (t.tagName === 'BUTTON' || t.getAttribute('role') === 'radio') return;
    e.preventDefault();
    toggleTimer(el.toggle);
  } else if (key === 'r') {
    el.reset.click();
  } else if (key === 's') {
    el.skip.click();
  } else if (key === 'n') {
    e.preventDefault();
    setView('tasks');
    if (isZen()) setZen(false);
    setTimeout(() => el.taskInput.focus(), isZen() ? 500 : 0);
  } else if (['1', '2', '3'].includes(key)) {
    el.tabs[Number(key) - 1].click();
  } else if (key === 'd') {
    noteDistraction();
  } else if (key === '+' || key === '=') {
    addTime(60000, el.extend);
  } else if (key === '-' || key === '_') {
    addTime(-60000, el.extend);
  } else if (key === '[' || key === ']') {
    el.volume.value = String(Math.max(0, Math.min(100, Number(el.volume.value) + (key === ']' ? 10 : -10))));
    el.volume.dispatchEvent(new Event('input'));
    el.volume.dispatchEvent(new Event('change'));
    fx.pop(el.volume.closest('.volume'), 1.08);
  } else if (key === '?') {
    e.preventDefault();
    openSheet(el.helpDialog, $('#btn-help'));
  } else if (key === 'm') {
    toggleMute();
  } else if (key === 'p' && pip.supported()) {
    togglePip();
  } else if (key === 'f') {
    setZen(!isZen());
  } else if (key === 'escape' && isZen()) {
    setZen(false);
  }
});

// Soft 3D keyboard clicks while typing; the sound follows the caret.
let lastKeyAt = 0;
document.addEventListener(
  'keydown',
  (e) => {
    const t = e.target;
    if (!settings.sfx || !(t instanceof HTMLInputElement) || t.type !== 'text') return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const now = performance.now();
    if (now - lastKeyAt < 28) return;
    let name = null;
    if (e.key === ' ') name = 'keySpace';
    else if (e.key === 'Backspace' || e.key === 'Delete') name = 'keyBack';
    else if (e.key.length === 1) name = 'key';
    if (!name) return;
    lastKeyAt = now;
    const r = t.getBoundingClientRect();
    const caret = t.selectionStart ?? t.value.length;
    audio.sfx(name, { x: r.left + 14 + Math.min(r.width - 28, caret * 8), y: r.top + r.height / 2 });
  },
  true,
);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (timer.running && Date.now() >= timer.endAt) complete({ late: Date.now() - timer.endAt });
  else renderTimer(true);
  syncWakeLock();
});

// Another tab changed the data: take it on without reloading, so this tab's
// sound keeps playing. Ambient sound itself stays per tab.
window.addEventListener('storage', (e) => {
  if (e.key !== STORE_KEY || !e.newValue) return;
  let d;
  try {
    d = obj(JSON.parse(e.newValue));
  } catch {
    return;
  }
  Object.assign(settings, cleanSettings(d.settings));
  const t = cleanTimer(d.timer);
  Object.keys(timer).forEach((k) => delete timer[k]);
  Object.assign(timer, t);
  tasks = cleanTasks(d.tasks);
  activeTaskId = tasks.some((x) => x.id === d.activeTaskId) ? d.activeTaskId : null;
  history = cleanHistory(d.history);
  Object.keys(achievements).forEach((k) => delete achievements[k]);
  Object.assign(achievements, obj(d.achievements));
  Object.assign(counters, cleanCounters(d.counters));
  // Saved mixes are shared; what's playing stays per tab.
  const sp = obj(d.sound).presets;
  if (Array.isArray(sp)) {
    sound.presets = sp.filter((p) => p && typeof p.name === 'string' && p.mix && typeof p.mix === 'object').slice(0, 12);
    renderMixes();
  }
  audio.setSfxEnabled(settings.sfx);
  scenery.setEnabled(settings.scenery);
  applyTheme();
  applyMode();
  schedule();
  renderTasks();
  renderGoal();
  syncWakeLock();
  syncSoundGate();
});

// Install as an app
let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  el.install.hidden = false;
});
el.install.addEventListener('click', async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice.catch(() => {});
  installPrompt = null;
  el.install.hidden = true;
});
window.addEventListener('appinstalled', () => { el.install.hidden = true; });

if ('serviceWorker' in navigator && (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname))) {
  // If a new version goes live while Tempo is open, offer a quick reload.
  const hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) return;
    toast({
      icon: '✨',
      title: 'Tempo has been updated',
      body: 'Reload to get the newest version. Your timer keeps going.',
      duration: 12000,
      action: { label: 'Reload', onClick: () => window.location.reload() },
    });
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('sw.js')
      .then((reg) => setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000))
      .catch(() => {});
  });
}

// ---------------------------------------------------------------------------
// Boot

audio.setSfxEnabled(settings.sfx);
scenery.mount();
scenery.setEnabled(settings.scenery);
applyTheme();
applyMode();
renderTasks();
renderChips();
renderMixer();
renderMixes();
syncSoundGate();
syncOrbit();
renderGoal();
setInterval(renderGoal, 60000);
initTaskDrag();
initTaskSwipe();
if (timer.running) schedule();
syncWakeLock();
effects.initSpotlight();
effects.initTilt($('.timer-card'));
setView('timer', { scroll: false });

// App shortcuts (long-press the installed app icon): ?action=focus|break|zen
{
  const action = new URLSearchParams(window.location.search).get('action');
  if (action) {
    window.history.replaceState(null, '', window.location.pathname);
    if (action === 'focus' || action === 'break') {
      const mode = action === 'focus' ? 'focus' : 'short';
      if (!timer.running || timer.mode !== mode) {
        if (timer.mode !== mode) switchTo(mode);
        start();
      }
    } else if (action === 'zen') {
      setZen(true);
    }
  }
}
requestAnimationFrame(() => el.body.classList.add('is-ready'));
selectStatTab(0, { animate: false });
// Someone who already used an earlier version doesn't need the welcome.
if (!settings.welcomed && (tasks.length || history.length)) settings.welcomed = true;
maybeWelcome();
