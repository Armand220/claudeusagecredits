import * as audio from './audio.js?v=76';
import * as fx from './fx.js?v=76';
import { toast, rehome as rehomeToasts } from './toast.js?v=76';
import * as effects from './effects.js?v=76';
import * as scenery from './scenery.js?v=76';
import * as pip from './pip.js?v=76';
import { shareCard, makeCardFile } from './share.js?v=76';
import * as party from './party.js?v=76';
import { clean as cleanWords } from './filter.js?v=76';
import * as photo from './photo.js?v=76';

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
  chimeVolume: 70,
  flow: false,
  flowRatio: 5,
  goalType: 'sessions',
  goalMinutes: 120,
  bells: false,
  daySky: true,
  playOnSilent: true,
  partyRules: null, // see cleanRules
};
const PALETTES = ['sunset', 'ocean', 'forest', 'lavender', 'rose', 'mono'];
const LIMITS = { focus: [1, 180], short: [1, 60], long: [1, 90], longEvery: [2, 12], goal: [1, 24], chimeVolume: [0, 100], flowRatio: [2, 6], goalMinutes: [15, 720] };
const RING_C = 2 * Math.PI * 100;

// Focus party roles: what each guest may do. The host picks one per guest.
const ROLES = {
  watch: { icon: '👀', name: 'Watch', note: 'Sees and hears everything, but can’t ask for changes.' },
  ask: { icon: '🙋', name: 'Ask', note: 'Can ask the host for changes, one at a time.' },
  add: { icon: '✏️', name: 'Add', note: 'Adds tasks and sounds directly, and asks for timer changes.' },
};
const ROLE_IDS = Object.keys(ROLES);
// What each kind of request is about; the host chooses which they take.
const REQ_GROUP = { toggle: 'timer', skip: 'timer', reset: 'timer', mode: 'timer', more: 'timer', break: 'timer', sound: 'sounds', silence: 'sounds', mix: 'sounds', task: 'tasks', done: 'tasks', message: 'messages' };
const GROUPS = { timer: 'The timer', sounds: 'Sounds', tasks: 'Tasks', messages: 'Messages' };
const DIRECT_KINDS = ['sound', 'silence', 'mix', 'task', 'done']; // what an Add guest changes without asking
const COOLDOWNS = [10, 30, 60, 120]; // seconds between one guest's requests
const PENDING_MS = 20000; // how long a request waits for the host's answer
const ADD_LIMIT = 5; // Add guests: at most this many changes…
const ADD_WINDOW = 30000; // …in this many ms

function cleanRules(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    role: ROLE_IDS.includes(r.role) ? r.role : 'ask',
    timer: r.timer !== false,
    sounds: r.sounds !== false,
    tasks: r.tasks !== false,
    messages: r.messages !== false,
    cooldown: COOLDOWNS.includes(Number(r.cooldown)) ? Number(r.cooldown) : 30,
    filter: r.filter !== false, // star out bad language in names, tasks and messages
    admit: r.admit === true, // the host lets each person in
  };
}

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
  out.flow = Boolean(out.flow);
  if (!['sessions', 'minutes'].includes(out.goalType)) out.goalType = 'sessions';
  out.partyRules = cleanRules(out.partyRules);
  return out;
}

function cleanTimer(raw) {
  const out = { mode: 'focus', running: false, endAt: 0, total: null, paused: null, cycle: 0, ...obj(raw) };
  if (!MODES[out.mode]) out.mode = 'focus';
  out.cycle = clampInt(out.cycle, 0, 1e6, 0);
  out.distractions = clampInt(out.distractions, 0, 99, 0);
  out.flow = Boolean(out.flow) && out.mode === 'focus';
  out.nudged = Boolean(out.nudged);
  out.rung = clampInt(out.rung, 0, 2, 0); // soft bells already rung this session
  if (!Number.isFinite(out.startAt)) out.startAt = 0;
  out.earned = out.mode !== 'focus' && Number.isFinite(out.earned) && out.earned >= 60000 ? Math.min(out.earned, 90 * 60000) : null;
  out.running = Boolean(out.running) && Number.isFinite(out.flow ? out.startAt : out.endAt);
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
      // Daily tasks come back unticked each day; `day` is when they last did.
      ...(t.daily ? { daily: true, day: typeof t.day === 'string' ? t.day : todayKey() } : {}),
    }));
}

function cleanHistory(raw) {
  return (Array.isArray(raw) ? raw : [])
    // Three years of sessions (at most 20,000) is a few hundred KB.
    .filter((h) => h && Number.isFinite(h.t) && Number.isFinite(h.m) && h.t > Date.now() - 1100 * DAY)
    .slice(-20000)
    .map((h) => ({
      t: h.t,
      m: h.m,
      s: h.s ? 1 : 0,
      ...(typeof h.task === 'string' ? { task: h.task.slice(0, 120) } : {}),
      ...(Number.isInteger(h.r) && h.r >= 1 && h.r <= 4 ? { r: h.r } : {}),
      ...(Number.isInteger(h.d) && h.d > 0 ? { d: Math.min(h.d, 99) } : {}),
      ...(h.f ? { f: 1 } : {}),
      ...(typeof h.n === 'string' && h.n.trim() ? { n: h.n.trim().slice(0, 140) } : {}),
    }));
}

// Today's intention: a line you write for the day; it clears itself tomorrow.
const todayKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};

function cleanIntention(raw) {
  const o = obj(raw);
  const today = o.d === todayKey() && typeof o.text === 'string';
  return { d: todayKey(), text: today ? o.text.slice(0, 100) : '', done: today && Boolean(o.done) };
}

function cleanCounters(raw) {
  const out = { tasksDone: 0, soundsTried: [], intentionDays: [], paletteRuns: 0, ...obj(raw) };
  if (!Array.isArray(out.soundsTried)) out.soundsTried = [];
  // Days (todayKey) when the intention was ticked off.
  out.intentionDays = Array.isArray(out.intentionDays) ? out.intentionDays.filter((d) => typeof d === 'string').slice(-400) : [];
  out.paletteRuns = clampInt(out.paletteRuns, 0, 1e6, 0);
  // Which colour each #tag got, so tags keep their colours.
  out.tagColors = Object.fromEntries(
    Object.entries(obj(out.tagColors))
      .filter(([k, v]) => k.length <= 24 && Number.isInteger(v) && v >= 0 && v < 8)
      .slice(0, 300),
  );
  return out;
}

const settings = cleanSettings(stored.settings);
const timer = cleanTimer(stored.timer);
let tasks = cleanTasks(stored.tasks);
let activeTaskId = tasks.some((t) => t.id === stored.activeTaskId) ? stored.activeTaskId : null;
let history = cleanHistory(stored.history);
const achievements = { ...obj(stored.achievements) };
const counters = cleanCounters(stored.counters);
let intention = cleanIntention(stored.intention);

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
    // A party guest sees the host's timer, tasks and sounds, but keeps their own on disk.
    const own = P && P.role === 'guest' ? P.backup : null;
    const data = own
      ? { settings: { ...settings, ...own.settings }, timer: own.timer, tasks: own.tasks, activeTaskId: own.activeTaskId, sound: { ...sound, mix: own.mix } }
      : { settings, timer, tasks, activeTaskId, sound };
    localStorage.setItem(STORE_KEY, JSON.stringify({ ...data, history, achievements, counters, intention }));
  } catch {
    /* storage full or blocked: the app still works for this visit */
  }
  if (P && P.role === 'host') queuePartyBroadcast();
}

// ---------------------------------------------------------------------------
// Focus party (see party.js): the host shares the timer, tasks and sounds;
// guests follow along and ask for changes.

