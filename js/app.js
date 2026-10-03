import * as audio from './audio.js';
import * as fx from './fx.js';

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
  autoBreaks: false,
  autoFocus: false,
  chime: true,
  sfx: true,
  notify: false,
  wakeLock: false,
  theme: 'auto',
};
const LIMITS = { focus: [1, 180], short: [1, 60], long: [1, 90], longEvery: [2, 12] };
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

const settings = { ...DEFAULTS, ...obj(stored.settings) };
for (const [k, [min, max]] of Object.entries(LIMITS)) settings[k] = clampInt(settings[k], min, max, DEFAULTS[k]);
if (!['auto', 'light', 'dark'].includes(settings.theme)) settings.theme = 'auto';

const timer = { mode: 'focus', running: false, endAt: 0, total: null, paused: null, cycle: 0, ...obj(stored.timer) };
if (!MODES[timer.mode]) timer.mode = 'focus';
timer.cycle = clampInt(timer.cycle, 0, 1e6, 0);

let tasks = (Array.isArray(stored.tasks) ? stored.tasks : [])
  .filter((t) => t && typeof t.title === 'string' && t.id)
  .map((t) => ({
    id: String(t.id),
    title: t.title.slice(0, 120),
    est: clampInt(t.est, 1, 20, 1),
    pomos: clampInt(t.pomos, 0, 999, 0),
    done: Boolean(t.done),
  }));
let activeTaskId = tasks.some((t) => t.id === stored.activeTaskId) ? stored.activeTaskId : null;

let history = (Array.isArray(stored.history) ? stored.history : []).filter(
  (h) => h && Number.isFinite(h.t) && Number.isFinite(h.m) && h.t > Date.now() - 400 * DAY,
);

const sound = { kind: 'off', volume: 50, ...obj(stored.sound) };
if (!['off', ...audio.ambientKinds].includes(sound.kind)) sound.kind = 'off';
sound.volume = clampInt(sound.volume, 0, 100, 50);

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ settings, timer, tasks, activeTaskId, history, sound }));
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
};

el.ring.style.strokeDasharray = `${RING_C}`;

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

function clearSession() {
  timer.running = false;
  timer.total = null;
  timer.paused = null;
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
    history.push({ t: endedAt, m: Math.round(totalMs() / 60000), s: 1 });
    const task = tasks.find((t) => t.id === activeTaskId);
    if (task && !task.done) task.pomos += 1;
    timer.cycle += 1;
  } else if (ended === 'long') {
    timer.cycle = 0;
  }
  const next = nextAfter(ended);
  switchTo(next);

  // Stay quiet about a session that ended long ago while the page was closed.
  if (late > 60000) return;

  if (settings.chime) audio.chime(next === 'focus' ? 'focus' : 'break');
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
}

function skip() {
  const ended = timer.mode;
  if (ended === 'focus') {
    const elapsed = totalMs() - remainingMs();
    if (!isFresh() && elapsed >= 60000) history.push({ t: Date.now(), m: Math.floor(elapsed / 60000), s: 0 });
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
    document.title = isFresh() ? 'Tempo · Focus Timer' : `${clock} · ${MODES[timer.mode].label} · Tempo`;

    if (timer.running && secs > 0 && secs <= 3 && !force && document.visibilityState === 'visible') {
      audio.sfx('tick', el.time);
      fx.pop(el.time, 1.05);
    }
  }

  const f = Math.max(0, Math.min(1, rem / totalMs()));
  el.ring.style.strokeDashoffset = `${RING_C * (1 - f)}`;
  const a = f * Math.PI * 2;
  el.head.setAttribute('cx', `${110 + 100 * Math.cos(a)}`);
  el.head.setAttribute('cy', `${110 + 100 * Math.sin(a)}`);

  el.body.classList.toggle('is-running', timer.running);
  el.toggle.setAttribute('aria-pressed', String(timer.running));
  el.toggleLabel.textContent = timer.running ? 'Pause' : isFresh() ? 'Start' : 'Resume';
}

function applyMode() {
  const mode = timer.mode;
  el.body.dataset.mode = mode;
  el.tabs.forEach((t) => t.setAttribute('aria-selected', String(t.dataset.mode === mode)));
  el.modes.style.setProperty('--i', String(MODE_ORDER.indexOf(mode)));
  const pos = (timer.cycle % settings.longEvery) + 1;
  el.sessionLabel.textContent = MODES[mode].note(pos, settings.longEvery);
  updateThemeColor();
  renderTimer(true);
}

function updateThemeColor() {
  requestAnimationFrame(() => {
    const c = getComputedStyle(el.body).getPropertyValue('--bg').trim();
    if (c && el.metaTheme) el.metaTheme.content = c;
  });
}

