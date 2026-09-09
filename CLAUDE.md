# porthole — Claude Code entry point

`porthole` is a phone-as-window onto a shared 3D world that lives on Swarm.
You hold the phone up, turn it, and see the world through it. You move by
riding a vehicle you steer with the phone. People near you in the world are
audible through your headphones from the direction they stand. Objects can be
picked up and moved, and everyone sees the same result. No server exists
anywhere: static content, presence, audio, and object state all run over
Swarm and peer-to-peer WebRTC.

This is a **proof of concept**. Optimise for a working demo with two or three
phones, not for scale, polish, or safety. Read `docs/design.md` before
touching anything.

## Read in this order

1. `docs/design.md` — what porthole is and how the pieces fit
2. `docs/plan.md` — phases and what "done" means for each
3. `docs/spikes.md` — Phase 0 experiments; run these before Phase 1 code
4. `docs/decisions.md` — decisions and their status; append, never rewrite
5. `docs/references.md` — libraries, specs, prior work

## Principles

- **No server.** If a feature needs a server, it is out of scope or it needs a
  Swarm or peer-to-peer design first. Write the alternative into
  `docs/decisions.md` before coding.
- **True geometry.** The rendered view uses the real angular size of the
  screen, and spatial audio uses the same world coordinates as the picture.
  No field-of-view widening, no rotation gain. See D-05.
- **Rigid transforms only.** Recentring (rotate the world) and window height
  (translate the world) are allowed. Anything that warps space is not.
- **Positions are intent plus time.** Peers share pose, velocity, and a
  timestamp; every client dead-reckons forward. Never rely on update rate for
  smoothness.
- **CRDT for state, awareness for presence.** Durable objects live in the Yjs
  document. Avatars live in Yjs awareness and are never stored.
- **Simple first.** Nearest-N peer selection, LWW ownership with a lease, a
  hand-built glTF scene. Each of these has a "later" note in the design; do
  not build the later version now.

## Stack (see D-03, D-04, D-06)

- TypeScript, Vite, three.js
- `swarm-collaborative-docs` (Solar Punk) for Yjs sync over WebRTC with
  signalling through Swarm feeds; per-peer snapshot feeds for persistence
- Yjs awareness protocol for avatars
- WebRTC audio tracks for voice; Web Audio `PannerNode` (HRTF) for
  spatialisation
- Browser sensor APIs (`deviceorientation`, `devicemotion`, Generic Sensor
  API where available) for phone pose and gestures
- `@ethersphere/bee-js` for feeds, uploads, and manifests
- Static app bundle served from a Swarm collection (a `bzz` manifest)

Target browser: Vanadium on GrapheneOS (Chromium). Test there first, then
desktop Chromium.

## Repository layout (to create)

```
porthole/
  CLAUDE.md
  README.md
  docs/
    design.md plan.md spikes.md decisions.md references.md
  src/
    app/        entry, state, UI shell
    sensing/    orientation, gesture (throttle/steer), recentre
    render/     three.js scene, camera, world loader
    world/      world manifest reader, scene assets
    presence/   Yjs doc + awareness, peer selection, dead reckoning
    audio/      WebRTC audio, PannerNode graph, amplifier
    objects/    holder register, lease, pick-up/put-down
    swarm/      bee-js helpers, feed topics, manifest publishing
  spikes/       one folder per spike in docs/spikes.md
  scripts/      publish-to-swarm, make-world
```

## How to work

- Run the Phase 0 spikes first and record results in `docs/spikes.md`.
  A spike that fails changes the design; stop and update `docs/design.md`
  and `docs/decisions.md` before continuing.
- One phase per pull request where practical. Use the PR template.
- Every new behaviour that another peer can observe (a message, a feed write,
  an object change) gets a line in `docs/design.md` under "What crosses the
  network".
- Keep `docs/decisions.md` current. A choice you make without a decision line
  is a bug.
- Do not add abuse controls, moderation, face tracking, casting, or 3D Tiles
  streaming. These are listed as later work; the PoC does not need them.

## Environment

- Node 22+, pnpm
- A Bee node (light node is enough) at `BEE_URL`, with one immutable postage
  stamp for feeds and the bundle. See `.env.example`.
- Two phones on GrapheneOS, or one phone plus a desktop browser, for
  presence and audio tests.