// P: { role: 'host' | 'guest', ctl, code, hostName, members, backup }, and for
// a guest also access (what the host lets them do), nextAt (when they may ask
// again), pending (their unanswered request) and adds (recent direct changes).
let P = null;
let partyTimer = 0;
// The host's record of each guest: { role, lastAsk, pendingUntil, adds }.
// These are what count: a guest's app only mirrors the rules to explain them.
const guestRecs = new Map();
const hostQueue = { open: 0, last: 0 }; // request toasts showing on the host, and when the last arrived
let joinNoise = 0; // when a join or leave last made a sound
const secs = (ms) => {
  const s = Math.max(1, Math.ceil(ms / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ''}`;
};

function guestRec(id) {
  if (!guestRecs.has(id)) guestRecs.set(id, { role: settings.partyRules.role, lastAsk: 0, pendingUntil: 0, adds: [] });
  return guestRecs.get(id);
}

// What a guest is told about their role and the host's rules.
function accessOf(rec) {
  const r = settings.partyRules;
  return { role: rec.role, timer: r.timer, sounds: r.sounds, tasks: r.tasks, messages: r.messages, cooldown: r.cooldown, filter: r.filter, wait: Math.max(0, rec.lastAsk + r.cooldown * 1000 - Date.now()) };
}

function cleanAccess(raw) {
  const a = obj(raw);
  return {
    role: ROLE_IDS.includes(a.role) ? a.role : 'ask',
    timer: a.timer !== false,
    sounds: a.sounds !== false,
    tasks: a.tasks !== false,
    messages: a.messages !== false,
    cooldown: clampInt(a.cooldown, 0, 600, 30),
    filter: a.filter !== false,
  };
}

// The language filter, when the party has it on (the host's rule).
const partyFilter = () => (P && P.role === 'guest' ? P.access.filter : settings.partyRules.filter);
const tidy = (text) => (partyFilter() ? cleanWords(text) : String(text));
const isGuest = () => Boolean(P && P.role === 'guest');

function shareAccess() {
  if (!P || P.role !== 'host') return;
  guestRecs.forEach((rec, id) => P.ctl.setAccess(id, accessOf(rec)));
  P.members = P.ctl.members();
}

// The guest's body class says what their taps do (see the controls hint).
function showGuestRole() {
  for (const r of ROLE_IDS) el.body.classList.toggle(`party-${r}`, Boolean(P && P.role === 'guest' && P.access.role === r));
}
const PARTY_SETTINGS = ['focus', 'short', 'long', 'longEvery', 'flow', 'flowRatio'];
const partyName = () => settings.partyName || 'Friend';

function partyState() {
  const mix = {};
  for (const k of activeKinds()) mix[k] = { vol: sound.mix[k].vol, x: sound.mix[k].x, z: sound.mix[k].z, orbit: sound.mix[k].orbit };
  return {
    timer: { ...timer },
    settings: Object.fromEntries(PARTY_SETTINGS.map((k) => [k, settings[k]])),
    mix,
    tasks: tasks.map((t) => ({ id: t.id, title: tidy(t.title), est: t.est, pomos: t.pomos, done: t.done })),
    activeTaskId,
  };
}

function queuePartyBroadcast() {
  clearTimeout(partyTimer);
  partyTimer = setTimeout(() => P && P.role === 'host' && P.ctl.broadcast(partyState()), 120);
}

// A guest takes on the host's state (timestamps moved onto our own clock).
function applyPartyState(s) {
  if (!P || P.role !== 'guest' || !s || typeof s !== 'object') return;
  const off = P.ctl.offset();
  const t = obj(s.timer);
  const shifted = { ...t, endAt: Number(t.endAt) - off, startAt: Number(t.startAt) - off };
  Object.keys(timer).forEach((k) => delete timer[k]);
  Object.assign(timer, cleanTimer(shifted));
  const st = obj(s.settings);
  for (const k of PARTY_SETTINGS) if (k in st) settings[k] = k === 'flow' ? Boolean(st[k]) : clampInt(st[k], ...LIMITS[k], settings[k]);
  P.lastState = s;
  tasks = cleanTasks(s.tasks).map((x) => ({ ...x, title: tidy(x.title) }));
  activeTaskId = tasks.some((x) => x.id === s.activeTaskId) ? s.activeTaskId : null;
  const want = obj(s.mix);
  for (const k of audio.ambientKinds) {
    const w = want[k] && typeof want[k] === 'object' ? want[k] : null;
    const on = sound.mix[k] && sound.mix[k].on;
    if (w) {
      const [dx, dz] = audio.defaultAnchor(k);
      const m = { vol: clampNum(w.vol, 0, 1, 0.8), x: clampNum(w.x, -4, 4, dx), z: clampNum(w.z, -4, 4, dz), orbit: Boolean(w.orbit) };
      if (on) {
        Object.assign(sound.mix[k], m);
        audio.setLayerVolume(k, m.vol);
        audio.moveLayer(k, m.x, m.z);
      } else {
        sound.mix[k] = { ...m, on: false };
        setSound(k, true);
      }
    } else if (on) {
      setSound(k, false);
    }
  }
  afterSoundChange();
  applyMode();
  schedule();
  renderTasks();
  renderGoal();
  syncWakeLock();
}

function renderPartyButton() {
  const b = $('#btn-party');
  b.classList.toggle('is-live', Boolean(P));
  $('#party-label').textContent = P ? `Party · ${P.members.length}` : 'Party';
}

const PARTY_ERRORS = {
  'not-found': "Couldn't find that party. Check the code, and ask the host to keep Tempo open on screen (phones pause it in the background).",
  full: 'That party is full (12 guests).',
  removed: "The host didn't let you in to this party.",
  'not-let-in': "The host didn't let you in yet. Ask them to open Tempo and tap Let in, then try again.",
  unreachable: "Found the party but couldn't connect directly. Turn 'Private connection' on: it goes through the encrypted relay and works on any network.",
  network: "Couldn't reach any of the party relays. Check your internet, and turn off any ad or tracker blocker or VPN for this site.",
  setup: "This browser couldn't set up the connection. Try Chrome or Safari, and not inside another app's built-in browser.",
};
// The friendly message, plus the technical reason so problems can be reported.
const partyError = (err) => {
  const msg = String((err && err.message) || 'network');
  const [kind, ...detail] = msg.split(':');
  const base = PARTY_ERRORS[kind] || PARTY_ERRORS.network;
  return detail.length ? `${base} (Details: ${detail.join(':').trim()})` : base;
};

function renderPartyDialog(prefill = '') {
  const body = $('#party-body');
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  if (!P) {
    body.innerHTML = `
      <p class="sheet-note">Focus together in real time. Everyone sees the same timer, tasks and sounds; the host is in charge, and guests can ask for changes.</p>
      <label class="field"><span>Your name</span><input id="party-name" type="text" maxlength="24" value="${esc(settings.partyName || '')}" placeholder="Your name" autocomplete="nickname"></label>
      <label class="switch"><input type="checkbox" id="party-private" checked><span>Private connection: party members never see your IP address</span></label>
      <div class="party-actions">
        <button type="button" class="primary-btn pressable" id="party-host">Start a party</button>
      </div>
      <div class="party-or" aria-hidden="true">or join one</div>
      <form class="party-join" id="party-join-form" autocomplete="off">
        <label class="sr-only" for="party-code">Party code</label>
        <input id="party-code" type="text" maxlength="12" placeholder="Code, like K7QX-2M9P" value="${esc(prefill)}" autocapitalize="characters" spellcheck="false">
        <button type="submit" class="text-btn pressable">Join</button>
      </form>
      <p class="party-status" id="party-status" role="status"></p>`;
    return;
  }
  // Re-rendering mustn't throw away what the host was in the middle of.
  const focused = document.activeElement && body.contains(document.activeElement) ? document.activeElement : null;
  const refocus = focused && (focused.id ? `#${focused.id}` : focused.dataset.guest ? `.${focused.classList[0]}[data-guest="${CSS.escape(focused.dataset.guest)}"]` : '');
  const roleTag = (m) => (ROLE_IDS.includes(m.role) ? ` <span class="party-role-tag" title="${ROLES[m.role].name}">${ROLES[m.role].icon} ${ROLES[m.role].name}</span>` : '');
  if (P.role === 'host') {
    const rules = settings.partyRules;
    const roleOptions = (sel) => ROLE_IDS.map((r) => `<option value="${r}"${r === sel ? ' selected' : ''}>${ROLES[r].icon} ${ROLES[r].name}</option>`).join('');
    const members = P.members.map((m) => {
      if (m.host) return `<li><span class="party-dot" aria-hidden="true"></span><span class="party-name">${esc(m.name)}</span> <em>host</em></li>`;
      const rec = guestRec(m.id);
      return `<li><span class="party-dot" aria-hidden="true"></span><span class="party-name">${esc(m.name)}</span>
        <select class="party-role" data-guest="${esc(m.id)}" aria-label="What ${esc(m.name)} can do">${roleOptions(rec.role)}</select>
        <button type="button" class="party-kick pressable" data-guest="${esc(m.id)}" aria-label="Remove ${esc(m.name)} from the party" title="Remove from the party">✕</button></li>`;
    }).join('');
    body.innerHTML = `
      <p class="sheet-note">Share the code or the link. Guests see your timer, tasks and sounds; what they can do is up to you.</p>
      <div class="party-code" aria-label="Party code">${party.formatCode(P.code)}</div>
      <div class="party-actions">
        <button type="button" class="primary-btn pressable" id="party-copy">Copy invite link</button>
        <button type="button" class="text-btn pressable" id="party-end">End party</button>
      </div>
      <h3 class="party-h">In the party</h3><ul class="party-members">${members}</ul>
      ${P.members.length < 2 ? '<p class="field-note">Nobody here yet. When people join, pick what each of them can do.</p>' : ''}
      <h3 class="party-h">Guest rules</h3>
      <div class="party-rules">
        <label class="party-rule"><span>New guests</span><select id="party-default-role">${roleOptions(rules.role)}</select></label>
        <fieldset class="party-allow">
          <legend>Guests can ask about (or change, if they can add)</legend>
          ${Object.entries(GROUPS).map(([g, label]) => `<label class="party-check pressable"><input type="checkbox" id="party-allow-${g}" name="${g}"${rules[g] ? ' checked' : ''}><span>${label}</span></label>`).join('')}
        </fieldset>
        <label class="party-rule"><span>Time between requests</span><select id="party-cooldown">${COOLDOWNS.map((c) => `<option value="${c}"${c === rules.cooldown ? ' selected' : ''}>${secs(c * 1000)}</option>`).join('')}</select></label>
        <label class="switch"><input type="checkbox" id="party-admit"${rules.admit ? ' checked' : ''}><span>Ask me before letting people in</span></label>
        <label class="switch"><input type="checkbox" id="party-filter"${rules.filter ? ' checked' : ''}><span>Language filter: star out bad words in names, tasks and messages</span></label>
      </div>
      <ul class="party-role-key">${ROLE_IDS.map((r) => `<li><span aria-hidden="true">${ROLES[r].icon}</span><span><strong>${ROLES[r].name}</strong> ${ROLES[r].note}${r === 'add' ? ` (Up to ${ADD_LIMIT} changes every ${ADD_WINDOW / 1000} s.)` : ''}</span></li>`).join('')}</ul>
      <p class="field-note">📱 Keep Tempo open on screen while people join: phones pause pages in the background.</p>
      <p class="field-note">${P.ctl.private ? '🔒 Private: everything goes through encrypted relays (AES-256, keyed by the code), so nobody in the party ever sees anyone\'s IP address.' : 'Direct connections: a little faster, but members can see each other\'s IP address.'}</p>`;
  } else {
    const a = P.access;
    const role = ROLES[a.role];
    const allowed = Object.keys(GROUPS).filter((g) => g !== 'messages' && a[g]).map((g) => GROUPS[g].toLowerCase());
    const what = {
      watch: `You can see and hear everything; ${esc(P.hostName)} makes the changes.`,
      ask: allowed.length ? `Tap a control to ask ${esc(P.hostName)} about ${allowed.join(', ').replace(/, ([^,]*)$/, ' or $1')}. One request at a time, then a ${secs(a.cooldown * 1000)} wait.` : `${esc(P.hostName)} isn't taking requests right now.`,
      add: `Add tasks and sounds yourself (up to ${ADD_LIMIT} changes every ${ADD_WINDOW / 1000} s).${a.timer ? ` Timer taps ask ${esc(P.hostName)}.` : ''}`,
    }[a.role];
    const canMessage = a.role !== 'watch' && a.messages;
    const canBreak = a.role !== 'watch' && a.timer;
    const members = P.members.map((m) => `<li><span class="party-dot" aria-hidden="true"></span><span class="party-name">${esc(m.name)}</span>${m.id && m.id === P.me ? ' <em>you</em>' : ''}${m.host ? ' <em>host</em>' : roleTag(m)}</li>`).join('');
    body.innerHTML = `
      <p class="sheet-note">You're in <strong>${esc(P.hostName)}</strong>'s party.</p>
      <div class="party-you"><span class="party-you-icon" aria-hidden="true">${role.icon}</span><div><strong>You can ${a.role === 'watch' ? 'watch' : a.role}</strong><span>${what}</span></div></div>
      <p class="party-wait" id="party-wait" role="status"></p>
      ${canMessage ? `<form class="party-join" id="party-msg-form" autocomplete="off">
        <label class="sr-only" for="party-msg">Message to the host</label>
        <input id="party-msg" type="text" maxlength="140" placeholder="Ask the host something…">
        <button type="submit" class="text-btn pressable">Send</button>
      </form>` : ''}
      <div class="party-actions">
        ${canBreak ? '<button type="button" class="text-btn pressable" id="party-break">Ask for a break</button>' : ''}
        <button type="button" class="text-btn pressable" id="party-leave">Leave party</button>
      </div>
      <h3 class="party-h">In the party</h3><ul class="party-members">${members}</ul>
      ${a.filter ? '<p class="field-note">🧼 The language filter is on: bad words are starred out.</p>' : ''}`;
    tickPartyWait();
  }
  if (refocus) body.querySelector(refocus)?.focus();
}

// A guest's countdown until they can ask again, while the dialog is open.
let waitTicker = 0;
function tickPartyWait() {
  clearTimeout(waitTicker);
  const out = $('#party-wait');
  if (!out || !P || P.role !== 'guest' || !$('#party-dialog').open) return;
  const now = Date.now();
  let text = '';
  if (P.access.role !== 'watch') {
    if (P.pending && P.pending.until > now) text = `⏳ Waiting for ${P.hostName} to answer…`;
    else if (P.nextAt > now) text = `⏳ You can ask again in ${secs(P.nextAt - now)}`;
  }
  if (out.textContent !== text) out.textContent = text;
  if (text) waitTicker = setTimeout(tickPartyWait, 1000 - (now % 1000) + 20);
}

function partyStatus(text) {
  const s = $('#party-status');
  if (s) s.textContent = text;
}

async function startParty() {
  const name = ($('#party-name').value.trim() || 'Host').slice(0, 24);
  settings.partyName = name;
  save();
  partyStatus('Setting up a private party…');
  guestRecs.clear();
  try {
    const ctl = await party.host(tidy(name), {
      getState: partyState,
      cleanName: (n) => tidy(n),
      accessFor: (g) => accessOf(guestRec(g.id)),
      onJoin: (g) => {
        P.members = ctl.members();
        renderPartyButton();
        if ($('#party-dialog').open) renderPartyDialog();
        if (Date.now() - joinNoise > 3000) audio.sfx('on', $('#btn-party'));
        joinNoise = Date.now();
        toast({ icon: '🎉', title: `${g.name} joined the party`, duration: 3000, key: 'party-joins' });
      },
      onKnock: (w) => {
        audio.softBell('half');
        if (document.visibilityState !== 'visible') showNotice(`${w.name} wants to join`, 'Open Tempo to let them in.');
        toast({
          icon: '🚪',
          title: `${w.name} wants to join`,
          duration: 60000,
          key: `party-knock-${w.id}`,
          actions: [
            { label: 'No', kind: 'ghost', onClick: () => P && P.ctl.admitGuest(w.id, false) },
            { label: 'Let in', onClick: () => P && P.ctl.admitGuest(w.id, true) },
          ],
        });
      },
      onLeave: (g) => {
        guestRecs.delete(g.id);
        P.members = ctl.members();
        renderPartyButton();
        if ($('#party-dialog').open) renderPartyDialog();
        toast({ icon: '👋', title: `${g.name} left`, duration: 2500, key: 'party-joins' });
      },
      onRequest: onPartyRequest,
      onSignal: () => {},
    }, { private: $('#party-private').checked, admit: settings.partyRules.admit ? 'ask' : 'open' });
    P = { role: 'host', ctl, code: ctl.code, hostName: name, members: ctl.members() };
    renderPartyButton();
    renderPartyDialog();
    audio.fanfare();
  } catch (err) {
    partyStatus(partyError(err));
  }
}

async function joinParty(code) {
  const name = ($('#party-name').value.trim() || 'Guest').slice(0, 24);
  settings.partyName = name;
  save();
  audio.unlock();
  partyStatus('Joining…');
  const backup = {
    timer: JSON.parse(JSON.stringify(timer)),
    tasks: JSON.parse(JSON.stringify(tasks)),
    activeTaskId,
    settings: Object.fromEntries(PARTY_SETTINGS.map((k) => [k, settings[k]])),
    mix: JSON.parse(JSON.stringify(sound.mix)),
  };
  try {
    return await party.join(code, name, {
      onWelcome: (msg, ctl) => {
        const access = cleanAccess(msg.access);
        const tidyName = (n) => (access.filter ? cleanWords(n) : String(n));
        P = { role: 'guest', ctl, code, hostName: tidyName(String(msg.host || 'Host').slice(0, 24)), members: (Array.isArray(msg.members) ? msg.members : []).map((m) => ({ ...m, name: tidyName(m.name || '') })), backup, access, nextAt: 0, pending: null, adds: [], me: String(msg.id || '') };
        el.body.classList.add('is-guest');
        showGuestRole();
        applyPartyState(msg.state);
        renderPartyButton();
        renderPartyDialog();
        toast({ icon: '🎉', title: `You joined ${P.hostName}'s party`, body: 'Your timer, sounds and tasks follow the host now.', duration: 4000 });
      },
      onState: applyPartyState,
      onMembers: (m) => {
        if (!P) return;
        P.members = m.map((x) => ({ ...x, name: tidy(x.name) }));
        renderPartyButton();
        if ($('#party-dialog').open) renderPartyDialog();
      },
      onAccess: (raw) => {
        if (!P) return;
        const was = P.access;
        P.access = cleanAccess(raw);
        const wait = Number(obj(raw).wait);
        if (Number.isFinite(wait)) P.nextAt = Date.now() + Math.min(Math.max(wait, 0), 600000);
        showGuestRole();
        if (was.filter !== P.access.filter && P.lastState) applyPartyState(P.lastState);
        if (was.role !== P.access.role) {
          const said = {
            watch: ['👀', `${P.hostName} set you to watch`, "You'll see and hear everything; the host makes the changes."],
            ask: ['🙋', `${P.hostName} lets you ask`, 'Tap a control to ask for a change.'],
            add: ['✏️', `${P.hostName} lets you add things`, 'Add tasks and sounds yourself; timer changes are still requests.'],
          }[P.access.role];
          toast({ icon: said[0], title: said[1], body: said[2], duration: 4000, key: 'party-role' });
        }
        if ($('#party-dialog').open) renderPartyDialog();
      },
      onAnswer: (a) => {
        if (!P) return;
        if (P.pending && P.pending.id === a.id) P.pending = null;
        // A refusal wasn't counted by the host, so its wait replaces ours.
        if (a.auto && !a.ok) P.nextAt = Date.now() + a.wait;
        else if (a.wait) P.nextAt = Math.max(P.nextAt, Date.now() + a.wait);
        tickPartyWait();
        if (a.auto) {
          // The host's app answered by itself: a rule said no (or a direct change went through).
          if (!a.ok) toast({ icon: '⏳', title: 'Not sent', body: a.text, duration: 3000, key: 'party-ask' });
          return;
        }
        toast({ icon: a.ok ? '👍' : '🙂', title: a.ok ? `${P.hostName} said yes` : `${P.hostName} said not now`, body: a.text, duration: 3000, key: 'party-ask' });
      },
      onWaiting: () => partyStatus('Waiting for the host to let you in…'),
      onEnd: (why) => leaveParty({
        ended: `${P ? P.hostName : 'The host'} ended the party`,
        removed: `${P ? P.hostName : 'The host'} removed you from the party`,
      }[why] || 'Lost the connection to the party'),
    }, { private: $('#party-private').checked });
  } catch (err) {
    partyStatus(partyError(err));
    return null;
  }
}

// Leaving (or the party ending) gives a guest their own things back.
function leaveParty(message) {
  if (!P) return;
  const was = P;
  P = null;
  el.body.classList.remove('is-guest');
  showGuestRole();
  guestRecs.clear();
  if (was.role === 'host') was.ctl.end();
  else {
    was.ctl.leave();
    const b = was.backup;
    Object.keys(timer).forEach((k) => delete timer[k]);
    Object.assign(timer, cleanTimer(b.timer));
    tasks = cleanTasks(b.tasks);
    activeTaskId = b.activeTaskId;
    Object.assign(settings, b.settings);
    activeKinds().forEach((k) => setSound(k, false));
    for (const [k, m] of Object.entries(b.mix)) sound.mix[k] = { ...m, on: false };
    save();
    applyMode();
    schedule();
    renderTasks();
    renderGoal();
    afterSoundChange();
  }
  renderPartyButton();
  if ($('#party-dialog').open) renderPartyDialog();
  if (message) toast({ icon: '🎉', title: message, duration: 3500 });
}

// ----- Requests: what guests tap becomes a question for the host

const REQUEST_TEXT = {
  toggle: (d) => (d === 'pause' ? 'pause the timer' : 'start the timer'),
  skip: () => 'skip to the next session',
  reset: () => 'reset the timer',
  mode: (d) => `switch to ${MODES[d] ? MODES[d].label.toLowerCase() : 'another mode'}`,
  more: (d) => (Number(d) > 1 ? `add ${Number(d)} minutes` : 'add a minute'),
  break: () => 'take a break',
  sound: (d) => `${d && d.on ? 'play' : 'stop'} ${SOUND_INFO[d && d.kind] ? SOUND_INFO[d.kind].name.toLowerCase() : 'a sound'}`,
  silence: () => 'turn all the sounds off',
  mix: (d) => `play the ${d && d.name ? d.name : 'mix'} mix`,
  task: (d) => `add the task “${String(d || '').slice(0, 60)}”`,
  done: (d) => `tick off “${(tasks.find((t) => t.id === d) || { title: 'a task' }).title.slice(0, 60)}”`,
  message: (d) => String(d || '').slice(0, 140),
};

// A short explanation for a guest's tap that can't do anything.
function guestNote(icon, title, body = '') {
  toast({ icon, title, body, duration: 2600, key: 'party-ask' });
}

// A guest's tap. Their own app explains the host's rules up front (the host's
// app enforces them anyway), so nothing is sent that would only be refused.
function askHost(kind, data) {
  if (!P || P.role !== 'guest') return;
  const a = P.access;
  const now = Date.now();
  const say = (icon, title, body = '') => toast({ icon, title, body, duration: 2600, key: 'party-ask' });
  if (a.role === 'watch') {
    say('👀', "You're watching", `${P.hostName} makes the changes in this party.`);
    return;
  }
  const group = REQ_GROUP[kind];
  if (!a[group]) {
    say('🙂', `${P.hostName} isn't taking requests about ${GROUPS[group].toLowerCase()}`);
    return;
  }
  if (a.role === 'add' && DIRECT_KINDS.includes(kind)) {
    P.adds = P.adds.filter((t) => now - t < ADD_WINDOW);
    if (P.adds.length >= ADD_LIMIT) {
      say('⏳', 'Slow down a little', `You can change things again in ${secs(P.adds[0] + ADD_WINDOW - now)}.`);
      return;
    }
    P.adds.push(now);
    P.ctl.request(kind, data);
    audio.sfx('pop', el.toggle);
    return;
  }
  if (P.pending && P.pending.until > now) {
    say('⏳', 'Waiting for an answer', `${P.hostName} hasn't answered your last request yet.`);
    return;
  }
  if (P.nextAt > now) {
    say('⏳', `You can ask again in ${secs(P.nextAt - now)}`, 'There’s a short wait between requests, so nobody gets flooded.');
    return;
  }
  const id = P.ctl.request(kind, data);
  P.nextAt = now + a.cooldown * 1000;
  P.pending = kind === 'message' ? null : { id, until: now + PENDING_MS };
  const what = REQUEST_TEXT[kind] ? REQUEST_TEXT[kind](data) : kind;
  audio.sfx('pop', el.toggle);
  say('🙋', kind === 'message' ? 'Message sent to the host' : `Asked the host to ${what}`);
  tickPartyWait();
}

function doRequest(kind, data, { guest = false } = {}) {
  if (kind === 'toggle') {
    if ((data === 'pause') === timer.running) toggleTimer(el.toggle);
  } else if (kind === 'skip') el.skip.click();
  else if (kind === 'reset') el.reset.click();
  else if (kind === 'mode' && MODES[data]) el.tabs[MODE_ORDER.indexOf(data)].click();
  else if (kind === 'more') addTime(clampInt(data, 1, 30, 1) * 60000, el.extend);
  else if (kind === 'break') {
    if (timer.mode === 'focus') el.skip.click();
  } else if (kind === 'sound' && data && audio.ambientKinds.includes(data.kind)) {
    if (Boolean(data.on) !== Boolean(sound.mix[data.kind] && sound.mix[data.kind].on)) setSound(data.kind, Boolean(data.on));
  } else if (kind === 'silence') {
    activeKinds().forEach((k) => setSound(k, false));
    afterSoundChange();
  } else if (kind === 'mix' && data) {
    const m = allMixes().find((x) => x.id === data.id);
    if (m) applyMix(m, el.mixes);
  } else if (kind === 'task' && typeof data === 'string' && data.trim()) addTask(data.trim().slice(0, 120), 1);
  else if (kind === 'done') {
    const t = tasks.find((x) => x.id === data);
    if (!t) return;
    if (!guest) {
      $(`.task[data-id="${CSS.escape(String(data))}"] .task-check`)?.click();
      return;
    }
    // A guest's tick: no celebration, and it doesn't count toward the host's stats.
    t.done = !t.done;
    if (t.done && activeTaskId === t.id) activeTaskId = tasks.find((x) => !x.done)?.id ?? null;
    audio.sfx(t.done ? 'check' : 'uncheck', el.taskList);
    save();
    renderTasks();
  }
}

// What an Add guest just did, for the host's quiet heads-up.
const DID_TEXT = {
  sound: (d) => `${d && d.on ? 'turned on' : 'turned off'} ${SOUND_INFO[d && d.kind] ? SOUND_INFO[d.kind].name.toLowerCase() : 'a sound'}`,
  silence: () => 'turned all the sounds off',
  mix: (d) => `played the ${d && d.name ? String(d.name).slice(0, 40) : ''} mix`,
  task: (d) => `added “${String(d || '').slice(0, 60)}”`,
  done: (d) => {
    const t = tasks.find((x) => x.id === d);
    return t ? `${t.done ? 'unticked' : 'ticked off'} “${t.title.slice(0, 60)}”` : 'ticked off a task';
  },
};

// On the host: every guest request comes through here, and the rules are checked here.
function onPartyRequest(g, r) {
  if (!P || P.role !== 'host') return;
  const rec = guestRec(g.id);
  const rules = settings.partyRules;
  const group = REQ_GROUP[r.kind];
  // What guests typed goes through the language filter; a mix is named by
  // the host's own list, never by what the guest says it's called.
  if ((r.kind === 'task' || r.kind === 'message') && typeof r.data === 'string') r.data = tidy(r.data);
  if (r.kind === 'mix') {
    const m = r.data && allMixes().find((x) => x.id === r.data.id);
    r.data = m ? { id: m.id, name: m.name } : null;
  }
  const now = Date.now();
  const no = (text, wait = 0) => P.ctl.answer(g.id, r.id, false, text, { auto: true, wait });
  if (!group) return;
  if (rec.role === 'watch') {
    no("You're watching, so you can't ask for changes.");
    return;
  }
  // A topic the host switched off is off for everyone, Add guests included.
  if (!rules[group]) {
    no(`The host isn't taking requests about ${GROUPS[group].toLowerCase()} right now.`);
    return;
  }
  // Only things that make sense here reach the host's screen.
  const d = r.data;
  const valid = {
    toggle: () => d === 'pause' || d === 'start',
    skip: () => true,
    reset: () => true,
    break: () => true,
    mode: () => typeof d === 'string' && Object.prototype.hasOwnProperty.call(MODES, d),
    more: () => Number.isFinite(Number(d)),
    sound: () => d && audio.ambientKinds.includes(d.kind),
    silence: () => activeKinds().length > 0,
    mix: () => Boolean(d),
    task: () => typeof d === 'string' && d.trim(),
    done: () => tasks.some((t) => t.id === d),
    message: () => typeof d === 'string' && d.trim(),
  }[r.kind];
  if (!valid || !valid()) {
    no("That didn't work.");
    return;
  }
  if (rec.role === 'add' && DIRECT_KINDS.includes(r.kind)) {
    rec.adds = rec.adds.filter((t) => now - t < ADD_WINDOW);
    if (rec.adds.length >= ADD_LIMIT) {
      no('Slow down a little: too many changes at once.', rec.adds[0] + ADD_WINDOW - now);
      return;
    }
    rec.adds.push(now);
    const did = DID_TEXT[r.kind](r.data);
    doRequest(r.kind, r.data, { guest: true });
    P.ctl.answer(g.id, r.id, true, '', { auto: true });
    toast({ icon: '✏️', title: `${g.name} ${did}`, duration: 2600, key: `party-did-${g.id}` });
    return;
  }
  if (rec.pendingUntil > now) {
    no('Wait for the host to answer your last request.', rec.pendingUntil - now);
    return;
  }
  // A second's grace, so a guest whose countdown just ended isn't refused.
  const wait = rec.lastAsk + rules.cooldown * 1000 - now;
  if (wait > 1000) {
    no(`You can ask again in ${secs(wait)}.`, wait);
    return;
  }
  // However many guests (or connections) there are, the host sees at most
  // three open requests, and one new one every couple of seconds.
  if (hostQueue.open >= 3 || now - hostQueue.last < 2500) {
    no(`${P.hostName} has a few requests already. Try again in a moment.`, 4000);
    return;
  }
  rec.lastAsk = now;
  rec.pendingUntil = r.kind === 'message' ? 0 : now + PENDING_MS;
  hostQueue.last = now;
  const what = REQUEST_TEXT[r.kind] ? REQUEST_TEXT[r.kind](r.data) : r.kind;
  // A soft, friendly ding: noticeable, never alarming.
  audio.softBell('half');
  if (document.visibilityState !== 'visible') showNotice(`${g.name} ${r.kind === 'message' ? 'says' : 'asks'}`, what);
  if (r.kind === 'message') {
    toast({ icon: '💬', title: `${g.name} says`, body: what, duration: 9000 });
    return;
  }
  // Counted as open until it's answered or its toast runs out.
  hostQueue.open += 1;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    hostQueue.open -= 1;
    rec.pendingUntil = 0;
  };
  setTimeout(close, 15000);
  toast({
    icon: '🙋',
    title: `${g.name} asks to ${what}`,
    duration: 15000,
    actions: [
      { label: 'Not now', kind: 'ghost', onClick: () => {
        close();
        if (P) P.ctl.answer(g.id, r.id, false);
      } },
      { label: 'Do it', onClick: () => {
        close();
        if (!P) return;
        doRequest(r.kind, r.data, { guest: true });
        P.ctl.answer(g.id, r.id, true);
      } },
    ],
  });
}

