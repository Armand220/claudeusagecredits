// A shareable image of today's focus: drawn on a canvas, then shared with the
// system share sheet where available, or downloaded as a PNG.

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/**
 * data: { today, sessions, streak, week: [{ label, m, today }], colors: { accent, accent2, bg, ink, ink2, track } }
 */
export async function drawCard(data) {
  if (document.fonts && document.fonts.ready) await document.fonts.ready.catch(() => {});
  const W = 1080;
  const H = 1350;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext('2d');
  const c = data.colors;
  const display = 'Outfit, Inter, system-ui, sans-serif';
  const body = 'Inter, system-ui, sans-serif';

  // Background with soft colour blooms.
  g.fillStyle = c.bg;
  g.fillRect(0, 0, W, H);
  const blob = (x, y, r, col) => {
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    grd.addColorStop(0, col);
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.globalAlpha = 0.55;
    g.fillStyle = grd;
    g.fillRect(0, 0, W, H);
    g.globalAlpha = 1;
  };
  blob(180, 120, 620, c.accent2);
  blob(980, 1250, 700, c.accent);

  // Card
  g.fillStyle = c.card;
  roundRect(g, 70, 150, W - 140, H - 300, 56);
  g.fill();

  // Logo + name
  g.strokeStyle = c.accent;
  g.lineWidth = 9;
  g.lineCap = 'round';
  g.globalAlpha = 0.3;
  g.beginPath();
  g.arc(160, 255, 34, 0, Math.PI * 2);
  g.stroke();
  g.globalAlpha = 1;
  g.beginPath();
  g.arc(160, 255, 34, -Math.PI / 2, 0);
  g.stroke();
  g.fillStyle = c.accent;
  g.beginPath();
  g.arc(160, 255, 9, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = c.ink;
  g.font = `600 52px ${display}`;
  g.textBaseline = 'middle';
  g.fillText('Tempo', 216, 258);
  g.fillStyle = c.ink2;
  g.font = `500 32px ${body}`;
  g.textAlign = 'right';
  g.fillText(data.date, W - 140, 258);
  g.textAlign = 'left';

  // Headline number
  g.fillStyle = c.ink2;
  g.font = `500 40px ${body}`;
  g.fillText('I focused for', 140, 420);
  g.fillStyle = c.ink;
  g.font = `300 180px ${display}`;
  g.fillText(data.today, 128, 560);
  g.fillStyle = c.ink2;
  g.font = `500 40px ${body}`;
  g.fillText('today', 140, 690);

  // Small stats
  const stat = (x, value, label) => {
    g.fillStyle = c.ink;
    g.font = `600 64px ${display}`;
    g.fillText(value, x, 810);
    g.fillStyle = c.ink2;
    g.font = `500 30px ${body}`;
    g.fillText(label, x, 865);
  };
  stat(140, String(data.sessions), data.sessions === 1 ? 'session' : 'sessions');
  stat(480, String(data.streak), 'day streak');

  // Last 7 days
  const max = Math.max(30, ...data.week.map((d) => d.m));
  const baseY = 1110;
  const chartH = 150;
  const slot = (W - 280) / 7;
  data.week.forEach((d, i) => {
    const x = 140 + i * slot + slot / 2 - 22;
    const h = d.m > 0 ? Math.max(8, (d.m / max) * chartH) : 6;
    g.fillStyle = d.m > 0 ? c.accent : c.track;
    g.globalAlpha = d.today || d.m === 0 ? 1 : 0.55;
    roundRect(g, x, baseY - h, 44, h, Math.min(10, h / 2));
    g.fill();
    g.globalAlpha = 1;
    g.fillStyle = d.today ? c.ink : c.ink2;
    g.font = `${d.today ? 700 : 500} 26px ${body}`;
    g.textAlign = 'center';
    g.fillText(d.label, x + 22, baseY + 40);
    g.textAlign = 'left';
  });

  g.fillStyle = c.ink2;
  g.font = `500 28px ${body}`;
  g.textAlign = 'center';
  g.fillText('Focus timer with 3D sound · Tempo', W / 2, H - 80);
  g.textAlign = 'left';

  return canvas;
}

/** Share the card (or download it when sharing files isn't supported). */
export async function shareCard(data) {
  const canvas = await drawCard(data);
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
  const file = new File([blob], `tempo-${new Date().toISOString().slice(0, 10)}.png`, { type: 'image/png' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'My focus today', text: `I focused for ${data.today} today with Tempo.` });
      return 'shared';
    } catch (err) {
      if (err && err.name === 'AbortError') return 'cancelled';
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  return 'downloaded';
}
