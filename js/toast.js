// Springy toast notifications with an optional action button (e.g. Undo).

const MAX_VISIBLE = 3;
let host = null;

function container() {
  if (!host) {
    host = document.createElement('div');
    host.className = 'toasts';
    host.setAttribute('role', 'status');
    host.setAttribute('aria-live', 'polite');
    document.body.appendChild(host);
  }
  return host;
}

/**
 * toast({ title, body, icon, action: { label, onClick }, duration })
 * Returns a function that dismisses the toast.
 */
export function toast({ title, body = '', icon = '', action = null, duration = 4200, tone = '' } = {}) {
  const root = container();
  const el = document.createElement('div');
  el.className = `toast${tone ? ` is-${tone}` : ''}`;

  if (icon) {
    const i = document.createElement('span');
    i.className = 'toast-icon';
    i.textContent = icon;
    el.appendChild(i);
  }
  const text = document.createElement('div');
  text.className = 'toast-text';
  const t = document.createElement('strong');
  t.textContent = title;
  text.appendChild(t);
  if (body) {
    const b = document.createElement('span');
    b.textContent = body;
    text.appendChild(b);
  }
  el.appendChild(text);

  let closed = false;
  let timer = 0;
  const dismiss = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    el.classList.add('is-leaving');
    setTimeout(() => el.remove(), 260);
  };

  if (action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast-action pressable';
    btn.textContent = action.label;
    btn.addEventListener('click', () => {
      action.onClick?.(btn);
      dismiss();
    });
    el.appendChild(btn);
  }

  const bar = document.createElement('span');
  bar.className = 'toast-timer';
  bar.style.animationDuration = `${duration}ms`;
  el.appendChild(bar);

  // Hovering pauses the countdown (and its progress bar) where it is.
  let remaining = duration;
  let startedAt = 0;
  const arm = () => {
    startedAt = Date.now();
    timer = setTimeout(dismiss, remaining);
  };
  el.addEventListener('pointerenter', () => {
    clearTimeout(timer);
    remaining = Math.max(400, remaining - (Date.now() - startedAt));
    el.classList.add('is-paused');
  });
  el.addEventListener('pointerleave', () => {
    el.classList.remove('is-paused');
    if (!closed) arm();
  });

  root.appendChild(el);
  const live = [...root.children].filter((c) => !c.classList.contains('is-leaving'));
  live.slice(0, Math.max(0, live.length - MAX_VISIBLE)).forEach((old) => {
    old.classList.add('is-leaving');
    setTimeout(() => old.remove(), 260);
  });
  arm();
  return dismiss;
}