// Guests' taps on the controls turn into requests (capture phase, before the app's own handlers).
document.addEventListener('click', (e) => {
  if (!P || P.role !== 'guest') return;
  const t = e.target.closest('#btn-toggle, #mini-toggle, #btn-skip, #btn-reset, .mode-tab, #btn-extend, .chip[data-sound], .mix-card, .mix-remove, .mix-orbit, .task-check, .task-delete, .add-btn, #btn-flow-break');
  if (!t) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  if (t.matches('#btn-toggle, #mini-toggle')) askHost('toggle', timer.running ? 'pause' : 'start');
  else if (t.matches('#btn-skip, #btn-flow-break')) askHost('skip');
  else if (t.matches('#btn-reset')) askHost('reset');
  else if (t.matches('.mode-tab')) askHost('mode', t.dataset.mode);
  else if (t.matches('#btn-extend')) askHost('more', 1);
  else if (t.matches('.chip[data-sound]')) {
    const k = t.dataset.sound;
    if (k === 'off') {
      if (activeKinds().length) askHost('silence');
      else guestNote('🔇', 'Nothing is playing');
    } else askHost('sound', { kind: k, on: !(sound.mix[k] && sound.mix[k].on) });
  } else if (t.matches('.mix-remove')) askHost('sound', { kind: t.closest('.mix-row').dataset.kind, on: false });
  else if (t.matches('.mix-orbit')) guestNote('🎧', `${P.hostName} places the sounds`, 'Use the volume slider to make them quieter for you.');
  else if (t.matches('.mix-card')) {
    const m = allMixes().find((x) => x.id === t.dataset.mix);
    if (m && m.custom) guestNote('🎚️', "Your own mixes stay yours", `Ask ${P.hostName} for one of the built-in mixes, or for single sounds.`);
    else if (m) askHost('mix', { id: m.id, name: m.name });
  } else if (t.matches('.task-check')) askHost('done', t.closest('.task').dataset.id);
  else if (t.matches('.task-delete')) guestNote('🗑️', `Only ${P.hostName} can delete tasks`);
  else if (t.matches('.add-btn')) {
    const title = el.taskInput.value.trim();
    if (title) {
      askHost('task', title);
      el.taskInput.value = '';
    }
  }
}, true);
document.addEventListener('submit', (e) => {
  if (!P || P.role !== 'guest' || e.target !== el.taskForm) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  const title = el.taskInput.value.trim();
  if (title) {
    askHost('task', title);
    el.taskInput.value = '';
  }
}, true);
window.addEventListener('keydown', (e) => {
  if (!P || P.role !== 'guest' || e.metaKey || e.ctrlKey || e.altKey || $('dialog[open]')) return;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
  const key = e.key.toLowerCase();
  const map = { ' ': () => askHost('toggle', timer.running ? 'pause' : 'start'), s: () => askHost('skip'), r: () => askHost('reset'), 1: () => askHost('mode', 'focus'), 2: () => askHost('mode', 'short'), 3: () => askHost('mode', 'long'), '+': () => askHost('more', 1), '=': () => askHost('more', 1), m: () => (activeKinds().length ? askHost('silence') : guestNote('🔇', 'Nothing is playing')) };
  if (!map[key] || e.repeat) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  map[key]();
}, true);

$('#btn-party').addEventListener('click', (e) => {
  if (!party.supported) {
    toast({ icon: '🎉', title: "This browser can't join parties", body: 'Try a recent Chrome, Edge, Firefox or Safari.' });
    return;
  }
  renderPartyDialog();
  openSheet($('#party-dialog'), e.currentTarget);
});
$('#party-body').addEventListener('click', async (e) => {
  const id = e.target.closest('button') && e.target.closest('button').id;
  if (id === 'party-host') {
    e.target.disabled = true;
    await startParty();
    if ($('#party-host')) $('#party-host').disabled = false;
  } else if (id === 'party-copy') {
    const url = `${window.location.origin}${window.location.pathname}#party=${P.code}`;
    try {
      if (navigator.share && phoneLayout.matches) await navigator.share({ title: 'Join my focus party', text: `Join my Tempo focus party (code ${party.formatCode(P.code)}):`, url });
      else {
        await navigator.clipboard.writeText(url);
        toast({ icon: '🔗', title: 'Invite link copied', body: `Or share the code ${party.formatCode(P.code)}`, duration: 3500 });
      }
    } catch {
      /* cancelled or blocked */
    }
  } else if (e.target.closest('.party-kick') && P && P.role === 'host') {
    const gid = e.target.closest('.party-kick').dataset.guest;
    const m = P.members.find((x) => x.id === gid);
    P.ctl.remove(gid);
    guestRecs.delete(gid);
    // So they can't just join again: from now on the host lets people in.
    const was = settings.partyRules.admit;
    settings.partyRules.admit = true;
    P.ctl.setAdmit('ask');
    save();
    renderPartyDialog();
    if (m) toast({ icon: '👋', title: `Removed ${m.name}`, body: was ? '' : 'New people now need your OK to join (you can change that below).', duration: 4000 });
  } else if (id === 'party-end') leaveParty('Party ended');
  else if (id === 'party-leave') leaveParty('You left the party');
  else if (id === 'party-break') askHost('break');
});
// The host's rules and each guest's role.
$('#party-body').addEventListener('change', (e) => {
  if (!P || P.role !== 'host') return;
  const t = e.target;
  if (t.matches('.party-role') && ROLE_IDS.includes(t.value)) {
    const rec = guestRec(t.dataset.guest);
    rec.role = t.value;
    rec.adds = [];
    P.ctl.setAccess(t.dataset.guest, accessOf(rec));
    P.members = P.ctl.members();
    return;
  }
  if (t.id === 'party-default-role' && ROLE_IDS.includes(t.value)) settings.partyRules.role = t.value;
  else if (t.closest('.party-allow') && t.name in GROUPS) settings.partyRules[t.name] = t.checked;
  else if (t.id === 'party-cooldown') settings.partyRules = cleanRules({ ...settings.partyRules, cooldown: Number(t.value) });
  else if (t.id === 'party-admit') {
    settings.partyRules.admit = t.checked;
    P.ctl.setAdmit(t.checked ? 'ask' : 'open');
  } else if (t.id === 'party-filter') {
    settings.partyRules.filter = t.checked;
    queuePartyBroadcast(); // the host's task names go out filtered (or not) from now on
  }
  else return;
  save();
  shareAccess();
});
$('#party-body').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (e.target.id === 'party-msg-form') {
    const text = $('#party-msg').value.trim();
    if (text) askHost('message', text);
    $('#party-msg').value = '';
  } else if (e.target.id === 'party-join-form') {
    const code = party.normalizeCode($('#party-code').value);
    if (!code) {
      partyStatus('Party codes have 8 letters and numbers, like K7QX-2M9P.');
      return;
    }
    await joinParty(code);
  }
});
window.addEventListener('beforeunload', () => {
  if (P) (P.role === 'host' ? P.ctl.end() : P.ctl.leave());
});
// Opening an invite link: #party=K7QX2M9P
function offerParty() {
  const raw = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('party');
  if (!raw) return;
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
  const code = party.normalizeCode(raw);
  if (!code || P) return;
  renderPartyDialog(party.formatCode(code));
  openSheet($('#party-dialog'), $('#btn-party'));
  setTimeout(() => $('#party-name')?.focus(), 80);
}
window.addEventListener('hashchange', offerParty);

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
  flowBreak: $('#btn-flow-break'),
  invite: $('#btn-invite'),
  lengthBtn: $('#btn-length'),
  lengthPop: $('#length-pop'),
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
// A break earned in Flowtime replaces the usual length.
const sessionLength = () => (timer.mode !== 'focus' && timer.earned ? timer.earned : durationOf(timer.mode));
const totalMs = () => timer.total ?? sessionLength();
const remainingMs = () => (timer.running ? Math.max(0, timer.endAt - Date.now()) : timer.paused ?? totalMs());
const isFresh = () => !timer.running && timer.total == null && timer.paused == null;

// Flowtime: focus counts up until you stop, and you earn a break in
// proportion to how long you worked.
const FLOW_LAP = 3600e3; // the ring goes round once an hour, like a clock
const FLOW_NUDGE = 90 * 60000;
const FLOW_MAX = 3 * 3600e3; // a forgotten Flowtime session pauses itself here
const isFlow = () => timer.mode === 'focus' && (isFresh() ? settings.flow : timer.flow);
const flowElapsed = () => (timer.running ? Math.max(0, Date.now() - timer.startAt) : timer.paused ?? 0);
const elapsedMs = () => (timer.flow ? flowElapsed() : totalMs() - remainingMs());
const earnedBreak = (ms) => Math.min(90, Math.max(1, Math.round(ms / 60000 / settings.flowRatio))) * 60000;

let tickTimer = 0;
let endTimer = 0;

function schedule() {
  clearTimeout(tickTimer);
  clearTimeout(endTimer);
  if (!timer.running) return;
  if (timer.flow) {
    const elapsed = flowElapsed();
    if (elapsed >= FLOW_MAX) {
      capFlow();
      return;
    }
    endTimer = setTimeout(onTick, FLOW_MAX - elapsed + 20);
    tickTimer = setTimeout(onTick, 1000 - (elapsed % 1000) + 15);
    return;
  }
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
  if (timer.running && !timer.flow && Date.now() >= timer.endAt) {
    complete({ late: Date.now() - timer.endAt });
    return;
  }
  if (timer.running && timer.flow && !timer.nudged && flowElapsed() >= FLOW_NUDGE && flowElapsed() < FLOW_MAX) nudgeFlow();
  if (timer.running && !timer.flow) ringCheckpoints();
  renderTimer();
  schedule();
}

// Three hours without stopping usually means the timer was forgotten: pause
// there, keep the time, and let the person decide.
function capFlow() {
  timer.paused = FLOW_MAX;
  timer.running = false;
  afterTimerChange();
  toast({
    icon: '🌊',
    title: 'Flowtime paused at 3 hours',
    body: 'Still there? Take your break to log it, or reset if you stepped away.',
    duration: 15000,
    actions: [
      { label: 'Reset', kind: 'ghost', onClick: () => reset() },
      { label: 'Take my break', onClick: () => finishFlow() },
    ],
  });
}

// Optional soft bells: halfway through a session, and with a minute to go.
// Sessions too short for them to help stay quiet; a bell that was missed
// (the tab was asleep) isn't rung late.
function ringCheckpoints() {
  const total = totalMs();
  const rem = remainingMs();
  const elapsed = total - rem;
  let ring = null;
  if (timer.rung < 1 && total >= 10 * 60000 && elapsed >= total / 2) {
    timer.rung = 1;
    if (elapsed - total / 2 < 5000) ring = 'half';
  }
  if (timer.rung < 2 && total >= 5 * 60000 && rem <= 60000) {
    timer.rung = 2;
    if (rem > 55000) ring = 'last';
  }
  if (!ring) return;
  save();
  if (!settings.bells) return;
  audio.softBell(ring);
  fx.pop(el.time, 1.04);
  if (ring === 'last') announce('One minute left.');
}

// A long stretch in Flowtime gets one gentle reminder to rest.
function nudgeFlow() {
  timer.nudged = true;
  save();
  if (document.visibilityState !== 'visible') {
    showNotice(`${Math.round(flowElapsed() / 60000)} minutes in flow`, 'Brilliant focus. A break soon will help you keep it up.');
    return;
  }
  audio.sfx('on', el.time);
  toast({
    icon: '🌊',
    title: `${Math.round(flowElapsed() / 60000)} minutes in flow`,
    body: 'Brilliant focus. A break soon will help you keep it up.',
    duration: 12000,
    action: { label: 'Take my break', onClick: () => finishFlow() },
  });
}

/** End a Flowtime session and start the break you earned. */
function finishFlow() {
  if (!timer.flow || isFresh()) return;
  const ms = flowElapsed();
  if (ms < 60000) {
    reset();
    toast({ icon: '🌊', title: 'Under a minute', body: 'Nothing to log yet. Start again when you\'re ready.', duration: 4000 });
    return;
  }
  complete({ flowMs: ms });
}

function maybeOfferNotifications() {
  if (settings.notifyAsked || settings.notify || !('Notification' in window) || Notification.permission === 'denied') return;
  settings.notifyAsked = true;
  save();
  setTimeout(() => {
    toast({
      icon: '🔔',
      title: 'Want a nudge when time is up?',
      body: 'Get a notification even when Tempo is in another tab.',
      duration: 9000,
      action: {
        label: 'Turn on',
        onClick: async () => {
          const ok = await askNotificationPermission();
          settings.notify = ok;
          save();
          toast(ok ? { icon: '🔔', title: 'Notifications on' } : { icon: '🔕', title: 'Notifications are blocked', body: 'You can allow them in your browser settings.' });
        },
      },
    });
  }, 1500);
}

function start() {
  if (timer.running) return;
  if (timer.mode === 'focus') maybeOfferNotifications();
  if (isFresh()) timer.flow = timer.mode === 'focus' && settings.flow;
  if (timer.flow) {
    timer.startAt = Date.now() - (timer.paused ?? 0);
  } else {
    if (timer.total == null) timer.total = sessionLength();
    timer.endAt = Date.now() + (timer.paused ?? timer.total);
  }
  timer.paused = null;
  timer.running = true;
  afterTimerChange();
}

function pause() {
  if (!timer.running) return;
  timer.paused = timer.flow ? flowElapsed() : Math.max(0, timer.endAt - Date.now());
  timer.running = false;
  afterTimerChange();
}

/** Stretch or trim the current session (not before it has started). */
function addTime(ms, source) {
  if (isFresh() || timer.flow) return false;
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

// Tap the length (before starting) to pick another one quickly.
const LENGTHS = { focus: [15, 20, 25, 30, 45, 50, 60, 90], short: [3, 5, 10, 15], long: [10, 15, 20, 30] };

function renderLength() {
  const fresh = isFresh();
  el.lengthBtn.hidden = !fresh;
  el.lengthBtn.textContent = isFlow() ? '∞ Flowtime ▾' : `${Math.round(sessionLength() / 60000)} min ▾`;
  if (!fresh) closeLengthPop();
}

function openLengthPop() {
  const mode = timer.mode;
  const current = Math.round(sessionLength() / 60000);
  const opts = [...new Set([...LENGTHS[mode], current])].sort((a, b) => a - b);
  const flow = isFlow();
  const buttons = opts.map((m) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'length-opt pressable';
    b.dataset.min = String(m);
    b.textContent = String(m);
    b.setAttribute('aria-pressed', String(!flow && m === current));
    b.setAttribute('aria-label', `${m} minutes`);
    return b;
  });
  if (mode === 'focus') {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'length-opt is-flow pressable';
    b.dataset.min = 'flow';
    b.textContent = '∞ Flowtime';
    b.title = 'Count up and take a break when you\'re ready';
    b.setAttribute('aria-pressed', String(flow));
    buttons.push(b);
  }
  el.lengthPop.replaceChildren(...buttons);
  el.lengthPop.hidden = false;
  el.dial.classList.add('has-pop');
  el.lengthBtn.setAttribute('aria-expanded', 'true');
  fx.enter(el.lengthPop);
  audio.sfx('open', el.lengthBtn);
  el.lengthPop.querySelector('[aria-pressed="true"]')?.focus();
}