function applyTheme() {
  if (settings.theme === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = settings.theme;
  updateThemeColor();
}

function announce(msg) {
  el.announcer.textContent = '';
  setTimeout(() => { el.announcer.textContent = msg; }, 50);
}

// ---------------------------------------------------------------------------
// Wake lock & notifications

let wakeLock = null;

async function syncWakeLock() {
  const want = settings.wakeLock && timer.running && document.visibilityState === 'visible' && 'wakeLock' in navigator;
  if (want && !wakeLock) {
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
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

const ICON_X = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17"/></svg>';

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

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'task-delete pressable';
  del.setAttribute('aria-label', `Delete "${task.title}"`);
  del.innerHTML = ICON_X;

  li.append(check, select, del);
  return li;
}

function renderTasks({ entering } = {}) {
  el.taskList.replaceChildren(...tasks.map(taskRow));
  if (entering) {
    const li = el.taskList.querySelector(`[data-id="${CSS.escape(entering)}"]`);
    if (li) fx.enter(li);
  }

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
  tasks = tasks.filter((t) => !ids.includes(t.id));
  if (ids.includes(activeTaskId)) activeTaskId = null;
  save();
  renderTasks();
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

  $('#stat-today').textContent = fmtMinutes(todayStats.m);
  $('#stat-sessions').textContent = String(todayStats.s);
  $('#stat-streak').textContent = `${streak} ${streak === 1 ? 'day' : 'days'}`;
  $('#stat-week').textContent = fmtMinutes(week);
  $('#stat-total').textContent = sessions
    ? `All time: ${fmtMinutes(total)} of focus across ${sessions} ${sessions === 1 ? 'session' : 'sessions'}.`
    : 'Finish a focus session to start filling this in.';

  renderChart(days);
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
  const done = (e) => {
    if (e.target !== dialog) return;
    dialog.removeEventListener('animationend', done);
    dialog.classList.remove('is-closing');
    dialog.close();
  };
  dialog.addEventListener('animationend', done);
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
  for (const k of ['autoBreaks', 'autoFocus', 'chime', 'sfx', 'notify', 'wakeLock']) f.elements[k].checked = settings[k];
  f.elements.theme.value = settings.theme;
}

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
  } else if (name === 'theme') {
    settings.theme = input.value;
    applyTheme();
    audio.sfx('pop', input.closest('label'));
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

$('#btn-test-chime').addEventListener('click', () => audio.chime('break'));

$('#btn-reset-data').addEventListener('click', () => {
  if (!window.confirm('Erase all tasks, stats and settings? This cannot be undone.')) return;
  try { localStorage.removeItem(STORE_KEY); } catch { /* ignore */ }
  window.location.reload();
});

// ---------------------------------------------------------------------------
// Ambient sound

let ambientStarted = false;

function renderChips() {
  el.chips.forEach((c) => {
    const on = c.dataset.sound === sound.kind;
    c.setAttribute('aria-checked', String(on));
    c.classList.toggle('is-live', on && ambientStarted && sound.kind !== 'off');
  });
}

function startAmbientIfPending() {
  if (ambientStarted || sound.kind === 'off') return;
  ambientStarted = true;
  audio.setAmbient(sound.kind);
  renderChips();
}

el.chips.forEach((chip) => {
  chip.addEventListener('click', () => {
    const kind = chip.dataset.sound;
    audio.sfx('pop', chip);
    fx.pop(chip, 1.08);
    if (kind === sound.kind && ambientStarted) return;
    sound.kind = kind;
    ambientStarted = kind !== 'off';
    audio.setAmbient(kind);
    renderChips();
    save();
  });
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
    audio.sfx('check', e.target);
    fx.burst(e.target, { count: 12, spread: 34, size: 5 });
    if (activeTaskId === task.id) activeTaskId = tasks.find((t) => !t.done)?.id ?? null;
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

el.clearDone.addEventListener('click', () => {
  removeTasks(tasks.filter((t) => t.done).map((t) => t.id), el.clearDone);
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
    el.taskInput.focus();
  } else if (['1', '2', '3'].includes(key)) {
    el.tabs[Number(key) - 1].click();
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (timer.running && Date.now() >= timer.endAt) complete({ late: Date.now() - timer.endAt });
  else renderTimer(true);
  syncWakeLock();
});

window.addEventListener('storage', (e) => {
  if (e.key === STORE_KEY) window.location.reload();
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
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

// ---------------------------------------------------------------------------
// Boot

audio.setSfxEnabled(settings.sfx);
applyTheme();
applyMode();
renderTasks();
renderChips();
if (timer.running) schedule();
syncWakeLock();
requestAnimationFrame(() => el.body.classList.add('is-ready'));
