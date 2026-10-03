# Tempo — a calm focus timer

**Live site: https://armand220.github.io/claudeusagecredits/**

Tempo is a Pomodoro focus timer with tasks, a 3D sound mixer, stats and
achievements. It runs entirely in your browser, works offline, and can be
installed as an app on your phone or computer.

## Features

**Timer**
- Focus, short break and long break, with a long break after every few focus
  sessions. One-tap presets: Classic 25/5, Deep 50/10, Sprint 15/3, Flow 90/20
- Watch-face dial with a glowing progress ring, tick marks and session dots
- **+1 min** (or `+` / `-`) to stretch or trim a running session
- Keeps accurate time in background tabs and picks up where it left off after a reload
- Chime, optional notification, optional auto-start; when a session ends the
  toast offers **Start break / Start focus**
- Breathing guide during breaks (box breathing)
- **Zen mode**: a fullscreen, distraction-free timer (`F`)
- **Floating mini timer** that stays on top of other windows (`P`)
- The browser tab icon becomes a little progress ring

**3D sound** (best with headphones)
- **Mixer**: layer as many sounds as you like, each with its own volume —
  Rain, Waves, Fireplace, Night, Clock, **Lo-fi beats**, Binaural, Brown noise, Fan
- **3D room**: you're in the middle; drag each sound around your head, or
  press orbit to make it circle you
- **Turn around**: drag your head in the room, or on a phone hold it up and
  physically turn — the sounds stay where they are
- **Lo-fi beats** are composed live: swung drums, bass, electric piano chords,
  a bell melody, vinyl crackle and tape wobble, with the band placed around you
- Everything is synthesised in the browser (no audio files)
- Clicks, pops and typing sounds come from where they happen on screen
- Option to play ambient sound only while the timer runs
- Animated backgrounds match the sound: rain streaks, rising embers, fireflies
  and stars, rolling waves, floating music notes

**Tasks**
- Add tasks with an estimate; tap one to count sessions towards it
- Edit inline, drag to reorder, swipe on phones (right to tick off, left to
  delete), undo deletes
- "Finish around" estimate for what's left

**Progress**
- Daily goal meter with a celebration when you hit it
- Stats with Overview (today, streak, last 7 days, 12-week heatmap),
  History (best focus hours, recent sessions) and Achievements (twelve to unlock)
- Export and import a backup file to move your data between devices

**Look and feel**
- Light and dark themes, six colour palettes (Sunset, Ocean, Forest, Lavender,
  Rose, Mono)
- Glass cards, drifting aurora, springy buttons with ripples and confetti, a
  cursor spotlight and a gentle 3D tilt
- Respects "reduce motion"; accessibility audit (axe) passes with no issues
- Open in two tabs and they stay in sync

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `Space` | Start / pause |
| `R` | Reset |
| `S` | Skip to the next session |
| `1` `2` `3` | Focus / short break / long break |
| `+` `-` | Add / remove a minute |
| `N` | New task |
| `F` | Zen mode |
| `P` | Floating mini timer |
| `M` | Mute / unmute ambient sound |
| `[` `]` | Ambient volume down / up |
| `?` | Tips and shortcuts |

## How it's built

Plain HTML, CSS and JavaScript modules, with no build step and no dependencies.

- `index.html`: page structure
- `styles.css`: design, themes and animations
- `js/app.js`: timer, tasks, stats, goals, achievements, settings, mixer UI
- `js/audio.js`: the sound engine (Web Audio API with HRTF spatial panning)
- `js/scenery.js`: animated backgrounds
- `js/effects.js`, `js/fx.js`, `js/toast.js`: visual effects and notifications
- `js/pip.js`: the floating mini timer
- `sw.js`, `manifest.webmanifest`: offline support and app install

Your data is saved in your browser's local storage and never leaves your device.

## Run it locally

Serve the folder with any static file server, for example:

```sh
npx http-server -c-1 .
```

Then open http://localhost:8080.

## Hosting

The site is published with GitHub Pages from the
`claude/kind-darwin-yl7d1i` branch. Every push redeploys it automatically.
