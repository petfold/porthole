# porthole — references

## Own prior work

- `swarm-collaborative-docs` — <https://github.com/Solar-Punk-Ltd/swarm-collaborative-docs>.
  Yjs over Swarm: per-peer snapshot feeds, WebRTC with SDP signalling through
  Swarm feeds, member discovery via feeds. The sync layer porthole builds on.
- CRDT discussion, 6–7 July 2026 ("CRDTs and text editor operation
  ordering"): the vase example; why a blockchain is the wrong tool for
  real-time conflict; the design space (LWW on position → LWW on holder →
  leases → rollback → design the conflict away). Basis for D-09.
- Design discussion, 9 September 2026: sensor fusion on GrapheneOS, the
  phone-as-window, vehicle controls, strict geometry, spatial audio, open 3D
  world data. Basis for D-05, D-06, D-10.
- `galley` (collaborative Typst on Swarm) and `dappdata` — sibling projects
  with the same handoff structure; `dappdata` is the planned identity layer.

## Related projects (seen 2026-09-09)

- `mythos` (meinharrd) — <https://github.com/meinharrd/mythos>. Browser FPS in
  three.js/TypeScript/Vite, everything procedural (geometry, textures, HRTF
  audio). Multiplayer is **gun.js** with a relay on vibing.at, not Swarm:
  each peer writes a flat `PeerState` at 15 Hz under a room node; damage is
  "trust the shooter" as a cumulative counter per attacker (never per-hit
  events, because LWW would drop them); replayed stale states filtered by
  sender timestamp. Useful to porthole: `AGENTS.md` conventions (yaw 0 = −z,
  forward = (−sin yaw, −cos yaw), same as ours; never add lights at runtime;
  frozen shadow map), `RemoteAvatar` smoothing (exponential lerp, snap over
  6 m), procedural human rig, `Touch.ts` joystick, headless `mp-bot` for
  multiplayer testing without a second phone.
- `vibing.at/phone` (meinharrd) — one phone streams `deviceorientation` at
  25 Hz to a second browser that mirrors a 3D phone. Transport is
  **libp2p gossipsub** over WebSocket/WebRTC via "pubrelay" boot nodes on
  vibing.at (`createPubrelayNode`, `joinLive(channel)`), with role election
  by join timestamp and 1 Hz heartbeats. The orientation → quaternion
  mapping is the same DeviceOrientationControls construction porthole uses.
  Shows the "phone as controller, other screen as window" split that
  design §10 lists under casting.

## Swarm

- Bee docs — <https://docs.ethswarm.org/>
- bee-js — <https://github.com/ethersphere/bee-js> (12.x; feeds, uploads,
  manifests)
- Feeds, single-owner chunks, GSOC: Bee docs and the `swarm` skill
  `references/recipes.md`. Note: GSOC pubsub needs an unreleased Bee; PSS
  subscribe needs a full node. Hence WebRTC for live traffic.

## Browser APIs

- DeviceOrientation and DeviceMotion events — <https://w3c.github.io/deviceorientation/>
- Generic Sensor API (`RelativeOrientationSensor`, `LinearAccelerationSensor`) —
  <https://w3c.github.io/sensors/>
- Web Audio `PannerNode`, HRTF panning, distance models —
  <https://webaudio.github.io/web-audio-api/#PannerNode>
- WebRTC — `RTCPeerConnection.addTrack`, Opus audio
- `getUserMedia` constraints: `echoCancellation`, `noiseSuppression`

## Yjs

- Yjs docs — <https://docs.yjs.dev/>
- Awareness protocol (`y-protocols/awareness`) — ephemeral per-client state
  with timeout; used here for avatars
- y-webrtc (for reference on how awareness rides WebRTC data channels)

## Rendering

- three.js — <https://threejs.org/>; glTF loader
- `3d-tiles-renderer` (NASA AMMOS) — <https://github.com/NASA-AMMOS/3DTilesRendererJS>
  — for later terrain/city streaming
- OGC 3D Tiles — <https://www.ogc.org/standard/3dtiles/>

## Spatial audio background

- Head-related transfer functions; interaural time and level differences;
  the ventriloquism effect (vision captures audio location within roughly
  10–15°). Resonance Audio and Steam Audio as open alternatives to the
  built-in panner if room acoustics are wanted later.
- Spatial proximity chat precedents: Gather, SpatialChat, High Fidelity
  spatial audio, Mozilla Hubs, WorkAdventure (open source).

## Open world data (later)

- Copernicus DEM; Sentinel-2; OpenStreetMap; Overture Maps; Google Open
  Buildings 2.5D
- National LoD2: 3D BAG (NL), German states, Luxembourg, Japan PLATEAU
- awesome-citygml — <https://github.com/OloOcki/awesome-citygml>
- Helsinki reality mesh (open, OBJ) — <https://hri.fi/data/en_GB/dataset/helsingin-3d-kaupunkimalli>
- FlightGear / TerraGear as the open flight-sim precedent

## Tracking background (later)

- Monado (OpenXR runtime), Basalt VIO, OpenVINS, ORB-SLAM3 — visual-inertial
  odometry if 6-DoF hand tracking is ever wanted
- MediaPipe Face Landmarker (WASM) — iris and face landmarks from the front
  camera; the basis for eye distance (D-27, S8) and later head pose
- Iris diameter as a metric reference: horizontal visible iris diameter is
  11.7 ± 0.5 mm in adults (ophthalmic anthropometry); interpupillary
  distance 63 ± 4 mm. Both are used in MediaPipe's own iris depth estimate.
- Eye optics: the centre of perspective is the entrance pupil, about 3 mm
  behind the corneal apex; nodal points about 7 mm; centre of rotation about
  13.5 mm (Gullstrand / Le Grand schematic eyes)
- Off-axis projection: Kooima, "Generalized Perspective Projection" (2008);
  three.js `PerspectiveCamera.setViewOffset` / custom projection matrix
- Zero-velocity updates (ZUPT) — for bounded short-range inertial translation