function closeLengthPop() {
  if (el.lengthPop.hidden) return;
  el.lengthPop.hidden = true;
  el.dial.classList.remove('has-pop');
  el.lengthBtn.setAttribute('aria-expanded', 'false');
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
  timer.flow = false;
  timer.startAt = 0;
  timer.nudged = false;
  timer.rung = 0;
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
  schedulePauseNudge();
}

// A session left paused for a while gets one gentle reminder.
let pauseNudge = 0;
function schedulePauseNudge() {
  clearTimeout(pauseNudge);
  if (timer.running || isFresh()) return;
  pauseNudge = setTimeout(() => {
    if (timer.running || isFresh()) return;
    const label = timer.flow ? 'Flowtime' : MODES[timer.mode].label.toLowerCase();
    if (document.visibilityState === 'visible') {
      audio.sfx('on', el.toggle);
      toast({ icon: '⏸️', title: `Your ${label} is still paused`, body: `${lastClock} to go. Pick up where you left off?`, duration: 12000, action: { label: 'Resume', onClick: () => { if (!timer.running) toggleTimer(el.toggle); } } });
    } else {
      showNotice(`Your ${label} is still paused`, 'Pick up where you left off?');
    }
  }, 10 * 60000);
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

function switchTo(mode, { earned = null } = {}) {
  timer.mode = mode;
  clearSession();
  timer.earned = mode === 'focus' ? null : earned;
  applyMode();
  afterTimerChange();
  renderTasks();
}

function complete({ late = 0, flowMs = 0 } = {}) {
  const ended = timer.mode;
  const goalBefore = goalProgress().value;
  const endedAt = timer.running && !flowMs ? timer.endAt : Date.now();
  if (ended === 'focus') {
    const task = tasks.find((t) => t.id === activeTaskId);
    // Another open tab may have recorded this same session already.
    if (!history.some((h) => h.s && h.t === endedAt)) {
      history.push({
        t: endedAt,
        m: Math.round((flowMs || totalMs()) / 60000),
        s: 1,
        ...(task ? { task: task.title } : {}),
        ...(timer.distractions ? { d: timer.distractions } : {}),
        ...(flowMs ? { f: 1 } : {}),
      });
    }
    if (task && !task.done) task.pomos += 1;
    timer.cycle += 1;
  } else if (ended === 'long') {
    timer.cycle = 0;
  }
  const next = nextAfter(ended);
  let earned = null;
  if (flowMs) earned = next === 'long' ? Math.max(earnedBreak(flowMs), durationOf('long')) : earnedBreak(flowMs);
  switchTo(next, { earned });
  const breakMin = Math.round(totalMs() / 60000);
  renderGoal();

  // Stay quiet about a session that ended long ago while the page was closed.
  if (late > 60000) {
    if (ended === 'focus') checkFocusAchievements(endedAt, next, { quiet: true });
    return;
  }

  if (settings.chime) audio.chime(next === 'focus' ? 'focus' : 'break', settings.chimeStyle);
  if (ended === 'focus' && isZen()) unlock('zen', { delay: 1600 });
  if (flowMs >= 3600e3) unlock('flow', { delay: 2200 });
  if (settings.sfx) fx.haptic([140, 90, 140, 90, 260]);
  if (!flowMs) notify(ended, next, breakMin);
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
      icon: flowMs ? '🌊' : '☕',
      title: flowMs ? `${fmtMinutes(Math.round(flowMs / 60000))} in flow. How did it go?` : 'Focus session done. How did it go?',
      body: flowMs
        ? `You earned a ${breakMin}-minute break${auto ? '. It has started.' : '.'}`
        : auto ? `Your ${breakMin}-minute break has started.` : `Time for a ${breakMin}-minute break.`,
      duration: 12000,
      actions: [
        ...RATINGS.map((emoji, i) => ({ label: emoji, kind: 'emoji', ariaLabel: RATING_NAMES[i], title: RATING_NAMES[i], onClick: rate(i + 1) })),
        { label: '📝', kind: 'emoji', ariaLabel: 'Note what you got done', title: 'Note what you got done', onClick: () => openNote(endedAt, el.toggle) },
        ...(auto ? [] : [startAction]),
      ],
    });
  } else if (!auto) {
    toast({ icon: '🎯', title: 'Break is over', body: 'Ready when you are.', duration: 9000, action: startAction });
  }
  if (ended === 'focus') {
    const today = dayTotals(new Date());
    const goal = goalProgress(today);
    const hitGoal = goalBefore < goal.target && goal.value >= goal.target;
    if (hitGoal) {
      setTimeout(() => {
        const what = settings.goalType === 'minutes' ? `${fmtMinutes(today.m)} of focus` : `${today.s} focus sessions`;
        toast({ icon: '🎯', title: 'Daily goal reached!', body: `${what} today. Brilliant work.`, tone: 'gold' });
        fx.celebrate(el.goal);
        fx.pop(el.goal, 1.2);
        audio.fanfare();
      }, 1400);
    }
    checkFocusAchievements(endedAt, next, { delay: hitGoal ? 3000 : 1400 });
  }
}

function skip() {
  if (timer.flow && !isFresh()) {
    finishFlow();
    return;
  }
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
  const flow = isFlow();
  const rem = remainingMs();
  const elapsed = flow ? flowElapsed() : 0;
  const secs = flow ? Math.floor(elapsed / 1000) : Math.ceil(rem / 1000);
  const clock = fmtClock(secs);

  if (clock !== lastClock || force) {
    renderDigits(clock, !force && timer.running);
    lastClock = clock;
    el.time.setAttribute('aria-label', `${Math.floor(secs / 60)} minutes ${secs % 60} seconds ${flow ? 'of focus so far' : 'remaining'}`);
    const emoji = flow ? '🌊' : { focus: '🎯', short: '☕', long: '🌿' }[timer.mode];
    document.title = isFresh() ? 'Tempo · Focus Timer' : `${emoji} ${clock} · ${flow ? 'Flow' : MODES[timer.mode].label} · Tempo`;

    if (!flow && timer.running && secs > 0 && secs <= 3 && !force && document.visibilityState === 'visible') {
      audio.sfx('tick', el.time);
      fx.pop(el.time, 1.05);
    }
  }

  // In Flowtime the ring fills like a clock, one lap an hour.
  const f = flow ? (elapsed % FLOW_LAP) / FLOW_LAP : Math.max(0, Math.min(1, rem / totalMs()));
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
  el.miniMode.textContent = flow ? 'Flowtime' : MODES[timer.mode].label;
  el.extend.hidden = isFresh() || flow;
  el.invite.hidden = !(timer.running && timer.mode === 'focus' && !timer.flow);
  el.body.classList.toggle('is-flow', flow);
  el.flowBreak.hidden = !flow || isFresh();
  if (flow) {
    const mins = Math.round(earnedBreak(elapsed) / 60000);
    el.flowBreak.textContent = `☕ Break · ${mins} min`;
    el.flowBreak.setAttribute('aria-label', `Finish and take a ${mins}-minute break`);
  }
  el.skip.title = flow && !isFresh() ? 'Finish and take your break (S)' : 'Skip (S)';
  el.skip.setAttribute('aria-label', flow && !isFresh() ? 'Finish and take your break' : 'Skip to next session');
  renderDistractions();
  renderLength();
  el.toggle.setAttribute('aria-pressed', String(timer.running));
  el.toggleLabel.textContent = timer.running ? 'Pause' : isFresh() ? 'Start' : 'Resume';
  syncSystemStatus(flow ? Math.floor(elapsed / 60000) : Math.ceil(rem / 60000), flow);
}

// Outside the page: minutes on the installed app's icon, and the session in
// the system's media controls (lock screen, media keys).
let systemKey = '';
function syncSystemStatus(mins, flow) {
  const fresh = isFresh();
  const key = `${fresh}:${timer.running}:${timer.mode}:${mins}:${flow}`;
  if (key === systemKey) return;
  systemKey = key;
  try {
    if ('setAppBadge' in navigator) {
      if (fresh) navigator.clearAppBadge().catch(() => {});
      else navigator.setAppBadge(Math.max(0, mins)).catch(() => {});
    }
  } catch {
    /* not installed */
  }
  if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return;
  try {
    const label = flow ? 'Flowtime' : MODES[timer.mode].label;
    const title = fresh ? `Ready: ${label.toLowerCase()}` : flow ? `${label} · ${mins} min so far` : `${label} · ${mins} min left`;
    const playing = activeKinds().map((k) => SOUND_INFO[k].name).join(' + ');
    navigator.mediaSession.metadata = new MediaMetadata({
      title: `${title}${timer.running || fresh ? '' : ' (paused)'}`,
      artist: 'Tempo',
      album: playing || 'Focus timer',
      artwork: [
        { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      ],
    });
    navigator.mediaSession.playbackState = timer.running ? 'playing' : 'paused';
  } catch {
    /* unsupported */
  }
}

if ('mediaSession' in navigator) {
  const handle = (action, fn) => {
    try {
      navigator.mediaSession.setActionHandler(action, fn);
    } catch {
      /* this action isn't supported */
    }
  };
  handle('play', () => { if (!timer.running) toggleTimer(el.toggle); });
  handle('pause', () => { if (timer.running) toggleTimer(el.toggle); });
  handle('nexttrack', () => el.skip.click());
  handle('stop', () => { if (activeKinds().length) $('.chip[data-sound="off"]').click(); });
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
  if (isFlow()) return 'Flowtime · break when you\'re ready';
  const pos = (timer.cycle % settings.longEvery) + 1;
  return MODES[timer.mode].note(pos, settings.longEvery);
}

// Something nice to do with a break.
const BREAK_IDEAS = [
  ['🙆', 'Stand up and stretch your arms over your head'],
  ['💧', 'Drink a glass of water'],
  ['👀', 'Look at something far away for 20 seconds'],
  ['🌬️', 'Take five slow breaths, out longer than in'],
  ['🔄', 'Roll your shoulders back ten times'],
  ['🚶', 'Walk around the room, or over to a window'],
  ['😌', 'Close your eyes and relax your jaw'],
  ['✋', 'Shake out your hands and wrists'],
  ['☀️', 'Get some daylight on your face'],
  ['🦶', 'Do ten slow calf raises'],
  ['🪟', 'Open a window for some fresh air'],
  ['🪴', 'Water a plant, or tidy one small thing'],
  ['📝', 'Jot down your next step, so you can start fast'],
  ['🍎', 'Have a piece of fruit or a handful of nuts'],
  ['🤸', 'Reach down towards your toes, slowly'],
  ['🧊', 'Splash some cold water on your face'],
];
const LONG_IDEAS = [
  ['🌳', 'Go for a short walk outside'],
  ['🍵', 'Make a cup of tea or coffee'],
  ['🍽️', 'Eat something proper, away from the screen'],
  ['📞', 'Call or message someone you like'],
];
let ideaIndex = -1;
let ideaFor = '';

function renderBreakIdea({ next = false } = {}) {
  const box = $('#break-idea');
  if (timer.mode === 'focus') {
    box.hidden = true;
    ideaFor = '';
    return;
  }
  const pool = timer.mode === 'long' ? [...LONG_IDEAS, ...BREAK_IDEAS] : BREAK_IDEAS;
  if (next || ideaFor !== timer.mode || ideaIndex < 0 || ideaIndex >= pool.length) {
    let i;
    do i = Math.floor(Math.random() * pool.length);
    while (pool.length > 1 && i === ideaIndex);
    ideaIndex = i;
    ideaFor = timer.mode;
  }
  const [icon, text] = pool[ideaIndex];
  $('#break-idea-text').textContent = `${icon} ${text}`;
  box.hidden = false;
}

$('#btn-next-idea').addEventListener('click', (e) => {
  renderBreakIdea({ next: true });
  audio.sfx('tap', e.currentTarget);
  const svg = e.currentTarget.querySelector('svg');
  svg.classList.remove('spin');
  void svg.getBoundingClientRect();
  svg.classList.add('spin');
  fx.pop($('#break-idea-text'), 1.04);
});

function applyMode() {
  const mode = timer.mode;
  el.body.dataset.mode = mode;
  el.tabs.forEach((t) => t.setAttribute('aria-selected', String(t.dataset.mode === mode)));
  el.modes.style.setProperty('--i', String(MODE_ORDER.indexOf(mode)));
  breathPhase = -1;
  delete el.dial.dataset.breath;
  el.sessionLabel.textContent = sessionNote();
  renderDots();
  renderBreakIdea();
  updateThemeColor();
  renderTimer(true);
}

// The background drifts with the day: a peach dawn, a golden evening, an
// indigo night.
function syncDaypart() {
  const h = new Date().getHours();
  const part = h >= 5 && h < 9 ? 'dawn' : h >= 9 && h < 17 ? 'day' : h >= 17 && h < 21 ? 'dusk' : 'night';
  if (settings.daySky) el.body.dataset.daypart = part;
  else delete el.body.dataset.daypart;
}
setInterval(syncDaypart, 5 * 60000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) syncDaypart(); });

function updateThemeColor() {
  requestAnimationFrame(() => {
    const c = getComputedStyle(el.body).getPropertyValue('--bg').trim();
    if (c && el.metaTheme) el.metaTheme.content = c;
    scenery.refresh();
  });
}

function applyTheme() {
  syncDaypart();
  if (settings.theme === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = settings.theme;
  el.body.dataset.palette = settings.palette;
  favKey = '';
  renderFavicon(lastFraction);
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
      mode: `${isFlow() ? 'Flowtime' : MODES[timer.mode].label}${paused ? ' · paused' : ''}`,
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
    wakeZen();
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

// In zen mode the cursor and the exit button fade away when you're still.
let idleTimer = 0;
function wakeZen() {
  el.body.classList.remove('is-idle');
  clearTimeout(idleTimer);
  if (isZen()) idleTimer = setTimeout(() => { if (isZen()) el.body.classList.add('is-idle'); }, 3000);
}
['pointermove', 'pointerdown', 'keydown'].forEach((t) => document.addEventListener(t, wakeZen, { passive: true }));

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

async function notify(ended, next, breakMin) {
  const title = ended === 'focus' ? 'Focus session done' : 'Break is over';
  const body =
    next === 'focus'
      ? 'Ready for the next focus session?'
      : `Nice work. Take ${breakMin} minutes to recharge.`;
  await showNotice(title, body);
}

async function showNotice(title, body) {
  if (!settings.notify || !('Notification' in window) || Notification.permission !== 'granted') return;
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

// "#work" or "#study" in a task's name becomes a coloured tag.
const TAG_RE = /(^|\s)#([\p{L}\p{N}_-]{1,24})/gu;
const TAG_COLORS = 8; // --tag-0 … --tag-7 in the stylesheet

function splitTags(title = '') {
  const tags = [];
  const name = title
    .replace(TAG_RE, (_, pre, tag) => {
      const t = tag.toLowerCase();
      if (!tags.includes(t)) tags.push(t);
      return pre;
    })
    .replace(/\s{2,}/g, ' ')
    .trim();
  // label: the name, or the tags themselves for a name that is only tags.
  return { name, tags, label: name || (tags.length ? tags.map((t) => `#${t}`).join(' ') : title) };
}

// Each new tag takes the next colour, so the first eight never clash.
let tagSaveQueued = false;
function tagColor(tag) {
  const map = counters.tagColors;
  if (!(tag in map)) {
    map[tag] = Object.keys(map).length % TAG_COLORS;
    if (!tagSaveQueued) {
      tagSaveQueued = true;
      queueMicrotask(() => {
        tagSaveQueued = false;
        save();
      });
    }
  }
  return `var(--tag-${map[tag]})`;
}

function tagPill(tag) {
  const s = document.createElement('span');
  s.className = 'tag';
  s.style.setProperty('--tag', tagColor(tag));
  s.textContent = tag;
  return s;
}

/** A task's name followed by its tag pills. */
function nameWithTags(title, nameClass) {
  const { name, tags } = splitTags(title);
  const pills = tags.map(tagPill);
  if (!name) return pills;
  const n = document.createElement('span');
  n.className = nameClass;
  n.textContent = name;
  return [n, ...pills];
}

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
  title.className = 'task-name';
  title.append(...nameWithTags(task.title, 'task-title'));
  if (task.daily) {
    const rep = document.createElement('span');
    rep.className = 'task-repeat';
    rep.textContent = '🔁';
    rep.title = 'Repeats every day';
    rep.setAttribute('role', 'img');
    rep.setAttribute('aria-label', 'Repeats every day');
    title.append(rep);
  }
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
  let daily = Boolean(task.daily);
  const repeat = document.createElement('button');
  repeat.type = 'button';
  repeat.className = 'task-repeat-btn pressable';
  repeat.textContent = '🔁';
  repeat.title = 'Repeat every day';
  repeat.setAttribute('aria-label', 'Repeat every day');
  repeat.setAttribute('aria-pressed', String(daily));
  // Keep focus in the name field, so the edit doesn't end on this tap.
  repeat.addEventListener('pointerdown', (e) => e.preventDefault());
  repeat.addEventListener('click', () => {
    daily = !daily;
    repeat.setAttribute('aria-pressed', String(daily));
    audio.sfx(daily ? 'on' : 'off', repeat);
    fx.pop(repeat, 1.15);
  });
  form.append(input, est, repeat);
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
      if (daily && !task.daily) task.day = todayKey();
      if (daily) task.daily = true;
      else {
        delete task.daily;
        delete task.day;
      }
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
  if (active) el.currentTaskTitle.replaceChildren(...nameWithTags(active.title, 'current-task-name'));
  el.clearDone.hidden = !tasks.some((t) => t.done && !t.daily);
  renderSummary();
}

// A new day: daily tasks come back unticked, with a fresh count.
function rollOverDailyTasks() {
  const k = todayKey();
  let changed = false;
  for (const t of tasks) {
    if (!t.daily || t.day === k) continue;
    t.day = k;
    t.done = false;
    t.pomos = 0;
    delete t.counted;
    changed = true;
  }
  if (!changed) return;
  save();
  renderTasks();
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) rollOverDailyTasks(); });
setInterval(rollOverDailyTasks, 5 * 60000);

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
  let rem = timer.flow ? Math.max(0, durationOf('focus') - flowElapsed()) : remainingMs();
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
  { id: 'flow', icon: '🌊', name: 'In the zone', desc: 'Stay in Flowtime for an hour' },
  { id: 'scribe', icon: '📝', name: 'Note taker', desc: 'Write notes on five sessions' },
  { id: 'keeper', icon: '🌱', name: 'Intention keeper', desc: 'Tick off your intention on three days' },
  { id: 'tags', icon: '🏷️', name: 'Tag team', desc: 'Focus on three different #tags in a week' },
  { id: 'commuter', icon: '🚆', name: 'Commuter', desc: 'Finish a focus session on the train ride' },
  { id: 'bookworm', icon: '📚', name: 'Bookworm', desc: 'Finish a focus session in the study hall' },
  { id: 'sharer', icon: '🔗', name: 'Pass it on', desc: 'Share a sound mix' },
  { id: 'power', icon: '⌨️', name: 'Power user', desc: 'Run ten commands from the search' },
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

