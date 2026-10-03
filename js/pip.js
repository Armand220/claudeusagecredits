// A floating, always-on-top mini timer.
// Uses Document Picture-in-Picture where available (Chrome, Edge), and falls
// back to a video picture-in-picture of a canvas (Safari).

let opts = null;
let pipWin = null;
let video = null;
let canvas = null;
let lastKey = '';

export const supported = () =>
  'documentPictureInPicture' in window || Boolean(document.pictureInPictureEnabled && HTMLCanvasElement.prototype.captureStream);

export const isOpen = () => Boolean(pipWin) || Boolean(video && document.pictureInPictureElement === video);

/** opts: { getState: () => state, onToggle, onSkip, onClose } */
export function init(o) {
  opts = o;
}

export async function toggle() {
  if (isOpen()) return close();
  return open();
}

export async function open() {
  if ('documentPictureInPicture' in window) {
    pipWin = await window.documentPictureInPicture.requestWindow({ width: 300, height: 190 });
    build(pipWin.document);
    pipWin.addEventListener('pagehide', () => {
      pipWin = null;
      opts.onClose && opts.onClose();
    });
    update(true);
    return;
  }
  if (document.pictureInPictureEnabled) {
    canvas = canvas || Object.assign(document.createElement('canvas'), { width: 480, height: 270 });
    drawCanvas(opts.getState());
    if (!video) {
      video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.srcObject = canvas.captureStream();
      // The window's play/pause button controls the timer.
      video.addEventListener('pause', () => {
        if (isOpen() && opts.getState().running) opts.onToggle();
      });
      video.addEventListener('play', () => {
        if (isOpen() && !opts.getState().running) opts.onToggle();
      });
      video.addEventListener('leavepictureinpicture', () => opts.onClose && opts.onClose());
    }
    await video.play();
    await video.requestPictureInPicture();
  }
}

export async function close() {
  if (pipWin) {
    const w = pipWin;
    pipWin = null;
    w.close();
  } else if (video && document.pictureInPictureElement === video) {
    await document.exitPictureInPicture().catch(() => {});
  }
}

const STYLE = `
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; }
  body {
    display: grid; place-items: center;
    background: radial-gradient(120% 120% at 20% 0%, var(--accent-soft), transparent 60%), var(--bg);
    color: var(--ink);
    font-family: "Outfit", "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    user-select: none; overflow: hidden;
  }
  .pip { display: grid; grid-template-columns: auto auto; justify-content: center; align-items: center; gap: 6vw; padding: 16px 20px; }
  .ring { width: clamp(70px, 30vmin, 260px); height: clamp(70px, 30vmin, 260px); transform: rotate(-90deg); }
  .ring circle { fill: none; stroke-width: 9; }
  .track { stroke: var(--track); }
  .fill { stroke: var(--accent); stroke-linecap: round; transition: stroke-dashoffset 1s linear; }
  .time { font-size: clamp(36px, 15vmin, 140px); font-weight: 300; line-height: 1; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
  .mode { margin-top: 4px; font-size: clamp(12px, 4vmin, 22px); font-weight: 600; color: var(--ink-2); }
  .actions { display: flex; gap: 8px; margin-top: 12px; }
  button {
    font: inherit; font-size: 14px; font-weight: 700; cursor: pointer;
    border: 0; border-radius: 999px; padding: 8px 16px;
    background: var(--accent); color: var(--on-accent);
    transition: transform .3s cubic-bezier(.3,1.9,.5,1);
  }
  button:active { transform: scale(.92); }
  button.ghost { background: var(--track); color: var(--ink); }
`;

function build(doc) {
  doc.title = 'Tempo';
  const style = doc.createElement('style');
  style.textContent = STYLE;
  doc.head.appendChild(style);
  doc.body.innerHTML = `
    <div class="pip">
      <svg class="ring" viewBox="0 0 100 100" aria-hidden="true">
        <circle class="track" cx="50" cy="50" r="42"/>
        <circle class="fill" cx="50" cy="50" r="42" stroke-dasharray="263.9" stroke-dashoffset="0"/>
      </svg>
      <div>
        <div class="time" role="timer"></div>
        <div class="mode"></div>
        <div class="actions">
          <button type="button" data-act="toggle"></button>
          <button type="button" class="ghost" data-act="skip">Skip</button>
        </div>
      </div>
    </div>`;
  doc.body.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]');
    if (!act) return;
    if (act.dataset.act === 'toggle') opts.onToggle(act);
    else opts.onSkip(act);
  });
  doc.addEventListener('keydown', (e) => {
    if (e.key === ' ') {
      e.preventDefault();
      opts.onToggle();
    }
  });
}

/** Refresh the mini timer from the current state. */
export function update(force = false) {
  if (!isOpen()) return;
  const st = opts.getState();
  const key = `${st.clock}|${st.mode}|${st.running}|${st.colors.accent}|${st.colors.bg}`;
  if (key === lastKey && !force) return;
  lastKey = key;

  if (pipWin) {
    const doc = pipWin.document;
    const root = doc.documentElement;
    for (const [k, v] of Object.entries(st.colors)) root.style.setProperty(`--${k}`, v);
    doc.querySelector('.time').textContent = st.clock;
    doc.querySelector('.mode').textContent = st.mode;
    doc.querySelector('.fill').style.strokeDashoffset = String(263.9 * (1 - st.fraction));
    doc.querySelector('[data-act="toggle"]').textContent = st.running ? 'Pause' : 'Start';
    doc.title = `${st.clock} · Tempo`;
  } else if (video) {
    drawCanvas(st);
    if (st.running && video.paused) video.play().catch(() => {});
    if (!st.running && !video.paused) video.pause();
  }
}

function drawCanvas(st) {
  const c = canvas.getContext('2d');
  const { width: w, height: h } = canvas;
  c.fillStyle = st.colors.bg;
  c.fillRect(0, 0, w, h);
  const cx = 130;
  const cy = h / 2;
  c.lineWidth = 16;
  c.lineCap = 'round';
  c.strokeStyle = st.colors.track;
  c.beginPath();
  c.arc(cx, cy, 80, 0, Math.PI * 2);
  c.stroke();
  c.strokeStyle = st.colors.accent;
  c.beginPath();
  c.arc(cx, cy, 80, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.max(0.001, st.fraction));
  c.stroke();
  c.fillStyle = st.colors.ink;
  c.font = '300 76px Outfit, Inter, system-ui, sans-serif';
  c.textBaseline = 'middle';
  c.fillText(st.clock, 245, cy - 12);
  c.fillStyle = st.colors['ink-2'];
  c.font = '600 24px Inter, system-ui, sans-serif';
  c.fillText(st.mode, 248, cy + 48);
}
