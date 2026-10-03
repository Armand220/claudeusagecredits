# Tempo — a calm focus timer

**Live site: https://armand220.github.io/claudeusagecredits/**

Tempo is a Pomodoro focus timer with tasks, a 3D sound mixer, stats and
achievements. It runs entirely in your browser, works offline, and can be
installed as an app on your phone or computer.

## Features

**Timer**
- Focus, short break and long break, with a long break after every few focus
  sessions. One-tap presets: Classic 25/5, Deep 50/10, Sprint 15/3, Long haul 90/20
- Watch-face dial with a glowing progress ring, tick marks and session dots
- **Flowtime**: pick ∞ in the length picker to count up instead, stop
  whenever you lose steam, and take a break worth a fifth of the time you
  worked (adjustable in Settings). A gentle nudge after 90 minutes
- **+1 min** (or `+` / `-`) to stretch or trim a running session
- Keeps accurate time in background tabs and picks up where it left off after a reload
- Chime, optional notification, optional auto-start; when a session ends the
  toast offers **Start break / Start focus** and a one-tap rating of how it went
- **Distracted** button (`D`) to tally wandering thoughts during focus
- Breathing guide during breaks (box breathing)
- **Zen mode**: a fullscreen, distraction-free timer (`F`)
- **Floating mini timer** that stays on top of other windows (`P`)
- The browser tab icon becomes a little progress ring

**3D sound** (best with headphones)
- **Mixer**: layer as many sounds as you like, each with its own volume —
  Rain, Waves, Fireplace, Wind, Stream, Night, **Birdsong**, Wind chimes,
  Cat purring, Clock, **Train ride**, **Café**, **Lo-fi beats**, **Study hall**,
  Binaural, Brown noise, Fan
- **Ready-made mixes** (Cozy cabin, Seaside, Campfire night, Rainy café,
  Forest stream, Cat nap, Breezy porch, Stormy study, Library, Night train,
  Morning walk, Coffee shop…) and your own saved mixes
- **Sleep timer** that fades the sounds out after 15–90 minutes
- **3D room**: you're in the middle; drag each sound around your head, or
  press orbit to make it circle you
- **Turn around**: drag your head in the room, or on a phone hold it up and
  physically turn — the sounds stay where they are
- **Lo-fi beats** are composed live: swung drums, bass, electric piano chords,
  a bell melody, vinyl crackle and tape wobble, with the band placed around you
- Everything is synthesised in the browser (no audio files)
- Clicks, pops and typing sounds come from where they happen on screen
- Option to play ambient sound only while the timer runs
- **Train ride**: wheels clack over the rail joints in front of you and then
  behind, other trains rush past on your left, and the horn sounds far ahead
- **Study hall**: people typing, turning pages and writing at desks all
  around you, and someone walking past now and then
- **Birdsong**: seven birds with their own songs perched in the trees around
  you, leaves rustling, and a woodpecker drumming far off
- **Café**: murmured conversations at the tables around you, cups and spoons,
  the milk steamer at the counter and the bell over the door
- Animated backgrounds match the sound: rain streaks, rising embers, fireflies
  and stars, rolling waves, drifting leaves, glinting water, floating music
  notes, hills and telegraph poles rolling past, dust in a reading lamp's light,
  sunbeams with birds flying by, warm café lights and rising steam
- Ambient sound dips while the end-of-session chime plays
- Five chime styles: Bells, Kalimba, Gong, Birds (all around you) and Digital

**Tasks**
- Add tasks with an estimate; tap one to count sessions towards it
- Add **#tags** to task names (`Essay #school`) and they become coloured
  pills; Stats shows how your focus splits between tags
- Edit inline, drag to reorder, swipe on phones (right to tick off, left to
  delete), undo deletes
- "Finish around" estimate for what's left
- **Today's intention**: a line under the timer for what you want from the
  day (`I`); it clears itself tomorrow and stays visible in zen mode
- **Session notes**: tap 📝 when a session ends (or the pencil next to any
  session in Stats) to note what you got done

**Progress**
- Daily goal meter with a celebration when you hit it
- Stats with Overview (today, streak, last 7 days vs the week before,
  12-week heatmap: tap a day to see its sessions), History (best focus hours,
  focus by task and by tag, recent sessions with ratings and distractions)
  and Achievements (eighteen to unlock)
- **Share today**: a ready-to-post image of your day's focus
- Export and import a backup file to move your data between devices

**Look and feel**
- Light and dark themes, six colour palettes (Sunset, Ocean, Forest, Lavender,
  Rose, Mono), and your own background photo (kept on your device)
- Glass cards, drifting aurora, springy buttons with ripples and confetti, a
  cursor spotlight and a gentle 3D tilt
- Respects "reduce motion"; accessibility audit (axe) passes with no issues
- Open in two tabs and they stay in sync
- On phones: app-style Timer / Sounds / Tasks tabs with a mini timer bar;
  wide screens show all three side by side
- Installable, with shortcuts (Start focusing, Take a break, Zen mode)

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `Space` | Start / pause |
| `R` | Reset |
| `S` | Skip to the next session (in Flowtime: finish and take your break) |
| `1` `2` `3` | Focus / short break / long break |
| `+` `-` | Add / remove a minute |
| `N` | New task |
| `F` | Zen mode |
| `P` | Floating mini timer |
| `I` | Write today's intention |
| `D` | Note a distraction |
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
- `js/share.js`: the shareable image of your day
- `js/photo.js`: your background photo (stored in IndexedDB)
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
