// Direction B, "Immersive focus stage": prototype screenshots.
// Usage: node design/immersive-shots.cjs [onlyNameSubstring]
// Seeds the same state as shots.cjs, applies the small DOM changes this
// direction needs, injects immersive.css after styles.css and captures PNGs.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const S = path.join(DIR, '..');
const CSS = path.join(DIR, 'immersive.css');
const only = process.argv[2] || '';

// Serve Inter + Outfit from the local copies so the shots use the real type.
const b64 = (p) => fs.readFileSync(p).toString('base64');
const FONT_CSS = `
@font-face { font-family: 'Inter'; font-style: normal; font-weight: 400 700; font-display: swap; src: url(data:font/woff2;base64,${b64(path.join(S, 'fonts/Inter-latin.woff2'))}) format('woff2'); }
@font-face { font-family: 'Outfit'; font-style: normal; font-weight: 200 700; font-display: swap; src: url(data:font/woff2;base64,${b64(path.join(S, 'fonts/Outfit-latin.woff2'))}) format('woff2'); }`;

// ---- The HTML changes, applied as a DOM script (see the report for the exact index.html diff).
function domChanges() {
  const ICONS = { off: '🔇', rain: '🌧️', storm: '⛈️', waves: '🌊', wind: '🍃', stream: '💧', fire: '🔥', night: '🦗', birds: '🐦', chimes: '🎐', cat: '🐈', clock: '🕰️', train: '🚆', cafe: '☕', lofi: '🎹', study: '📚', binaural: '〰️', brown: '🟤', fan: '🌀' };
  document.querySelectorAll('.chip[data-sound]').forEach((c) => {
    if (c.querySelector('.chip-icon')) return;
    const i = document.createElement('span');
    i.className = 'chip-icon';
    i.setAttribute('aria-hidden', 'true');
    i.textContent = ICONS[c.dataset.sound] || '';
    c.prepend(i);
    // Labels sit in their own span so tiles can wrap them; a soft hyphen lets "Thunderstorm" break.
    const text = [...c.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim());
    text.forEach((n) => {
      const s = document.createElement('span');
      s.className = 'chip-label';
      s.textContent = n.textContent.replace('Thunderstorm', 'Thunder­storm');
      n.replaceWith(s);
    });
  });
}

(async () => {
  const browser = await chromium.launch();
  const now = Date.now(), day = 864e5;
  const hist = [];
  const names = ['Essay draft #school', 'Fix login bug #work', 'Read chapter 3 #school', 'Inbox zero #work', 'Guitar practice'];
  for (let i = 0; i < 40; i++) hist.push({ t: now - Math.floor(i / 3) * day - (i % 3) * 5400e3, m: 25 + (i % 3) * 10, s: i % 9 ? 1 : 0, task: names[i % 5], ...(i % 4 === 0 ? { r: 3 } : {}), ...(i % 7 === 0 ? { n: 'Outlined the intro' } : {}) });
  const d = new Date();
  const base = { settings: { welcomed: true, seenChanges: 99 }, history: hist, tasks: [{ id: 'a', title: 'Essay draft #school', est: 3, pomos: 1 }, { id: 'b', title: 'Fix login bug #work', est: 2, pomos: 0 }, { id: 'c', title: 'Read 30 min', est: 1, pomos: 0, daily: true, day: `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}` }], activeTaskId: 'a', intention: { d: `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`, text: 'Finish the essay draft' }, sound: { volume: 50, mix: { rain: { on: true, vol: 0.7, x: -2.2, z: -1.6 }, fire: { on: true, vol: 0.85, x: 1.8, z: -1.4 } } } };
  const withSettings = (extra) => ({ ...base, settings: { ...base.settings, ...extra } });

  const desk = (w, h, scheme) => ({ viewport: { width: w, height: h }, colorScheme: scheme });
  const phone = (scheme) => ({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, colorScheme: scheme });

  // [name, context options, view, extra steps, state, fullPage]
  const shots = [
    ['desktop-1440-light', desk(1440, 900, 'light'), 'sounds'],
    ['desktop-1440-dark', desk(1440, 900, 'dark'), 'tasks'],
    ['desktop-1280-light', desk(1280, 800, 'light'), 'tasks'],
    ['desktop-1440-stage-light', desk(1440, 900, 'light'), 'timer'],
    ['desktop-1440-running-dark', desk(1440, 900, 'dark'), 'timer', 'run'],
    ['desktop-1280-sounds-dark', desk(1280, 800, 'dark'), 'sounds'],
    ['desktop-1440-break-ocean-light', desk(1440, 900, 'light'), 'tasks', 'break', withSettings({ palette: 'ocean' })],
    ['desktop-1440-lavender-dark', desk(1440, 900, 'dark'), 'sounds', null, withSettings({ palette: 'lavender' })],
    ['desktop-1024-light', desk(1024, 768, 'light'), 'sounds'],
    ['desktop-900-light', desk(900, 700, 'light'), 'tasks'],
    ['desktop-1440-zen-dark', desk(1440, 900, 'dark'), 'timer', 'zen'],
    ['desktop-stats', desk(1440, 900, 'light'), 'timer', 'stats'],
    ['desktop-stats-dark', desk(1440, 900, 'dark'), 'timer', 'stats'],
    ['desktop-settings-dark', desk(1440, 900, 'dark'), 'tasks', 'settings'],
    ['phone-timer', phone('light'), 'timer', null, null, true],
    ['phone-timer-dark-running', phone('dark'), 'timer', 'run', null, false],
    ['phone-sounds', phone('dark'), 'sounds', null, null, true],
    ['phone-sounds-light', phone('light'), 'sounds', null, null, false],
    ['phone-tasks', phone('light'), 'tasks', null, null, true],
  ];

  for (const [name, opts, view, step, state = base, fullPage = false] of shots) {
    if (only && !name.includes(only)) continue;
    const ctx = await browser.newContext({ ...opts, serviceWorkers: 'block' });
    await ctx.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/css', body: FONT_CSS }));
    await ctx.route('https://fonts.gstatic.com/**', (r) => r.abort());
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('http://localhost:8080/');
    await page.evaluate((s) => localStorage.setItem('tempo:v1', JSON.stringify(s)), state || base);
    await page.reload();
    await page.evaluate(domChanges);
    await page.addStyleTag({ path: CSS });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(700);
    if (view !== 'timer') {
      await page.click(`.nav-btn[data-view="${view}"]`);
      await page.waitForTimeout(800);
    }
    if (step === 'run') { await page.click('#btn-toggle'); await page.waitForTimeout(2300); }
    if (step === 'break') { await page.click('.mode-tab[data-mode="short"]'); await page.waitForTimeout(1400); }
    if (step === 'zen') { await page.click('#btn-zen'); await page.waitForTimeout(1200); }
    if (step === 'stats') { await page.click('#btn-stats'); await page.waitForTimeout(1300); }
    if (step === 'settings') { await page.click('#btn-settings'); await page.waitForTimeout(1000); }
    await page.mouse.move(5, 5);
    await page.waitForTimeout(250);
    // Overflow check: anything wider than the viewport, and the page height.
    const info = await page.evaluate(() => ({
      scrollW: document.documentElement.scrollWidth,
      scrollH: document.documentElement.scrollHeight,
      innerW: innerWidth,
      innerH: innerHeight,
    }));
    await page.screenshot({ path: path.join(DIR, `immersive-${name}.png`), fullPage });
    console.log(name, JSON.stringify(info), errors.length ? `ERRORS: ${errors.join(' | ')}` : '');
    await ctx.close();
  }
  await browser.close();
})();