// The daily goal counts focus sessions, or minutes of focus (handy with Flowtime).
function goalProgress(totals = dayTotals(new Date())) {
  return settings.goalType === 'minutes'
    ? { value: totals.m, target: settings.goalMinutes, unit: 'minutes of focus' }
    : { value: totals.s, target: settings.goal, unit: 'focus sessions' };
}

function renderGoal() {
  const { value, target, unit } = goalProgress();
  const f = Math.min(1, value / target);
  el.goalFill.style.strokeDasharray = `${GOAL_C}`;
  el.goalFill.style.strokeDashoffset = `${GOAL_C * (1 - f)}`;
  el.goalCount.textContent = String(value);
  el.goalTarget.textContent = settings.goalType === 'minutes' ? `${target}m` : String(target);
  el.goal.classList.toggle('is-done', value >= target);
  el.goal.setAttribute('aria-label', `Daily goal: ${value} of ${target} ${unit}. Open stats.`);
  el.goal.title = value >= target ? 'Daily goal reached!' : `Daily goal: ${target} ${unit}`;
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
  if (goalProgress(today).value >= goalProgress(today).target) unlock('goal', opts);
  if (next === 'long') unlock('deep', opts);
  if (streak >= 3) unlock('streak3', opts);
  if (streak >= 7) unlock('streak7', opts);
  if (total >= 10) unlock('ten', opts);
  if (total >= 50) unlock('fifty', opts);
  if (hour >= 4 && hour < 8) unlock('early', opts);
  if (hour >= 22 || hour < 4) unlock('night', opts);
  if (today.m >= 240) unlock('marathon', opts);
  const playing = activeKinds();
  if (playing.includes('train')) unlock('commuter', opts);
  if (playing.includes('study')) unlock('bookworm', opts);
  const weekTags = new Set();
  for (const h of history) if (h.task && h.t > endedAt - 7 * DAY) splitTags(h.task).tags.forEach((t) => weekTags.add(t));
  if (weekTags.size >= 3) unlock('tags', opts);
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
  renderTimeline();
  renderTopTasks();
  renderWeekReview();
  renderRecords();
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
  list.replaceChildren(...recent.map((h) => logItem(h, fmtWhen(h.t))));
}

function logItem(h, whenText) {
  const li = document.createElement('li');
  li.className = `log-item${h.s ? '' : ' is-partial'}`;
  const when = document.createElement('span');
  when.className = 'log-when';
  when.textContent = whenText;
  const what = document.createElement('span');
  what.className = 'log-what';
  if (h.task) what.append(...nameWithTags(h.task, 'log-name'));
  else what.textContent = h.f ? 'Flow session' : h.s ? 'Focus session' : 'Focus (ended early)';
  if (h.r || h.d || h.f) {
    const meta = document.createElement('span');
    meta.className = 'log-meta';
    meta.textContent = [h.f ? '🌊' : '', h.r ? RATINGS[h.r - 1] : '', h.d ? `⚡${h.d}` : ''].filter(Boolean).join(' ');
    meta.title = [h.f ? 'Flowtime' : '', h.r ? `Felt ${RATING_NAMES[h.r - 1].toLowerCase()}` : '', h.d ? `${h.d} distraction${h.d === 1 ? '' : 's'}` : ''].filter(Boolean).join(', ');
    what.append(' ', meta);
  }
  const dur = document.createElement('span');
  dur.className = 'log-dur';
  dur.textContent = fmtMinutes(h.m);
  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'log-note-btn pressable';
  edit.dataset.t = String(h.t);
  edit.innerHTML = ICON_EDIT;
  edit.title = h.n ? 'Edit note' : 'Add a note';
  edit.setAttribute('aria-label', `${h.n ? 'Edit the note for' : 'Add a note to'} the session at ${new Date(h.t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`);
  li.append(when, what, dur, edit);
  if (h.n) {
    const note = document.createElement('p');
    note.className = 'log-note';
    note.textContent = h.n;
    li.append(note);
  }
  return li;
}

// Notes on sessions: what you got done.
let noteFor = null;

function openNote(t, from) {
  const h = history.find((x) => x.t === t);
  if (!h) return;
  noteFor = t;
  const when = new Date(h.t).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  $('#note-session').textContent = `${when} · ${fmtMinutes(h.m)}${h.task ? ` · ${splitTags(h.task).label}` : ''}`;
  const text = $('#note-text');
  text.value = h.n || '';
  $('#note-count').textContent = `${text.value.length}/140`;
  openSheet($('#note-dialog'), from);
  setTimeout(() => text.focus(), 60);
}

$('#note-text').addEventListener('input', (e) => {
  $('#note-count').textContent = `${e.target.value.length}/140`;
});
$('#note-text').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $('#note-form').requestSubmit();
  }
});
$('#note-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const h = history.find((x) => x.t === noteFor);
  const text = $('#note-text').value.trim().slice(0, 140);
  if (h) {
    if (text) h.n = text;
    else delete h.n;
    save();
    if (history.filter((x) => x.n).length >= 5) unlock('scribe', { delay: 900 });
    renderLog();
    renderDayDetail();
  }
  audio.sfx(text ? 'check' : 'off', $('.note-save'));
  closeSheet($('#note-dialog'));
  if (text) toast({ icon: '📝', title: 'Note saved', body: text, duration: 2500 });
});
document.addEventListener('click', (e) => {
  const b = e.target.closest('.log-note-btn');
  if (b) openNote(Number(b.dataset.t), b);
});

// ----- Today's intention

function renderIntention() {
  if (intention.d !== todayKey()) intention = cleanIntention(null);
  const input = $('#intention-input');
  if (document.activeElement !== input) input.value = intention.text;
  const form = $('#intention-form');
  form.classList.toggle('is-set', Boolean(intention.text));
  form.classList.toggle('is-done', Boolean(intention.text && intention.done));
  const done = $('#btn-intention-done');
  done.hidden = !intention.text;
  done.setAttribute('aria-pressed', String(Boolean(intention.done)));
  done.setAttribute('aria-label', intention.done ? 'Today\'s intention is done. Undo' : 'Mark today\'s intention as done');
}

$('#btn-intention-done').addEventListener('click', (e) => {
  const btn = e.currentTarget;
  intention.done = !intention.done;
  if (intention.done && !counters.intentionDays.includes(intention.d)) counters.intentionDays.push(intention.d);
  save();
  renderIntention();
  if (intention.done && counters.intentionDays.length >= 3) unlock('keeper', { delay: 2600 });
  fx.pop(btn, 1.25);
  if (intention.done) {
    const form = $('#intention-form');
    fx.celebrate(form);
    audio.fanfare();
    toast({ icon: '🌱', title: 'Intention done!', body: intention.text, tone: 'gold', duration: 4000 });
  } else {
    audio.sfx('uncheck', btn);
  }
});

function saveIntention({ celebrate = false } = {}) {
  const input = $('#intention-input');
  const text = input.value.trim().slice(0, 100);
  if (text === intention.text && intention.d === todayKey()) return;
  intention = { d: todayKey(), text, done: text === intention.text ? intention.done : false };
  save();
  renderIntention();
  if (celebrate && text) {
    const form = $('#intention-form');
    audio.sfx('check', form);
    fx.pop(form, 1.04);
    fx.burst(form, { count: 10, spread: 60, size: 5 });
  }
}

$('#intention-form').addEventListener('submit', (e) => {
  e.preventDefault();
  saveIntention({ celebrate: true });
  $('#intention-input').blur();
});
$('#intention-input').addEventListener('blur', () => saveIntention());
$('#intention-input').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.stopPropagation();
    e.target.value = intention.text;
    e.target.blur();
  }
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') renderIntention();
});
renderIntention();

// Personal bests over everything recorded.
function renderRecords() {
  const focus = history.filter((h) => h.s);
  $('#records-section').hidden = focus.length < 3;
  if (focus.length < 3) return;
  const dateOf = (t) => new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric', year: new Date(t).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
  const rows = [];
  const longest = focus.reduce((a, b) => (b.m > a.m ? b : a));
  rows.push(['⏳', 'Longest session', `${fmtMinutes(longest.m)} · ${dateOf(longest.t)}`]);
  const byDay = new Map();
  for (const h of history) {
    const d = new Date(h.t);
    d.setHours(0, 0, 0, 0);
    byDay.set(d.getTime(), (byDay.get(d.getTime()) || 0) + h.m);
  }
  const [bestDay, bestDayM] = [...byDay.entries()].sort((a, b) => b[1] - a[1])[0];
  rows.push(['🌟', 'Best day', `${fmtMinutes(bestDayM)} · ${dateOf(bestDay)}`]);
  const byWeek = new Map();
  for (const [t, m] of byDay) {
    const d = new Date(t);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    byWeek.set(d.getTime(), (byWeek.get(d.getTime()) || 0) + m);
  }
  const [bestWeek, bestWeekM] = [...byWeek.entries()].sort((a, b) => b[1] - a[1])[0];
  rows.push(['📆', 'Best week', `${fmtMinutes(bestWeekM)} · from ${dateOf(bestWeek)}`]);
  const days = [...byDay.keys()].sort((a, b) => a - b);
  let run = 0;
  let best = 0;
  let prev = null;
  for (const t of days) {
    const next = prev == null ? null : new Date(prev);
    if (next) next.setDate(next.getDate() + 1);
    run = next && next.getTime() === t ? run + 1 : 1;
    best = Math.max(best, run);
    prev = t;
  }
  rows.push(['🔥', 'Longest streak', `${best} ${best === 1 ? 'day' : 'days'}`]);
  const since = Math.min(...history.map((h) => h.t));
  rows.push(['🧭', 'Since', `${dateOf(since)} · ${fmtMinutes(history.reduce((n, h) => n + h.m, 0))} in all`]);
  $('#records-list').replaceChildren(
    ...rows.map(([icon, label, value], i) => {
      const li = document.createElement('li');
      li.style.setProperty('--delay', `${i * 50}ms`);
      const ic = document.createElement('span');
      ic.className = 'review-icon';
      ic.setAttribute('aria-hidden', 'true');
      ic.textContent = icon;
      const l = document.createElement('span');
      l.className = 'review-label';
      l.textContent = label;
      const v = document.createElement('span');
      v.className = 'review-value';
      v.textContent = value;
      li.append(ic, l, v);
      return li;
    }),
  );
}

// This week (from Monday) at a glance.
function renderWeekReview() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  const week = history.filter((h) => h.t >= start.getTime());
  const box = $('#week-review');
  box.hidden = week.length === 0;
  if (!week.length) return;
  const rows = [];
  const focus = week.filter((h) => h.s);
  const mins = week.reduce((n, h) => n + h.m, 0);
  rows.push(['🎯', 'Focus', `${fmtMinutes(mins)} · ${focus.length} ${focus.length === 1 ? 'session' : 'sessions'}`]);
  const byDay = new Map();
  for (const h of week) {
    const k = new Date(h.t).toDateString();
    byDay.set(k, (byDay.get(k) || 0) + h.m);
  }
  const [bestDay, bestM] = [...byDay.entries()].sort((a, b) => b[1] - a[1])[0];
  if (byDay.size > 1) rows.push(['📅', 'Best day', `${new Date(bestDay).toLocaleDateString([], { weekday: 'long' })} · ${fmtMinutes(bestM)}`]);
  const tags = new Map();
  for (const h of week) if (h.task) splitTags(h.task).tags.forEach((t) => tags.set(t, (tags.get(t) || 0) + h.m));
  if (tags.size) {
    const [tag, m] = [...tags.entries()].sort((a, b) => b[1] - a[1])[0];
    rows.push(['🏷️', 'Top tag', `#${tag} · ${fmtMinutes(m)}`]);
  }
  const startKey = start.getTime();
  const kept = counters.intentionDays.filter((d) => {
    const [y, mo, da] = d.split('-').map(Number);
    return new Date(y, mo, da).getTime() >= startKey;
  }).length;
  if (kept) rows.push(['🌱', 'Intentions kept', `${kept} ${kept === 1 ? 'day' : 'days'}`]);
  const rated = focus.filter((h) => h.r);
  if (rated.length) {
    const avg = Math.round(rated.reduce((n, h) => n + h.r, 0) / rated.length);
    rows.push([RATINGS[avg - 1], 'Felt', RATING_NAMES[avg - 1]]);
  }
  const flows = week.filter((h) => h.f);
  if (flows.length) rows.push(['🌊', 'Longest flow', fmtMinutes(Math.max(...flows.map((h) => h.m)))]);
  const notes = week.filter((h) => h.n).length;
  if (notes) rows.push(['📝', 'Notes', `${notes} ${notes === 1 ? 'session' : 'sessions'}`]);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  const fmt = (d) => d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  $('#week-range').textContent = `${fmt(start)} – ${fmt(end)}`;
  $('#review-list').replaceChildren(
    ...rows.map(([icon, label, value], i) => {
      const li = document.createElement('li');
      li.style.setProperty('--delay', `${i * 50}ms`);
      const ic = document.createElement('span');
      ic.className = 'review-icon';
      ic.setAttribute('aria-hidden', 'true');
      ic.textContent = icon;
      const l = document.createElement('span');
      l.className = 'review-label';
      l.textContent = label;
      const v = document.createElement('span');
      v.className = 'review-value';
      v.textContent = value;
      li.append(ic, l, v);
      return li;
    }),
  );
}

// A strip showing when today's sessions happened.
function renderTimeline() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const today = history.filter((h) => h.t >= start.getTime());
  $('#timeline-section').hidden = today.length === 0;
  if (!today.length) return;
  const hourOf = (ts) => (ts - start.getTime()) / 3600e3;
  let from = Math.floor(Math.max(0, Math.min(...today.map((h) => hourOf(h.t - h.m * 60000)))));
  let to = Math.ceil(Math.max(...today.map((h) => hourOf(h.t))));
  from = Math.max(0, Math.min(from, 8));
  to = Math.min(24, Math.max(to, from + 6));
  const span = to - from;
  const fmtHour = (hr) => new Date(2000, 0, 1, hr % 24).toLocaleTimeString([], { hour: 'numeric' });
  $('#timeline').replaceChildren(
    ...today.map((h) => {
      const b = document.createElement('span');
      b.className = `tl-block${h.s ? '' : ' is-partial'}`;
      const s0 = Math.max(0, hourOf(h.t - h.m * 60000));
      const s1 = hourOf(h.t);
      b.style.left = `${((s0 - from) / span) * 100}%`;
      b.style.width = `${Math.max(0.6, ((s1 - s0) / span) * 100)}%`;
      const label = `${new Date(h.t - h.m * 60000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}: ${fmtMinutes(h.m)}${h.task ? ` · ${h.task}` : ''}`;
      b.title = label;
      b.setAttribute('role', 'img');
      b.setAttribute('aria-label', label);
      return b;
    }),
  );
  const ticks = [];
  for (let hr = from; hr <= to; hr += span > 12 ? 3 : 2) {
    const t = document.createElement('span');
    t.style.left = `${((hr - from) / span) * 100}%`;
    t.textContent = fmtHour(hr);
    ticks.push(t);
  }
  $('#timeline-axis').replaceChildren(...ticks);
}

