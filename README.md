# porthole

A phone as a window onto a shared 3D world on Swarm.

Hold the phone up and turn it: you look around. Push it away from you: you
ride forward on a vehicle. Pull it back: you slow. Other people in the world
are heard through your headphones from where they stand — close voices loud,
distant voices faint, a loud speaker audible from further away. Pick up an
object and put it down somewhere else; everyone sees the same result.

There is no server. The world, the app, and the durable state live on Swarm.
Presence, voice, and object moves run peer-to-peer over WebRTC, with the
phones finding each other through Swarm feeds.

**Status:** Phase 1a — single phone, local world of primitive shapes, sensor
navigation. No networking yet. See `docs/plan.md`.

## Try it on a phone

```
pnpm install      # also copies the MediaPipe runtime and downloads its model into public/
pnpm dev:phone
```

Open `https://<this machine's LAN IP>:5173/` in Vanadium or Chrome on the
phone and accept the self-signed certificate once (sensors need a secure
context). Tap to start.

Vanadium blocks two things per site by default that porthole needs: **Motion
sensors** (looking around) and **JavaScript JIT** (eye tracking runs 8×
slower without it). Tap the icon left of the address bar → Permissions, and
allow both, plus Camera for eye tracking.

- **Look:** turn the phone. The view has the screen's true angular size, so
  it is a small window, not a wide game camera.
- **Go:** push the phone away from you. Pull to slow or reverse. Speed
  persists; the vehicle coasts.
- **Brake:** touch and hold the screen.
- **Recentre:** double-tap (only matters in the `yawrate` steering mode).
- **Stop:** the octagonal STOP button. Zeroes speed and resets the throttle base.
- **Eye tracking (experimental):** panel → Eye (S8) → toggle, or add `?eye`.
  Grants the front camera; the window then widens as you bring the phone
  closer and shifts as you move your head, true to the geometry. Calibrate
  once: hold the phone a known distance from your eye for a second (an A4
  sheet's long edge is 29.7 cm) and tap the matching button.
- **Map:** bottom left, north up, centred on you. The red dot is you; the
  sector shows where you are looking and how wide the window is.
- **Settings:** the gear at top right, or add `?panel` to the URL. Shows
  sensor availability and rates, throttle impulses, the FOV calibration bar
  (match it to a bank card), and the steering mode selector.

URL options: `?mode=look|yawrate|roll`, `?throttle=displacement|impulse`,
`?orientation=generic-sensor|deviceorientation|drag`, `?world=./worlds/shapes/world.json`,
`?panel` (open the settings panel at start), `?eye` (start eye tracking), `?predict=25` (orientation prediction, ms), `?model=auto|detector|landmarker`
(face models used for the eye), `?calibrate` (S8 calibration screen), `?autostart` (skip the tap, for headless tests).

## Try it on a desktop

`pnpm dev`, open <http://localhost:5173/>. Drag to look, `W`/`S` or arrow
keys to throttle, space to brake, `R` to recentre, `Q`/`E` to bank (for the
`roll` mode).

## Publish to Swarm (Phase 1b, spike S4)

Copy `.env.example` to `.env`, set `BEE_URL` and an immutable `BEE_STAMP`,
then:

```
pnpm build
pnpm publish:swarm
```

The script prints the collection reference and the `bzz` URLs to open.

## Worlds

A world is a folder with a `world.json`. Two ship with the bundle:

- `worlds/paris-eiffel/` (default) — about 1.1 km of Paris around the Eiffel
  Tower: building footprints, roads, parks and the Seine from OpenStreetMap,
  plus a procedural Eiffel Tower. Regenerate with `pnpm make:world
  paris-eiffel` (queries the Overpass API once; the app itself never does).
  Map data © OpenStreetMap contributors, ODbL.
- `worlds/shapes/` — a few primitives for tests. Open with
  `?world=./worlds/shapes/world.json`.

A manifest may contain `primitives` (`box`, `pyramid`, `cylinder`, `sphere`
with `position`, `size`, `yaw`, `color`), `buildings` (footprint polygon and
height), `areas` (`water`, `park`), `roads` (width and path) and
`landmarks`. Coordinates are metres, x east, z south, y up. Later phases add
glTF scenes, movable objects and rooms, and load the folder from a Swarm
reference instead of the bundle.

## Layout

- `CLAUDE.md` — entry point for Claude Code
- `docs/design.md` — architecture
- `docs/plan.md` — phases
- `docs/spikes.md` — Phase 0 experiments
- `docs/decisions.md` — decision log
- `docs/references.md` — libraries and prior work
- `src/` — app (`app/`, `sensing/`, `render/`, `world/`; later `presence/`,
  `audio/`, `objects/`, `swarm/`)
- `public/worlds/` — bundled worlds

## Related

- [swarm-collaborative-docs](https://github.com/Solar-Punk-Ltd/swarm-collaborative-docs) — the sync layer porthole builds on

## Licence

BSD-3-Clause. See `LICENSE`.
