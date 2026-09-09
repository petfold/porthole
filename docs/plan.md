# porthole — plan

Each phase ends with a demo that a person can run on a phone. Phases are
ordered so that the payoff moment — hearing someone from where they stand —
arrives as early as possible.

## Phase 0 — spikes (no product code)

Run every spike in `spikes.md` and record results there. Stop and revise
`design.md` if S1, S2, or S4 fails.

Exit: all spikes have a recorded result; open decisions that depended on them
are closed in `decisions.md`.

## Phase 1a — the window, local world (current)

A single phone, a primitive world shipped with the bundle, correct rotation,
a vehicle (D-21). Spikes S1, S6, S7 run inside the app's settings panel (gear icon or `?panel`).

- `world.json` with boxes, pyramids, a cylinder, a sphere; loaded from
  `./worlds/shapes/`.
- Orientation from `RelativeOrientationSensor`, falling back to
  `deviceorientation`, then touch drag.
- Throttle from `devicemotion` linear acceleration; hold to brake;
  double-tap recentres.
- Three steering modes switchable at runtime for the D-10 feel test.
- FOV from the screen-size estimate plus the bank-card calibration slider.
- Sensor/rate/impulse readout in the debug panel.

Exit: Peter rides around the shapes on a GrapheneOS phone over `pnpm
dev:phone`, records the S1/S6/S7 tables in `spikes.md`, and picks a steering
mode (closes D-10, D-22, D-23).

## Phase 1c — the window follows the eye

- Spike S8 first.
- Front camera stream at low resolution; MediaPipe Face Landmarker in a
  worker at a configurable 5–10 inferences/s.
- Distance from iris diameter with an IPD cross-check; one-time focal
  calibration in the settings panel.
- Fusion with the inertial displacement estimator; fixes reset drift.
- Off-axis frustum from the eye position (D-27); the 40 cm constant becomes
  the fallback when no face is tracked.
- Decide D-28 (throttle source).

Exit: on the Pixel 7a, moving the eye from 40 cm to 10 cm widens the window
smoothly from about 20° to about 70° with no visible warping, and the
landmarks stay locked with one eye in frame.

## Phase 1b — the window, from Swarm

- Load `world.json` and `scene.glb` from a Swarm reference (local Bee or
  gateway).
- Steering mode fixed per the D-10 decision; unused modes removed.
- `scripts/publish-to-swarm` uploads the bundle and prints the `bzz` address.

Exit: someone who has never seen the app opens the Swarm address on a
GrapheneOS phone, holds it up, turns, rides around the scene, and says it
feels like looking through a window. Runs at 60 fps on a Pixel-class phone.

## Phase 2 — presence and earshot

Two or three phones in the same world, seeing and hearing each other.

- Ephemeral identity; name entry.
- Yjs awareness over `swarm-collaborative-docs`; avatars drawn and
  dead-reckoned.
- WebRTC audio tracks; per-peer HRTF panner; distance rolloff; amplifier
  toggle in the UI.
- Nearest-N peer selection (can be tested with N=1 and three phones).

Exit: two people in separate rooms, each with headphones, ride toward each
other, hear each other get louder and move across the stereo field, and can
hold a conversation. A third person with the amplifier on is audible from
across the world.

## Phase 3 — objects

Movable objects with convergent ownership.

- Object definitions in `world.json`; `objects` map in the Yjs document.
- Grab, carry, put down; lease refresh and expiry.
- Snapshot feeds via the library; late-join recovery.

Exit: two people grab the same object within a second of each other; both
phones agree on who holds it within one second; the loser sees it leave
their hand. One phone is switched off while holding; the object frees after
the lease. A third phone joins later and sees the object where it was left.

## Phase 4 — polish for demo

Only what the demo needs.

- Spawn choice, a simple HUD (speed, name, amplifier), a "who's here" list.
- A second hand-built world to show that the world id is all that changes.
- README with a walkthrough and the current Swarm address.

Exit: a five-minute demo can be given from a fresh phone with no setup beyond
opening a link and granting permissions.

## Not planned

See `design.md` §10. Do not start any of it without a new decision line.