// Minutes per task over the last 7 days.
function renderTopTasks() {
  const since = Date.now() - 7 * DAY;
  const by = new Map();
  for (const h of history) {
    if (h.t < since) continue;
    const k = h.task ? splitTags(h.task).label : 'Focus without a task';
    by.set(k, (by.get(k) || 0) + h.m);
  }
  renderTagBars(since);
  const rows = [...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  const max = rows.length ? rows[0][1] : 0;
  const list = $('#top-tasks');
  if (!rows.length) {
    const li = document.createElement('li');
    li.className = 'log-empty';
    li.textContent = 'Tap a task before you focus to see where your time goes.';
    list.replaceChildren(li);
    return;
  }
  list.replaceChildren(
    ...rows.map(([name, m], i) => {
      const li = document.createElement('li');
      li.className = 'top-row';
      li.style.setProperty('--w', `${Math.max(4, (m / max) * 100)}%`);
      li.style.setProperty('--delay', `${i * 40}ms`);
      const n = document.createElement('span');
      n.className = 'top-name';
      n.textContent = name;
      const v = document.createElement('span');
      v.className = 'top-val';
      v.textContent = fmtMinutes(m);
      const bar = document.createElement('span');
      bar.className = 'top-bar';
      bar.setAttribute('aria-hidden', 'true');
      li.append(n, v, bar);
      return li;
    }),
  );
}

// Minutes per #tag over the last 7 days (a session counts for each of its tags).
function renderTagBars(since) {
  const by = new Map();
  for (const h of history) {
    if (h.t < since || !h.task) continue;
    for (const t of splitTags(h.task).tags) by.set(t, (by.get(t) || 0) + h.m);
  }
  const rows = [...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  $('#tags-section').hidden = rows.length === 0;
  if (!rows.length) return;
  const max = rows[0][1];
  $('#tag-bars').replaceChildren(
    ...rows.map(([tag, m], i) => {
      const li = document.createElement('li');
      li.className = 'top-row';
      li.style.setProperty('--w', `${Math.max(4, (m / max) * 100)}%`);
      li.style.setProperty('--delay', `${i * 40}ms`);
      li.style.setProperty('--tag', tagColor(tag));
      const n = document.createElement('span');
      n.className = 'top-name';
      n.append(tagPill(tag));
      const v = document.createElement('span');
      v.className = 'top-val';
      v.textContent = fmtMinutes(m);
      const bar = document.createElement('span');
      bar.className = 'top-bar is-tag';
      bar.setAttribute('aria-hidden', 'true');
      li.append(n, v, bar);
      return li;
    }),
  );
}

// Tap a day in the heatmap to see its sessions.
let selectedDay = null;

function renderDayDetail() {
  const box = $('#day-detail');
  $$('#heatmap .heat.is-selected').forEach((c) => c.classList.remove('is-selected'));
  if (!selectedDay) {
    box.hidden = true;
    return;
  }
  const start = new Date(selectedDay);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  const items = history.filter((h) => h.t >= start.getTime() && h.t < end.getTime()).sort((a, b) => a.t - b.t);
  if (!items.length) {
    selectedDay = null;
    box.hidden = true;
    return;
  }
  $(`#heatmap .heat[data-day="${start.getTime()}"]`)?.classList.add('is-selected');
  const m = items.reduce((n, h) => n + h.m, 0);
  const s = items.filter((h) => h.s).length;
  $('#day-title').textContent = `${start.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })} · ${fmtMinutes(m)} · ${s} ${s === 1 ? 'session' : 'sessions'}`;
  $('#day-log').replaceChildren(...items.map((h) => logItem(h, new Date(h.t - h.m * 60000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))));
  box.hidden = false;
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
    if (d > today) {
      const cell = document.createElement('span');
      cell.className = 'heat is-future';
      cells.push(cell);
      continue;
    }
    const m = (byDay.get(dayKey(d)) || { m: 0 }).m;
    if (m > 0) activeDays += 1;
    const cell = document.createElement(m > 0 ? 'button' : 'span');
    cell.className = `heat l${heatLevel(m)}${d.getTime() === today.getTime() ? ' is-today' : ''}`;
    cell.style.setProperty('--delay', `${Math.floor(i / 7) * 25}ms`);
    const label = `${d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}: ${fmtMinutes(m)}`;
    cell.title = label;
    if (m > 0) {
      cell.type = 'button';
      cell.dataset.day = String(d.getTime());
      cell.setAttribute('aria-label', `${label}. Show sessions`);
    } else {
      cell.setAttribute('role', 'img');
      cell.setAttribute('aria-label', label);
    }
    cells.push(cell);
  }
  grid.replaceChildren(...cells);
  renderDayDetail();
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
  rehomeToasts();
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
  for (const k of ['autoBreaks', 'autoFocus', 'breathing', 'chime', 'sfx', 'notify', 'wakeLock', 'scenery', 'soundsWithTimer', 'flow', 'bells', 'daySky', 'playOnSilent']) f.elements[k].checked = settings[k];
  $('#flow-ratio-row').hidden = !settings.flow;
  f.elements.goalType.value = settings.goalType;
  syncGoalInputs();
  f.elements.theme.value = settings.theme;
  f.elements.palette.value = settings.palette;
  f.elements.chimeStyle.value = settings.chimeStyle;
  f.elements.chimeVolume.style.setProperty('--fill', `${settings.chimeVolume}%`);
  markPreset();
}

function syncGoalInputs() {
  const f = el.settingsForm;
  f.elements.goal.hidden = settings.goalType !== 'sessions';
  f.elements.goalMinutes.hidden = settings.goalType !== 'minutes';
}

function markPreset() {
  const current = `${settings.focus},${settings.short},${settings.long}`;
  $$('.preset[data-preset]').forEach((b) => b.setAttribute('aria-pressed', String(!settings.flow && b.dataset.preset === current)));
}

$$('.preset[data-preset]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const [focus, short, long] = btn.dataset.preset.split(',').map(Number);
    Object.assign(settings, { focus, short, long, flow: false });
    const f = el.settingsForm;
    f.elements.flow.checked = false;
    $('#flow-ratio-row').hidden = true;
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
  if (name === 'chimeVolume') {
    settings.chimeVolume = clampInt(input.value, 0, 100, 70);
    input.style.setProperty('--fill', `${settings.chimeVolume}%`);
    audio.setChimeVolume(settings.chimeVolume / 100);
    audio.chime('break', settings.chimeStyle);
  } else if (name in LIMITS) {
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
  } else if (name === 'goalType') {
    settings.goalType = input.value;
    syncGoalInputs();
    renderGoal();
    audio.sfx('tick', input);
    fx.pop(el.goal, 1.12);
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
    if (name === 'playOnSilent') audio.setPlayOnSilent(settings.playOnSilent);
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
    if (name === 'daySky') syncDaypart();
    if (name === 'flow') {
      $('#flow-ratio-row').hidden = !settings.flow;
      markPreset();
      applyMode();
      renderSummary();
    }
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

// Background photo, stored on this device only.
const photoRemove = $('#photo-remove');
photo.load().then((blob) => {
  photo.apply(blob);
  photoRemove.hidden = !blob;
});
$('#photo-file').addEventListener('change', async (e) => {
  const file = e.currentTarget.files && e.currentTarget.files[0];
  e.currentTarget.value = '';
  if (!file) return;
  try {
    const blob = await photo.save(file);
    photo.apply(blob);
    photoRemove.hidden = false;
    audio.sfx('check', $('#photo-pick'));
    toast({ icon: '🖼️', title: 'Background set', body: 'It stays on this device.' });
  } catch {
    fx.nudge($('#photo-pick'));
    toast({ icon: '⚠️', title: "That picture couldn't be used", body: 'Try a JPEG or PNG photo.' });
  }
});
photoRemove.addEventListener('click', async () => {
  await photo.remove();
  photo.apply(null);
  photoRemove.hidden = true;
  audio.sfx('remove', photoRemove);
});

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

// Every session as a spreadsheet.
$('#btn-export-csv').addEventListener('click', (e) => {
  const q = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const pad2 = (n) => String(n).padStart(2, '0');
  const ymd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const hm = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const rows = [['date', 'start', 'end', 'minutes', 'completed', 'task', 'tags', 'feeling', 'distractions', 'flowtime', 'note']];
  for (const h of [...history].sort((a, b) => a.t - b.t)) {
    const end = new Date(h.t);
    const start = new Date(h.t - h.m * 60000);
    const { label, tags } = h.task ? splitTags(h.task) : { label: '', tags: [] };
    rows.push([ymd(start), hm(start), hm(end), h.m, h.s ? 'yes' : 'no', label, tags.join(' '), h.r ? RATING_NAMES[h.r - 1] : '', h.d || 0, h.f ? 'yes' : 'no', h.n || '']);
  }
  const csv = `${rows.map((r) => r.map(q).join(',')).join('\r\n')}\r\n`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['\ufeff', csv], { type: 'text/csv' }));
  a.download = `tempo-sessions-${ymd(new Date())}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  audio.sfx('pop', e.currentTarget);
  toast({ icon: '📄', title: 'Sessions exported', body: `${rows.length - 1} sessions in ${a.download}` });
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

// Scroll the mixes strip with arrows, or with a normal mouse wheel.
function syncMixArrows() {
  const m = el.mixes;
  const over = m.scrollWidth > m.clientWidth + 4;
  $('#mixes-left').hidden = !over || m.scrollLeft < 8;
  $('#mixes-right').hidden = !over || m.scrollLeft + m.clientWidth > m.scrollWidth - 8;
}
$('#mixes-left').addEventListener('click', () => el.mixes.scrollBy({ left: -el.mixes.clientWidth * 0.7, behavior: 'smooth' }));
$('#mixes-right').addEventListener('click', () => el.mixes.scrollBy({ left: el.mixes.clientWidth * 0.7, behavior: 'smooth' }));
el.mixes.addEventListener('scroll', syncMixArrows, { passive: true });
window.addEventListener('resize', syncMixArrows);
el.mixes.addEventListener(
  'wheel',
  (e) => {
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX) || el.mixes.scrollWidth <= el.mixes.clientWidth) return;
    e.preventDefault();
    el.mixes.scrollLeft += e.deltaY;
  },
  { passive: false },
);

const SOUND_INFO = {
  rain: { icon: '🌧️', name: 'Rain' },
  storm: { icon: '⛈️', name: 'Thunderstorm' },
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
  chimes: { icon: '🎐', name: 'Wind chimes' },
  cat: { icon: '🐈', name: 'Cat purring' },
  study: { icon: '📚', name: 'Study hall' },
  train: { icon: '🚆', name: 'Train ride' },
  birds: { icon: '🐦', name: 'Birdsong' },
  cafe: { icon: '☕', name: 'Café' },
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
      // In a party the host sets each sound; a guest's own volume is the main slider.
      slider.disabled = isGuest();
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
  { id: 'cafe', icon: '☕', name: 'Rainy café', mix: { lofi: { vol: 0.6, x: 0, z: -2 }, rain: { vol: 0.55, x: -2, z: 1.8 }, cafe: { vol: 0.45, x: 1.4, z: 1.2 } } },
  { id: 'deep', icon: '🧠', name: 'Deep focus', mix: { brown: { vol: 0.6, x: 0, z: 2.4 }, binaural: { vol: 0.4, x: 0, z: 0 } } },
  { id: 'stars', icon: '🌌', name: 'Starry beats', mix: { lofi: { vol: 0.6, x: 0, z: -2 }, night: { vol: 0.55, x: -2.2, z: 2 } } },
  { id: 'forest', icon: '🌲', name: 'Forest stream', mix: { stream: { vol: 0.8, x: -1.4, z: -2.6 }, wind: { vol: 0.45, x: 2.4, z: 2.2 }, night: { vol: 0.3, x: -2.4, z: 1.8 } } },
  { id: 'autumn', icon: '🍂', name: 'Autumn walk', mix: { wind: { vol: 0.7, x: 0, z: -2.4, orbit: true }, stream: { vol: 0.5, x: 2.2, z: -2 } } },
  { id: 'catnap', icon: '🐈', name: 'Cat nap', mix: { cat: { vol: 0.75, x: 0.8, z: -1.4 }, rain: { vol: 0.5, x: -2.2, z: -1.6 }, fire: { vol: 0.55, x: 2, z: -1.4 } } },
  { id: 'porch', icon: '🎐', name: 'Breezy porch', mix: { chimes: { vol: 0.7, x: -2.8, z: -2.6 }, wind: { vol: 0.45, x: 2.4, z: 2.2 }, night: { vol: 0.35, x: 0, z: 2.4 } } },
  { id: 'storm', icon: '⛈️', name: 'Stormy study', mix: { storm: { vol: 0.8, x: 0.2, z: -0.9 }, wind: { vol: 0.45, x: -2.4, z: 1.6 }, lofi: { vol: 0.45, x: 0, z: -2 } } },
  { id: 'library', icon: '📚', name: 'Library', mix: { study: { vol: 0.8, x: -1.2, z: -1 }, rain: { vol: 0.35, x: 2.6, z: -1.8 }, clock: { vol: 0.3, x: -3.2, z: 0.4 } } },
  { id: 'nighttrain', icon: '🚆', name: 'Night train', mix: { train: { vol: 0.85, x: 0, z: 1.5 }, rain: { vol: 0.45, x: -2.4, z: -0.4 } } },
  { id: 'morning', icon: '🌅', name: 'Morning walk', mix: { birds: { vol: 0.8, x: 1.6, z: -3 }, stream: { vol: 0.45, x: -1.4, z: -3.2 }, wind: { vol: 0.3, x: 2.4, z: 2.2 } } },
  { id: 'coffee', icon: '🥐', name: 'Coffee shop', mix: { cafe: { vol: 0.8, x: 1.4, z: 1.2 }, lofi: { vol: 0.35, x: 0, z: -2 } } },
];
sound.presets = (Array.isArray(sound.presets) ? sound.presets : [])
  .filter((p) => p && typeof p.name === 'string' && p.mix && typeof p.mix === 'object')
  .slice(0, 12);

const allMixes = () => [...BUILT_IN_MIXES, ...sound.presets.map((p) => ({ ...p, icon: '⭐', custom: true }))];

function mixMatches(m) {
  const want = Object.keys(m.mix).sort().join();
  return want === activeKinds().sort().join();
}

// A random mix that goes together: one bed of sound and one or two details
// that belong with it (no birds in the café, no fan by the stream).
const PAIRINGS = {
  rain: ['chimes', 'clock', 'cat', 'lofi', 'fire', 'night'],
  storm: ['fire', 'clock', 'lofi', 'cat'],
  waves: ['birds', 'chimes', 'night', 'fire'],
  stream: ['birds', 'chimes', 'wind', 'fire'],
  wind: ['chimes', 'birds', 'fire', 'stream'],
  fire: ['rain', 'night', 'cat', 'clock', 'lofi'],
  cafe: ['rain', 'clock'],
  train: ['rain', 'lofi', 'night'],
  study: ['rain', 'clock', 'fire', 'lofi'],
  brown: ['lofi', 'rain', 'clock'],
  fan: ['lofi', 'clock', 'rain', 'cat'],
};
function surpriseMix() {
  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  const bed = pick(Object.keys(PAIRINGS));
  const kinds = [bed];
  const want = Math.random() < 0.5 ? 1 : 2;
  for (let guard = 0; kinds.length < want + 1 && guard < 20; guard++) {
    const k = pick(PAIRINGS[bed]);
    if (!kinds.includes(k)) kinds.push(k);
  }
  const mix = {};
  kinds.forEach((k, i) => {
    const a = Math.random() * Math.PI * 2;
    const r = i === 0 ? 0.8 + Math.random() * 1.2 : 1.6 + Math.random() * 1.8;
    mix[k] = { vol: i === 0 ? 0.75 : 0.4 + Math.random() * 0.3, x: Math.round(Math.sin(a) * r * 10) / 10, z: Math.round(-Math.cos(a) * r * 10) / 10, orbit: i > 0 && Math.random() < 0.2 };
  });
  return { id: 'surprise', icon: '🎲', name: 'Surprise mix', mix };
}

function renderMixes() {
  requestAnimationFrame(syncMixArrows);
  const surprise = document.createElement('button');
  surprise.type = 'button';
  surprise.className = 'mix-card mix-surprise pressable';
  surprise.dataset.mix = 'surprise';
  surprise.title = 'A random mix that goes together';
  surprise.innerHTML = '<span class="mix-icon" aria-hidden="true">🎲</span><span>Surprise me</span>';
  el.mixes.replaceChildren(
    surprise,
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
  if (card.dataset.mix === 'surprise') {
    const m = surpriseMix();
    applyMix(m, card);
    const icon = card.querySelector('.mix-icon');
    icon.classList.remove('roll');
    void icon.getBoundingClientRect();
    icon.classList.add('roll');
    toast({ icon: '🎲', title: 'Surprise mix', body: Object.keys(m.mix).map((k) => SOUND_INFO[k].name).join(' + '), duration: 3000 });
    return;
  }
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

// ----- Share a mix as a link: #mix=rain.70.-22.-16~fire.85.18.-14.o --------

function mixToHash(mix, name) {
  const parts = Object.entries(mix).map(([k, m]) => [k, Math.round(m.vol * 100), Math.round(m.x * 10), Math.round(m.z * 10), ...(m.orbit ? ['o'] : [])].join('.'));
  return `mix=${parts.join('~')}${name ? `&n=${encodeURIComponent(name.slice(0, 24))}` : ''}`;
}

function mixFromHash(hash) {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const raw = params.get('mix');
  if (!raw) return null;
  const mix = {};
  for (const part of raw.split('~').slice(0, 20)) {
    const [k, vol, x, z, o] = part.split('.');
    if (!audio.ambientKinds.includes(k)) continue;
    const [dx, dz] = audio.defaultAnchor(k);
    mix[k] = { vol: clampNum(Number(vol) / 100, 0, 1, 0.8), x: clampNum(Number(x) / 10, -4, 4, dx), z: clampNum(Number(z) / 10, -4, 4, dz), orbit: o === 'o' };
  }
  if (!Object.keys(mix).length) return null;
  const name = (params.get('n') || '').trim().slice(0, 24);
  return { id: 'shared', icon: '🔗', name: name || 'Shared mix', mix };
}

$('#btn-share-mix').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const kinds = activeKinds();
  if (!kinds.length) {
    fx.nudge(btn);
    return;
  }
  const current = allMixes().find((m) => mixMatches(m));
  const mix = Object.fromEntries(kinds.map((k) => [k, sound.mix[k]]));
  const url = `${window.location.origin}${window.location.pathname}#${mixToHash(mix, current ? current.name : '')}`;
  const names = kinds.map((k) => SOUND_INFO[k].name).join(' + ');
  fx.pop(btn, 1.08);
  if (navigator.share && phoneLayout.matches) {
    try {
      await navigator.share({ title: 'A Tempo sound mix', text: `Focus with this mix: ${names}`, url });
      unlock('sharer', { delay: 800 });
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return;
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    audio.sfx('check', btn);
    unlock('sharer', { delay: 1600 });
    toast({ icon: '🔗', title: 'Link copied', body: `Anyone who opens it hears ${names}, placed just like yours.`, duration: 4000 });
  } catch {
    window.prompt('Copy this link to share your mix:', url);
  }
});

// ----- Focus together: #join=<end time>.<length> — whoever opens the link
// joins a session that ends at the same moment as yours.

async function inviteToFocus(btn) {
  if (!(timer.running && timer.mode === 'focus' && !timer.flow)) return;
  const url = `${window.location.origin}${window.location.pathname}#join=${Math.round(timer.endAt)}.${Math.round(totalMs())}`;
  const at = new Date(timer.endAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  fx.pop(btn, 1.1);
  if (navigator.share && phoneLayout.matches) {
    try {
      await navigator.share({ title: 'Focus with me', text: `I'm focusing until ${at}. Join me on Tempo:`, url });
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return;
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    audio.sfx('check', btn);
    toast({ icon: '👥', title: 'Invite link copied', body: `Whoever opens it joins you; your timers both end at ${at}.`, duration: 4500 });
  } catch {
    window.prompt('Copy this link to invite someone:', url);
  }
}
el.invite.addEventListener('click', (e) => inviteToFocus(e.currentTarget));

function offerJoin() {
  const raw = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('join');
  if (!raw) return;
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
  const [endAt, total] = raw.split('.').map(Number);
  const left = endAt - Date.now();
  if (!Number.isFinite(endAt) || !Number.isFinite(total) || total < 60000 || total > 180 * 60000 || left > total + 60000) return;
  if (left < 30000) {
    toast({ icon: '👥', title: 'That focus session has ended', body: 'Ask for a new link, or start your own.', duration: 5000 });
    return;
  }
  const at = new Date(endAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  toast({
    icon: '👥',
    title: 'Join a focus session?',
    body: `Someone is focusing until ${at} (${fmtMinutes(Math.round(left / 60000))} left). Your timers will end together.`,
    duration: 20000,
    action: { label: 'Join', onClick: () => {
      const now = Date.now();
      if (endAt - now < 5000) return;
      if (timer.running && elapsedMs() > 5000 && !window.confirm('The timer is running. Join this session instead?')) return;
      audio.unlock();
      switchTo('focus');
      timer.total = endAt - now; // what you'll actually focus, for your stats
      timer.endAt = endAt;
      timer.running = true;
      timer.paused = null;
      timer.flow = false;
      afterTimerChange();
      if (phoneLayout.matches) setView('timer');
      audio.sfx('start', el.toggle);
      fx.burst(el.toggle, { count: 14, spread: 80, size: 6 });
      toast({ icon: '👥', title: 'Joined', body: `Focusing together until ${at}.`, duration: 3000 });
    } },
  });
}
window.addEventListener('hashchange', offerJoin);

function offerSharedMix() {
  const m = mixFromHash(window.location.hash);
  if (!m) return;
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
  const names = Object.keys(m.mix).map((k) => SOUND_INFO[k].name).join(' + ');
  toast({
    icon: '🎧',
    title: m.name === 'Shared mix' ? 'Someone shared a sound mix' : `Someone shared “${m.name}”`,
    body: names,
    duration: 15000,
    actions: [
      { label: 'Save', kind: 'ghost', onClick: () => {
        sound.presets.push({ id: newId(), name: m.name, mix: m.mix });
        if (sound.presets.length > 12) sound.presets.shift();
        save();
        renderMixes();
        toast({ icon: '⭐', title: `Saved “${m.name}”`, body: 'Find it with the mixes.', duration: 2500 });
      } },
      { label: 'Play it', onClick: () => {
        setView('sounds');
        applyMix(m, el.mixes);
      } },
    ],
  });
}
window.addEventListener('hashchange', offerSharedMix);

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

// A party guest hears the sounds where the host put them.
function guestRoomNote(e) {
  if (!isGuest() || !e.target.closest('.orb')) return false;
  e.preventDefault();
  guestNote('🎧', `${P.hostName} places the sounds`, 'Use the volume slider to make them quieter for you.');
  return true;
}

el.room.addEventListener('pointerdown', (e) => {
  const orb = e.target.closest('.orb');
  if (!orb || e.button > 0 || guestRoomNote(e)) return;
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
  if (!orb || isGuest()) return;
  const [dx, dz] = audio.defaultAnchor(orb.dataset.kind);
  moveSound(orb.dataset.kind, dx, dz);
  fx.pop(orb, 1.25);
  audio.sfx('pop', orb);
  save();
});

el.room.addEventListener('keydown', (e) => {
  const orb = e.target.closest('.orb');
  const step = { ArrowLeft: [-0.3, 0], ArrowRight: [0.3, 0], ArrowUp: [0, -0.3], ArrowDown: [0, 0.3] }[e.key];
  if (!orb || !step || guestRoomNote(e)) return;
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
// Phones, including phones held sideways (short touch screens).
const phoneLayout = window.matchMedia('(max-width: 760px), (max-height: 500px) and (pointer: coarse)');

// On a computer the side panel remembers what it last showed (just on this device).
const DOCK_KEY = 'tempo:dock';
function savedDock() {
  try {
    const v = localStorage.getItem(DOCK_KEY);
    return VIEWS.includes(v) ? v : 'tasks';
  } catch {
    return 'tasks';
  }
}

function setView(view, { scroll = true } = {}) {
  if (!VIEWS.includes(view)) view = 'timer';
  const changed = el.body.dataset.view !== view;
  el.body.dataset.view = view;
  if (!phoneLayout.matches) {
    try {
      localStorage.setItem(DOCK_KEY, view);
    } catch {
      /* private mode: it just won't be remembered */
    }
  }
  navBtns.forEach((b) => {
    if (b.dataset.view === view) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  $('#bottom-nav').style.setProperty('--i', String(VIEWS.indexOf(view)));
  if (view === 'sounds') requestAnimationFrame(syncMixArrows);
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
el.flowBreak.addEventListener('click', () => {
  audio.sfx('pop', el.flowBreak);
  fx.pop(el.flowBreak, 1.1);
  finishFlow();
});
el.lengthBtn.addEventListener('click', () => (el.lengthPop.hidden ? openLengthPop() : closeLengthPop()));
el.lengthPop.addEventListener('click', (e) => {
  const b = e.target.closest('.length-opt');
  if (!b) return;
  if (b.dataset.min === 'flow') {
    settings.flow = true;
  } else {
    settings[timer.mode] = Number(b.dataset.min);
    if (timer.mode === 'focus') settings.flow = false;
    timer.earned = null;
  }
  save();
  audio.sfx('pop', b);
  closeLengthPop();
  applyMode();
  renderSummary();
  if (typeof markPreset === 'function') markPreset();
  fx.pop(el.time, 1.06);
  el.lengthBtn.focus();
});
el.lengthPop.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.stopPropagation();
    closeLengthPop();
    el.lengthBtn.focus();
  }
});
document.addEventListener('pointerdown', (e) => {
  if (!el.lengthPop.hidden && !e.target.closest('#length-pop, #btn-length')) closeLengthPop();
});
el.distract.addEventListener('click', () => noteDistraction(el.distract));
$('#heatmap').addEventListener('click', (e) => {
  const cell = e.target.closest('.heat[data-day]');
  if (!cell) return;
  const day = Number(cell.dataset.day);
  selectedDay = selectedDay === day ? null : day;
  audio.sfx(selectedDay ? 'open' : 'close', cell);
  fx.pop(cell, 1.3);
  renderDayDetail();
  if (selectedDay) $('#day-detail').scrollIntoView({ block: 'nearest', behavior: fx.motionOK() ? 'smooth' : 'auto' });
});
$('#btn-day-close').addEventListener('click', () => {
  const cell = $('#heatmap .heat.is-selected');
  selectedDay = null;
  audio.sfx('close', $('#btn-day-close'));
  renderDayDetail();
  cell?.focus();
});
el.pip.hidden = !pip.supported();
el.pip.addEventListener('click', togglePip);

el.skip.addEventListener('click', () => {
  const undoable = !timer.flow || isFresh();
  const before = { timer: JSON.parse(JSON.stringify(timer)), historyLen: history.length, from: timer.mode };
  skip();
  if (undoable) {
    toast({
      icon: '⏭️',
      title: `Skipped to ${MODES[timer.mode].label.toLowerCase()}`,
      duration: 5000,
      action: { label: 'Undo', onClick: () => {
        Object.keys(timer).forEach((k) => delete timer[k]);
        Object.assign(timer, cleanTimer(before.timer));
        history = history.slice(0, before.historyLen);
        applyMode();
        afterTimerChange();
        renderGoal();
        renderTasks();
        audio.sfx('uncheck', el.skip);
        fx.pop(el.dial, 1.03);
        announce(`Back to ${MODES[timer.mode].label.toLowerCase()}`);
      } },
    });
  }
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
    if (timer.running && elapsedMs() > 5000 && !window.confirm('The timer is running. Switch anyway?')) return;
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
  if (li && e.target.closest('.task-name')) startEdit(li);
});

el.clearDone.addEventListener('click', () => {
  // Daily tasks stay: they come back tomorrow.
  removeTasks(tasks.filter((t) => t.done && !t.daily).map((t) => t.id), el.clearDone);
});

el.goal.addEventListener('click', (e) => {
  selectedDay = null;
  renderStats();
  prepareShareCard();
  openSheet(el.statsDialog, e.currentTarget);
});

$('#btn-help').addEventListener('click', (e) => openSheet(el.helpDialog, e.currentTarget));
el.helpDialog.addEventListener('close', markChangesSeen);
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

// What's new: the newest first. Bump `id` when adding an entry.
const CHANGES = [
  { id: 31, icon: '📲', text: 'Comfier on small phones: a bigger timer dial, a tidier top bar and no sideways scrolling, down to the smallest iPhone.' },
  { id: 30, icon: '📱', text: 'Better on phones held sideways: the timer sits beside its controls and the tabs move to the right edge, so nothing is squashed or covered.' },
  { id: 29, icon: '✨', text: 'A fresh new look: the timer takes centre stage, and on a computer Sounds and Tasks live in one side panel you switch with the buttons on the right. Sounds are now picture tiles, and everything is a little calmer and quicker.' },
  { id: 28, icon: '🔐', text: 'Safer parties: turn on “Ask me before letting people in” (it switches on by itself when you remove someone), requests can no longer pile up on the host, and each guest’s messages are sealed with their own key so nobody can pretend to be someone else.' },
  { id: 27, icon: '🧼', text: 'Parties now have a language filter: bad words in names, tasks and messages are starred out (the host can turn it off). And as a guest, Off, the mixer ✕ and M now work: they ask the host, or just turn sounds off if you can add things.' },
  { id: 26, icon: '🛡️', text: 'Party roles: as the host, pick what each guest can do. Watch (just follow along), Ask (send you requests) or Add (add tasks and sounds themselves). Choose what guests can ask about and how long they wait between requests, and remove anyone who spams.' },
  { id: 25, icon: '🔒', text: 'Private parties now connect on any network: everything goes through encrypted relays, so nobody ever sees your IP address. Guests asking for +1 minute now ask for 1 minute (not 5), and sounds are smoother on Android phones.' },
  { id: 24, icon: '🔊', text: 'Button sounds now work on phones, and on iPhone they play even with the silent switch on (you can turn that off in Settings > Sound).' },
  { id: 23, icon: '🎉', text: 'Focus parties: tap Party to host, share the code, and everyone shares your timer, sounds and tasks live. Guests can ask for changes; you decide. Private by default: nobody sees anyone\'s IP address.' },
  { id: 22, icon: '👥', text: 'Focus together: while a session runs, tap Invite and send the link. Whoever opens it joins you, and your timers end at the same moment.' },
  { id: 21, icon: '🕒', text: 'In the search (Ctrl K), type a number like 40 to focus that long, or "until 3:30pm" to focus until then.' },
  { id: 20, icon: '🎲', text: 'Tap Surprise me in the mixes for a random mix that goes together. A session left paused for ten minutes now gets a gentle reminder.' },
  { id: 19, icon: '⛈️', text: 'New sound: Thunderstorm. Each lightning flash lights the side of the screen its thunder then rolls in from.' },
  { id: 18, icon: '🔁', text: 'Tasks can repeat every day: edit a task and tap 🔁, and it comes back unticked each morning.' },
  { id: 17, icon: '🌅', text: 'The background now follows the time of day, Stats shows your personal bests, and the shared image includes today\'s intention.' },
  { id: 16, icon: '🔔', text: 'Optional soft bells halfway through a session and with a minute to go (Settings > Sound). Media keys and your lock screen can now start, pause and skip.' },
  { id: 15, icon: '🎯', text: 'Set your daily goal in minutes instead of sessions (great with Flowtime), and export your sessions as a spreadsheet.' },
  { id: 14, icon: '🏆', text: 'Seven new achievements, a "This week" review in Stats, and Undo when you skip a session by accident.' },
  { id: 13, icon: '🔗', text: 'Share your sound mix as a link, get an idea for each break, and tick off today\'s intention when it\'s done.' },
  { id: 12, icon: '🔎', text: 'Press Ctrl K (⌘K on a Mac) or / to search and run anything: start, sounds, mixes, tasks, themes and more.' },
  { id: 11, icon: '🌱', text: 'Write today\'s intention under the timer, and jot down what you got done after each session (📝). Notes show in Stats.' },
  { id: 10, icon: '🐦', text: 'New sounds: Birdsong (a morning forest all around you) and Café (chatter, clinking cups and the espresso machine), with new mixes Morning walk and Coffee shop.' },
  { id: 9, icon: '🏷️', text: 'Add #tags to task names (like "Essay #school") to see focus by tag in Stats. Tap a day in the heatmap to see its sessions.' },
  { id: 8, icon: '🚆', text: 'Two new 3D sounds: a Study hall full of quiet typing and page turns, and a Train ride with hills rolling past. Ambient sound now dips while the chime plays.' },
  { id: 7, icon: '🌊', text: 'Flowtime: tap the length under the timer and pick ∞ to count up, then take a break you\'ve earned when you\'re ready.' },
  { id: 6, icon: '🖼️', text: 'Set your own background photo in Settings > Appearance.' },
  { id: 5, icon: '🐈', text: 'New sounds: Wind, Stream, Wind chimes and a purring cat, plus new mixes like Cat nap and Forest stream.' },
  { id: 4, icon: '⏱️', text: 'Tap the length under the timer to change it quickly. Stats now show today\'s timeline and where your focus went.' },
  { id: 3, icon: '⚡', text: 'Tap Distracted (D) when your mind wanders, and rate each session when it ends.' },
  { id: 2, icon: '📤', text: 'Share an image of your day from Stats, and pick a chime sound in Settings.' },
  { id: 1, icon: '🎛️', text: 'Mix sounds, place them around you in the 3D room, or pick a ready-made mix.' },
];
const LATEST_CHANGE = CHANGES[0].id;

function renderWhatsNew() {
  const seen = Number(settings.seenChanges) || 0;
  $('#whats-new').replaceChildren(
    ...CHANGES.slice(0, 4).map((c) => {
      const li = document.createElement('li');
      if (c.id > seen) li.className = 'is-new';
      const i = document.createElement('span');
      i.setAttribute('aria-hidden', 'true');
      i.textContent = c.icon;
      const t = document.createElement('span');
      t.textContent = c.text;
      li.append(i, t);
      return li;
    }),
  );
  $('#btn-help').classList.toggle('has-news', seen < LATEST_CHANGE);
}

function markChangesSeen() {
  if ((Number(settings.seenChanges) || 0) >= LATEST_CHANGE) return;
  settings.seenChanges = LATEST_CHANGE;
  save();
  setTimeout(renderWhatsNew, 1500); // let the "new" highlights show first
}

// First visit: a short welcome.
// Someone arriving through a shared link (a mix or an invite) sees that
// offer first; the welcome waits for their next visit.
const arrivedWithLink = /(?:^#|&)(mix|join|party)=/.test(window.location.hash);

function maybeWelcome() {
  if (arrivedWithLink) return;
  if (settings.welcomed) {
    // Returning visitors hear about new things once.
    const seen = Number(settings.seenChanges) || 0;
    if (seen < LATEST_CHANGE) {
      const fresh = CHANGES.filter((c) => c.id > seen);
      setTimeout(() => {
        toast({
          icon: '✨',
          title: fresh.length === 1 ? "There's something new" : `${fresh.length} new things to try`,
          body: fresh[0].text,
          duration: 9000,
          action: { label: "What's new", onClick: () => openSheet(el.helpDialog, $('#btn-help')) },
        });
      }, 1200);
    }
    return;
  }
  settings.welcomed = true;
  settings.seenChanges = LATEST_CHANGE;
  renderWhatsNew();
  save();
  setTimeout(() => openSheet($('#welcome-dialog'), el.toggle), 700);
}
$('#welcome-tips').addEventListener('click', (e) => {
  closeSheet($('#welcome-dialog'));
  setTimeout(() => openSheet(el.helpDialog, e.target), 220);
});

function shareData() {
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
  return {
    today: fmtMinutes(t.m),
    sessions: t.s,
    streak: streakDays(),
    week,
    intention: intention.text ? `🌱 ${intention.text}${intention.done ? ' ✓' : ''}` : '',
    date: today.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }),
    colors: { accent: v('accent'), accent2: v('accent-2'), bg: v('bg'), ink: v('ink'), ink2: v('ink-2'), track: v('track'), card: v('surface') },
  };
}

// The image is made when Stats opens, so sharing can start right from the tap.
let readyCard = null;
function prepareShareCard() {
  readyCard = null;
  makeCardFile(shareData()).then((f) => { readyCard = f; }).catch(() => {});
}

$('#btn-share').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  audio.sfx('pop', btn);
  const result = await shareCard(shareData(), readyCard).catch(() => 'failed');
  if (result === 'downloaded') toast({ icon: '🖼️', title: 'Image saved', body: 'Your focus card is in your downloads.' });
  else if (result === 'failed') toast({ icon: '⚠️', title: "Couldn't make the image" });
});

$('#btn-stats').addEventListener('click', (e) => {
  selectedDay = null;
  renderStats();
  prepareShareCard();
  openSheet(el.statsDialog, e.currentTarget);
});

$('#btn-settings').addEventListener('click', (e) => {
  fillSettings();
  openSheet(el.settingsDialog, e.currentTarget);
});

// Every button: ripple + haptic on press, generic click sound where tagged.
// Phones only let sound start on a finished tap (touchend/click), not when a
// finger first lands, so unlock audio on those; a mouse press counts too.
['touchend', 'click'].forEach((type) => document.addEventListener(type, () => {
  audio.unlock();
  startAmbientIfPending();
}, { capture: true, passive: true }));

document.addEventListener(
  'pointerdown',
  (e) => {
    if (e.pointerType === 'mouse') {
      audio.unlock();
      startAmbientIfPending();
    }
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
  } else if (key === '/') {
    e.preventDefault();
    openPalette();
  } else if (key === 'i') {
    e.preventDefault();
    if (isZen()) setZen(false);
    if (phoneLayout.matches) setView('timer');
    setTimeout(() => $('#intention-input').focus(), isZen() ? 500 : 0);
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
  if (P) return; // in a party, this tab follows the party instead
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
  intention = cleanIntention(d.intention);
  renderIntention();
  // Saved mixes are shared; what's playing stays per tab.
  const sp = obj(d.sound).presets;
  if (Array.isArray(sp)) {
    sound.presets = sp.filter((p) => p && typeof p.name === 'string' && p.mix && typeof p.mix === 'object').slice(0, 12);
    renderMixes();
  }
  audio.setSfxEnabled(settings.sfx);
  audio.setChimeVolume(settings.chimeVolume / 100);
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
audio.setPlayOnSilent(settings.playOnSilent);
$('#silent-row').hidden = !(/iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));
scenery.mount();
audio.setChimeVolume(settings.chimeVolume / 100);
scenery.setEnabled(settings.scenery);
applyTheme();
applyMode();
rollOverDailyTasks();
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
setView(phoneLayout.matches ? 'timer' : savedDock(), { scroll: false });

// ---------------------------------------------------------------------------
// Command palette: search everything you can do and run it from the keyboard.

const palette = $('#palette');
const palInput = $('#palette-input');
const palList = $('#palette-list');
let palItems = [];
let palActive = 0;
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
$('#palette-kbd').textContent = isMac ? '⌘K' : 'Ctrl K';
$('#btn-palette').title = `Search commands (${isMac ? '⌘K' : 'Ctrl K'})`;

// Start a one-off focus of a given length, leaving the usual length alone.
function startCustomFocus(ms, label) {
  if (timer.running && elapsedMs() > 5000 && !window.confirm('The timer is running. Start a new focus anyway?')) return;
  if (!isFresh() || timer.mode !== 'focus') switchTo('focus');
  timer.total = ms;
  timer.flow = false;
  audio.unlock();
  start();
  audio.sfx('start', el.toggle);
  fx.burst(el.toggle, { count: 12, spread: 70, size: 6 });
  toast({ icon: '⏱️', title: label, duration: 2500 });
}

// Typed numbers and times become commands: "40" or "until 3:30pm".
function typedCommands(q) {
  const out = [];
  const mins = /^(\d{1,3})\s*(m|min|mins|minutes?)?$/.exec(q);
  if (mins) {
    const m = Number(mins[1]);
    if (m >= 1 && m <= 180) {
      out.push({ cat: 'Timer', icon: '▶️', title: `Start a ${m}-minute focus now`, run: () => startCustomFocus(m * 60000, `Focusing for ${m} minutes`) });
      out.push({ cat: 'Timer', icon: '⏱️', title: `Make focus sessions ${m} minutes`, run: () => {
        settings.focus = m;
        settings.flow = false;
        save();
        if (timer.mode === 'focus' && isFresh()) applyMode();
        renderSummary();
        markPreset();
        toast({ icon: '⏱️', title: `Focus sessions are now ${m} minutes`, duration: 2200 });
      } });
    }
  }
  const until = /^(?:until|till|til|to)?\s*(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a|p)?$/.exec(q);
  if (until && (/^(until|till|til|to)/.test(q) || until[2] || until[3])) {
    let h = Number(until[1]);
    const mi = Number(until[2] || 0);
    const ap = until[3];
    if (h <= 23 && mi <= 59 && !(ap && (h < 1 || h > 12))) {
      if (ap && ap[0] === 'p' && h < 12) h += 12;
      if (ap && ap[0] === 'a' && h === 12) h = 0;
      const now = new Date();
      const end = new Date(now);
      end.setHours(h, mi, 0, 0);
      // "until 3" means the next 3 o'clock: today, or this afternoon, or tomorrow.
      if (!ap && end <= now && h < 12) end.setHours(h + 12);
      if (end <= now) end.setDate(end.getDate() + 1);
      const ms = end - now;
      const m = Math.round(ms / 60000);
      if (m >= 1 && m <= 180) {
        const at = end.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        out.push({ cat: 'Timer', icon: '🕒', title: `Focus until ${at} (${fmtMinutes(m)})`, run: () => startCustomFocus(end - Date.now(), `Focusing until ${at}`) });
      }
    }
  }
  return out;
}

function paletteCommands(query) {
  const cmds = [];
  const add = (c) => cmds.push(c);
  const label = MODES[timer.mode].label.toLowerCase();
  // Timer
  add({ cat: 'Timer', top: true, icon: timer.running ? '⏸️' : '▶️', title: timer.running ? 'Pause' : isFresh() ? `Start ${isFlow() ? 'Flowtime' : label}` : 'Resume', keys: 'Space', run: () => toggleTimer(el.toggle) });
  if (!isFresh()) add({ cat: 'Timer', top: true, icon: '↺', title: 'Reset this session', keys: 'R', run: () => el.reset.click() });
  add({ cat: 'Timer', top: true, icon: '⏭️', title: timer.flow && !isFresh() ? 'Finish and take your break' : 'Skip to the next session', keys: 'S', run: () => el.skip.click() });
  MODE_ORDER.forEach((m, i) => {
    if (m !== timer.mode) add({ cat: 'Timer', icon: { focus: '🎯', short: '☕', long: '🌿' }[m], title: `Switch to ${MODES[m].label.toLowerCase()}`, keys: String(i + 1), run: () => el.tabs[i].click() });
  });
  if (!isFresh() && !timer.flow) add({ cat: 'Timer', icon: '➕', title: 'Add a minute', keys: '+', run: () => addTime(60000, el.extend) });
  add({ cat: 'Timer', icon: '🌊', title: settings.flow ? 'Turn Flowtime off (count down)' : 'Turn Flowtime on (count up)', words: 'flow count up stopwatch', run: () => {
    settings.flow = !settings.flow;
    save();
    applyMode();
    renderSummary();
    markPreset();
    toast({ icon: '🌊', title: settings.flow ? 'Flowtime on' : 'Flowtime off', body: settings.flow ? 'Focus counts up; take a break when you\'re ready.' : `Focus counts down from ${settings.focus} minutes.`, duration: 2500 });
  } });
  for (const m of LENGTHS.focus) add({ cat: 'Timer', icon: '⏱️', title: `Focus for ${m} minutes`, words: 'length duration time', run: () => {
    settings.focus = m;
    settings.flow = false;
    save();
    if (timer.mode === 'focus' && isFresh()) applyMode();
    renderSummary();
    markPreset();
    toast({ icon: '⏱️', title: `Focus sessions are now ${m} minutes`, duration: 2200 });
  } });
  add({ cat: 'Timer', top: true, icon: '🧘', title: isZen() ? 'Leave zen mode' : 'Zen mode', keys: 'F', run: () => setZen(!isZen()) });
  if (pip.supported()) add({ cat: 'Timer', icon: '🪟', title: 'Floating mini timer', keys: 'P', run: togglePip });
  if (timer.mode === 'focus' && !isFresh()) add({ cat: 'Timer', icon: '⚡', title: 'Note a distraction', keys: 'D', run: () => noteDistraction() });
  if (timer.running && timer.mode === 'focus' && !timer.flow) add({ cat: 'Timer', top: true, icon: '👥', title: 'Invite someone to focus with you', words: 'share together friend link', run: () => inviteToFocus(el.invite) });
  // Sound
  const playing = activeKinds();
  for (const k of audio.ambientKinds) {
    const on = playing.includes(k);
    add({ cat: 'Sound', icon: SOUND_INFO[k].icon, title: `${on ? 'Stop' : 'Play'} ${SOUND_INFO[k].name.toLowerCase()}`, words: 'sound ambient noise', run: () => $(`.chip[data-sound="${k}"]`).click() });
  }
  add({ cat: 'Mix', icon: '🎲', title: 'Surprise me with a mix', words: 'random shuffle', run: () => $('.mix-surprise').click() });
  for (const m of allMixes()) add({ cat: 'Mix', icon: m.icon, title: m.name, words: `mix soundscape ${Object.keys(m.mix).map((k) => SOUND_INFO[k]?.name || k).join(' ')}`, run: () => applyMix(m, el.mixes) });
  if (playing.length) add({ cat: 'Sound', top: true, icon: '🔇', title: 'Turn all sounds off', keys: 'M', run: () => $('.chip[data-sound="off"]').click() });
  else add({ cat: 'Sound', top: true, icon: '🔊', title: 'Bring sounds back', keys: 'M', run: toggleMute });
  for (const m of [15, 30, 60, 90]) add({ cat: 'Sound', icon: '🌙', title: `Sleep timer: fade out in ${m} minutes`, words: 'sleep fade', run: () => setSleep(m) });
  // Tasks
  for (const t of tasks.filter((x) => !x.done)) {
    const active = t.id === activeTaskId;
    add({ cat: 'Task', top: !query && active, icon: active ? '⏹️' : '✅', title: `${active ? 'Stop working on' : 'Work on'}: ${splitTags(t.title).label}`, words: t.title, run: () => $(`.task[data-id="${CSS.escape(t.id)}"] .task-select`)?.click() });
  }
  add({ cat: 'Task', top: true, icon: '📝', title: 'New task', keys: 'N', run: () => {
    setView('tasks');
    setTimeout(() => el.taskInput.focus(), 50);
  } });
  if (tasks.some((t) => t.done)) add({ cat: 'Task', icon: '🧹', title: 'Clear finished tasks', run: () => el.clearDone.click() });
  add({ cat: 'Today', top: true, icon: '🌱', title: intention.text ? 'Change today\'s intention' : 'Set today\'s intention', keys: 'I', run: () => {
    setView('timer');
    $('#intention-input').focus();
  } });
  const lastFocus = [...history].reverse().find((h) => h.s);
  if (lastFocus) add({ cat: 'Today', icon: '🗒️', title: lastFocus.n ? 'Edit the note on your last session' : 'Note what you got done last session', run: () => openNote(lastFocus.t, el.toggle) });
  // Go to
  add({ cat: 'Open', top: true, icon: '📊', title: 'Stats', words: 'history heatmap achievements', run: () => $('#btn-stats').click() });
  add({ cat: 'Open', icon: '🏆', title: 'Achievements', run: () => {
    $('#btn-stats').click();
    selectStatTab(2, { animate: false });
  } });
  add({ cat: 'Open', top: true, icon: '⚙️', title: 'Settings', words: 'preferences options', run: () => $('#btn-settings').click() });
  add({ cat: 'Open', icon: '❓', title: 'Tips and keyboard shortcuts', keys: '?', words: 'help what\'s new', run: () => $('#btn-help').click() });
  add({ cat: 'Open', icon: '💾', title: 'Export a backup', words: 'download save data', run: () => $('#btn-export').click() });
  add({ cat: 'Open', icon: '📄', title: 'Export sessions as a spreadsheet', words: 'csv excel download data', run: () => $('#btn-export-csv').click() });
  // Look
  for (const [v, name] of [['light', 'Light theme'], ['dark', 'Dark theme'], ['auto', 'Theme: match my device']]) {
    if (settings.theme !== v) add({ cat: 'Look', icon: v === 'dark' ? '🌙' : v === 'light' ? '☀️' : '🌗', title: name, words: 'appearance mode', run: () => {
      settings.theme = v;
      applyTheme();
      save();
    } });
  }
  for (const p of PALETTES) {
    if (settings.palette !== p) add({ cat: 'Look', icon: '🎨', title: `${p[0].toUpperCase()}${p.slice(1)} colours`, words: 'palette colour color theme accent', run: () => {
      settings.palette = p;
      applyTheme();
      save();
    } });
  }
  return cmds;
}

// Higher is better; -1 when the text doesn't match at all. Whole words beat
// word starts, which beat matches inside a word; `fuzzy` also allows the
// letters to be spread out ("frt" finds "Fireplace") for titles.
function palScore(query, text, fuzzy = true) {
  const t = text.toLowerCase();
  const i = t.indexOf(query);
  if (i >= 0) {
    const start = i === 0 || t[i - 1] === ' ';
    const end = i + query.length === t.length || /[\s:“”,]/.test(t[i + query.length]);
    return 100 - Math.min(i, 40) + (start ? 30 : 0) + (start && end ? 20 : 0);
  }
  if (!fuzzy) return -1;
  let k = 0;
  let gaps = 0;
  for (let j = 0; j < t.length && k < query.length; j++) {
    if (t[j] === query[k]) k += 1;
    else if (k > 0) gaps += 1;
  }
  return k === query.length ? Math.max(1, 20 - gaps) : -1; // always below any real match
}

function renderPalette() {
  const q = palInput.value.trim().toLowerCase();
  let items = paletteCommands(q);
  if (!q) items = items.filter((c) => c.top);
  else {
    items = items
      .map((c) => {
        const s = Math.max(palScore(q, c.title), palScore(q, c.words || '', false) - 15, palScore(q, c.cat, false) - 20);
        return { c, s: s > 20 && c.top ? s + 8 : s }; // the everyday commands first
      })
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s);
    // Spread-out letter matches only show when nothing matches properly.
    const real = items.some((x) => x.s > 20);
    items = items
      .filter((x) => !real || x.s > 20)
      .slice(0, 40)
      .map((x) => x.c);
    items.unshift(...typedCommands(q));
    const raw = palInput.value.trim();
    const add = { cat: 'Task', icon: '➕', title: `Add task “${raw}”`, run: () => {
      addTask(raw.slice(0, 120), 1);
      toast({ icon: '✅', title: 'Task added', body: raw.slice(0, 120), duration: 2200 });
    } };
    if (items.length) items.push(add);
    else items = [add];
  }
  palItems = items;
  palActive = Math.min(palActive, Math.max(0, items.length - 1));
  palList.replaceChildren(
    ...items.map((c, i) => {
      const li = document.createElement('li');
      li.id = `pal-${i}`;
      li.className = 'pal-item';
      li.setAttribute('role', 'option');
      li.dataset.i = String(i);
      const icon = document.createElement('span');
      icon.className = 'pal-icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = c.icon;
      const title = document.createElement('span');
      title.className = 'pal-title';
      title.textContent = c.title;
      const hint = document.createElement('span');
      hint.className = 'pal-hint';
      hint.textContent = c.cat;
      li.append(icon, title, hint);
      if (c.keys) {
        const k = document.createElement('kbd');
        k.textContent = c.keys;
        k.setAttribute('aria-hidden', 'true');
        li.append(k);
      }
      return li;
    }),
  );
  markPalActive(false);
}

function markPalActive(scroll = true) {
  palList.querySelectorAll('.pal-item').forEach((li, i) => li.setAttribute('aria-selected', String(i === palActive)));
  const cur = $(`#pal-${palActive}`);
  if (cur) {
    palInput.setAttribute('aria-activedescendant', cur.id);
    if (scroll) cur.scrollIntoView({ block: 'nearest' });
  } else {
    palInput.removeAttribute('aria-activedescendant');
  }
}

function openPalette() {
  if (palette.open || $('dialog[open]')) return;
  palInput.value = '';
  palActive = 0;
  renderPalette();
  openSheet(palette, $('#btn-palette'));
  palInput.focus();
}

function runPalette(i) {
  const c = palItems[i];
  if (!c) return;
  palette.close();
  audio.sfx('pop', el.toggle);
  c.run();
  counters.paletteRuns += 1;
  save();
  if (counters.paletteRuns >= 10) unlock('power', { delay: 1200 });
}

palInput.addEventListener('input', () => {
  palActive = 0;
  renderPalette();
  audio.sfx('key', palInput);
});
palInput.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!palItems.length) return;
    palActive = (palActive + (e.key === 'ArrowDown' ? 1 : -1) + palItems.length) % palItems.length;
    markPalActive();
    audio.sfx('tick', $(`#pal-${palActive}`));
  } else if (e.key === 'Enter') {
    e.preventDefault();
    runPalette(palActive);
  }
});
palList.addEventListener('mousemove', (e) => {
  const li = e.target.closest('.pal-item');
  if (!li || Number(li.dataset.i) === palActive) return;
  palActive = Number(li.dataset.i);
  markPalActive(false);
});
palList.addEventListener('click', (e) => {
  const li = e.target.closest('.pal-item');
  if (li) runPalette(Number(li.dataset.i));
});
$('#btn-palette').addEventListener('click', openPalette);
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    if (palette.open) closeSheet(palette);
    else openPalette();
  }
});

