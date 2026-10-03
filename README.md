# Tempo — a calm focus timer

**Live site: https://armand220.github.io/claudeusagecredits/**

Tempo is a Pomodoro focus timer with tasks, 3D ambient sound, stats and
achievements. It runs entirely in your browser, works offline, and can be
installed as an app on your phone or computer.

## Features

**Timer**
- Focus, short break and long break sessions, with a long break after every
  few focus sessions (all adjustable in Settings)
- Watch-face dial with a glowing progress ring and tick marks that light up as
  time runs down
- Keeps accurate time in background tabs, and picks up where it left off if you
  reload
- Chime, optional browser notification and optional auto-start when a session ends
- Breathing guide during breaks (box breathing: in, hold, out, hold)
- **Zen mode**: a fullscreen, distraction-free timer (button on the dial, or `F`)

**3D sound** (best with headphones)
- Seven ambient scenes, all generated live in the browser and placed around you:
  Rain, Waves, Fireplace, Night (crickets and a distant owl), Clock, Brown noise, Fan
- Button clicks, pops and typing sounds come from where they happen on screen
- The dial glows in time with the ambient sound

**Tasks**
- Add tasks with an estimate in pomodoros; tap one to track sessions against it
- Edit inline, drag to reorder, tick off, delete with undo
- "Finish around" estimate for everything left on your list

**Progress**
- Daily goal meter in the header with a celebration when you hit it
- Stats: today, streak, last 7 days chart and a 12-week heatmap
- Twelve achievements to unlock

**Feel**
- Light and dark themes (follows your system, or choose one)
- Glassy cards, drifting aurora background, springy buttons with ripples and
  confetti, a cursor spotlight and a gentle 3D tilt
- Respects "reduce motion" settings

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `Space` | Start / pause |
| `R` | Reset |
| `S` | Skip to the next session |
| `N` | New task |
| `1` `2` `3` | Focus / short break / long break |
| `F` | Zen mode |

## How it's built

Plain HTML, CSS and JavaScript modules, with no build step and no dependencies.

- `index.html`: page structure
- `styles.css`: design, themes and animations
- `js/app.js`: timer, tasks, stats, goals, achievements, settings
- `js/audio.js`: the sound engine (Web Audio API with HRTF spatial panning)
- `js/effects.js`, `js/fx.js`, `js/toast.js`: visual effects and notifications
- `sw.js`, `manifest.webmanifest`: offline support and app install

Your data (tasks, stats, settings) is saved in your browser's local storage and
never leaves your device.

## Run it locally

Serve the folder with any static file server, for example:

```sh
npx http-server -c-1 .
```

Then open http://localhost:8080.

## Hosting

The site is published with GitHub Pages from the
`claude/kind-darwin-yl7d1i` branch. Every push redeploys it automatically.
