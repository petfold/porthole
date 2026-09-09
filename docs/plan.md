# porthole — plan

Each phase ends with a demo that a person can run on a phone. Phases are
ordered so that the payoff moment — hearing someone from where they stand —
arrives as early as possible.

## Phase 0 — spikes (no product code)

Run every spike in `spikes.md` and record results there. Stop and revise
`design.md` if S1, S2, or S4 fails.

Exit: all spikes have a recorded result; open decisions that depended on them
are closed in `decisions.md`.

## Phase 1 — the window

A single phone, a static world, correct rotation, a vehicle.

- Load `world.json` and `scene.glb` from a Swarm reference (local Bee or
  gateway).
- Orientation from the sensor; recentre on long press; FOV from the
  calibration slider.
- Vehicle: yaw steers, push/pull throttles, touch brakes; ground-following.
- Touch-drag fallback when sensors are unavailable.
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