// App shortcuts (long-press the installed app icon): ?action=focus|break|zen
{
  const action = new URLSearchParams(window.location.search).get('action');
  if (action) {
    window.history.replaceState(null, '', window.location.pathname);
    if (action === 'focus' || action === 'break') {
      const mode = action === 'focus' ? 'focus' : 'short';
      if (timer.mode === mode) {
        if (!timer.running) start();
      } else if (isFresh()) {
        switchTo(mode);
        start();
      } else {
        // Don't throw away a session that's in progress without asking.
        toast({
          icon: '⏸️',
          title: `Your ${MODES[timer.mode].label.toLowerCase()} session is still on`,
          body: 'Carry on with it, or switch and start fresh.',
          duration: 10000,
          action: { label: `Start ${MODES[mode].label.toLowerCase()}`, onClick: () => { switchTo(mode); start(); } },
        });
      }
    } else if (action === 'zen') {
      setZen(true);
    }
  }
}
offerSharedMix();
offerJoin();
offerParty();
renderPartyButton();
requestAnimationFrame(() => el.body.classList.add('is-ready'));
selectStatTab(0, { animate: false });
renderWhatsNew();
// Someone who already used an earlier version doesn't need the welcome.
if (!settings.welcomed && (tasks.length || history.length)) settings.welcomed = true;
maybeWelcome();
