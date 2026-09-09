# porthole — design

Status: proof of concept. Decisions referenced as D-nn live in `decisions.md`.

## 1. What it is

A phone is a small window onto a shared 3D world stored on Swarm. Turning the
phone turns the view. A vehicle metaphor moves you through the world. People
present in the world appear as avatars and are heard through headphones from
where they stand, louder when close. Objects can be picked up, carried, and
put down; every participant ends up seeing the same placement.

Everything runs in the browser. Swarm holds the world, the app bundle, the
durable object state, and the signalling records that let phones find each
other. Live traffic between phones — poses, voice, object updates — runs over
WebRTC between the peers themselves.

## 2. Goals and non-goals

Goals for the PoC:

- A single phone shows a static world with correct rotation and a vehicle.
- Two or three phones see each other move and hear each other spatially.
- Two phones can contend for one object and converge on one outcome without
  a server.
- The whole thing is served from a Swarm collection address.

Non-goals for the PoC (each has a "later" note in §10):

- Abuse handling, moderation, blocking
- Face tracking, off-axis parallax, casting to a big screen
- Global terrain or 3D Tiles streaming
- Persistent identity across sessions
- More than a dozen peers in one place

## 3. Concepts

| Term | Meaning |
|---|---|
| World | A static scene plus a set of movable objects and a coordinate frame. Identified by its Swarm manifest reference. |
| Window | The phone screen, rendered with the screen's true angular size. |
| Vehicle | The thing you ride. Its pose is your pose. It has speed and heading. |
| Avatar | A peer's presence in the world: pose, velocity, name, amplifier flag. Never stored. |
| Earshot | The set of peers whose audio you receive: the N loudest as perceived from where you stand (D-19), restricted to your room if it is closed (D-20). |
| Object | A movable thing with a durable pose and a holder. Stored in the CRDT. |
| Amplifier | A per-avatar flag that multiplies the speaker's loudness. Range grows through the ordinary distance rolloff; nothing else changes (D-19). For talks and performances. |
| Room | An axis-aligned box in `world.json`. A closed room cuts audibility across its boundary in both directions (D-20). |

## 4. Components

### 4.1 World content (static)

A world is a Swarm collection containing:

- `world.json` — name, attribution, geographic origin, coordinate frame
  (metres, Y up; x east, z south), spawn pose, eye height, ground, sky,
  palette, **primitives** (box, pyramid, cylinder, sphere), **buildings**
  (footprint polygons extruded to a height), **areas** (water, park),
  **roads** (ribbons along polylines), **landmarks** (procedural models such
  as the Eiffel Tower), rooms (D-20), object definitions, rendering hints.
  City worlds are generated from OpenStreetMap by `scripts/make-world.mjs`
  (D-26); the app only ever reads the static file.
- `scene.glb` — optional static glTF scene, hand-built for the PoC (D-12).
  Phase 1a uses primitives only and ships the world inside the app bundle
  under `worlds/<name>/` (D-21); a Swarm reference replaces that path later.
- `objects/*.glb` — models for movable objects

The collection reference *is* the world id. It doubles as the topic seed for
presence and signalling feeds (§4.4), so two phones that load the same world
find each other without any further configuration.

### 4.2 Client app

TypeScript, three.js, Vite. Built to a static bundle and uploaded as a Swarm
collection. Loaded over `https://` from a gateway or over `http://localhost:1633`
from a local Bee node; both count as secure contexts, which the sensor,
microphone, and WebRTC APIs require.

### 4.3 Sensing and controls

**Orientation.** The phone's world orientation comes from the browser's
fused rotation vector: `deviceorientation` (or the Generic Sensor API
`RelativeOrientationSensor` where available). Gyro-based; yaw drifts slowly.
Nothing in porthole needs absolute yaw, because:

**Recentre.** A double-tap (or the panel button) defines the current phone
yaw as "straight ahead along the vehicle". Only yaw is referenced; pitch and
roll come from gravity and need no reference. The vehicle heading absorbs the
offset so the view never jumps. This is a rotation of the whole world about
the vertical, so geometry and audio stay consistent (D-05). Recentre matters
only in the `yawrate` steering mode; in the other modes nothing is referenced
to the body and it is inert (D-22).

**Steering.** Three modes are implemented for the Phase 1 feel test (D-22):
`look` (default) — heading equals view yaw, you go where you look;
`yawrate` — phone yaw relative to the recentred reference is a handlebar
angle and the heading turns at a proportional rate, the view being the phone
relative to the vehicle; `roll` — banking the phone steers and yaw looks
freely. D-10 is settled after trying them on a phone.

**Throttle.** Default (D-24): the phone is a joystick in space. Its
displacement from a base position along the screen normal sets the target
speed — hold it out to go, further for faster, bring it back to stop, pull
in to reverse. Displacement is estimated by integrating linear acceleration
with zero-velocity updates while the phone is still; holding the screen
brakes and re-bases. The alternative `impulse` model: a push of the phone
away from the body adds to vehicle speed; a pull subtracts. Read `devicemotion` linear acceleration along the screen
normal, in the *device* frame, so orientation error cannot leak gravity into
the reading. Integrate the first half of the gesture (until the sign flips)
to get an impulse; add it to speed, clamped. Then wait until the phone is
still before arming again, so bringing the phone back is not read as the
opposite gesture. Ignore gestures during fast rotation (the sensor sits off
the rotation axis and reads centripetal acceleration). Speed persists — the
vehicle coasts. A touch on screen is a brake: speed decays to zero while held.

**Flight.** Off in the PoC. The vehicle stays on the world's ground height.
A flag in `world.json` may enable free flight later; controls then follow the
RC-transmitter mapping (pitch/roll translate, yaw turns, push/pull throttles).

**Rendering FOV.** The vertical field of view is computed from the viewing
distance and the screen's physical size. Browsers do not expose physical
size, so the app estimates it from `devicePixelRatio` and a typical density,
and exposes a one-time calibration slider ("match this ruler"). See D-05.
The world is drawn as seen through a hole of that size; nothing is widened.
Phase 1a assumes 40 cm. Phase 1c (D-27) measures the eye position with the
front camera — iris diameter as the size reference, inertial bridging
between camera fixes — and renders an off-axis frustum from it, so the
window widens naturally as the eye comes closer. The viewpoint is the eye
nearest the screen's centre axis, with hysteresis (D-29); with one eye in
view, that eye.

### 4.4 Presence and sync

Built on `swarm-collaborative-docs` (D-03), which gives:

- a Yjs document synced between peers over WebRTC data channels
- WebRTC signalling (SDP offers and answers) written to and read from Swarm
  feeds, so there is no signalling server
- member discovery through feeds
- per-peer snapshot feeds so late joiners recover state from Swarm

porthole uses this in two tiers:

**Document** (durable). One Yjs document per world. Contains `objects`, a
`Y.Map` keyed by object id. Each object is a `Y.Map` with fields
`pose` (position, quaternion), `holder` (peer id or null), `leaseUntil`
(wall-clock ms), and `version`. Fields are last-writer-wins registers.
The document is small and changes only when someone picks up or puts down an
object.

**Awareness** (ephemeral). The Yjs awareness protocol carries each peer's
avatar: `{peerId, name, pose, velocity, heading, amplifier, t}`. Sent at
10 Hz while moving, 1 Hz while still. Awareness entries expire on their own
when a peer goes quiet, which is exactly the semantics an avatar needs.
Awareness is never written to Swarm.

**Dead reckoning.** Every client advances every remote avatar from its last
`(pose, velocity, t)` using local time, and blends to the next update over
100 ms. Held objects follow their holder's avatar; the object's own pose is
only rewritten on put-down.

**Peer selection.** With more peers than `MAX_PEERS` (default 10) present in
a world, the client keeps connections to the `MAX_PEERS` loudest as perceived
from its own position — gain divided by distance to the rolloff power, so an
amplified peer ranks as if it were closer (D-19) — recomputed every 2 s with
hysteresis. Peers separated from the listener by a closed room wall rank
last (D-20).
Peers outside the set are still drawn from awareness if any connected peer
relays it (the Yjs awareness protocol relays), but are not heard.

### 4.5 Audio

Each WebRTC connection carries an Opus audio track in both directions
(spike S2 checks that the library exposes the `RTCPeerConnection` so tracks
can be added; if not, a second connection reusing the same signalling path is
opened for audio).

The Web Audio graph per remote peer:

```
MediaStreamSource → GainNode (amplifier) → PannerNode (HRTF) → destination
```

- `PannerNode` in HRTF mode, `distanceModel: 'inverse'`, `refDistance: 1`,
  `rolloffFactor: 2` (steeper than physics, so two metres away is quiet —
  D-06). Amplified peers keep the same rolloff and get a gain multiplier
  (start 4×); their range grows only because they are louder (D-19).
- Rooms (D-20): if either the listener or the speaker is inside a closed
  room and they are not in the same room, the speaker's gain is zero. Room
  membership is computed locally from the dead-reckoned poses each frame.
- The listener's pose is the local vehicle pose. Head is assumed to face the
  phone; the phone is assumed in front of the body. Steering rotations move
  the listener with the vehicle — correct under that assumption.
- Panner positions update every frame from the dead-reckoned avatar poses,
  so sound and picture use the same coordinates.
- Local microphone: `getUserMedia` with echo cancellation and noise
  suppression on; push-to-talk off by default (open mic) for the demo.

### 4.6 Movable objects

Pick-up and put-down follow the design settled in the CRDT discussion
(July 2026; see `references.md`):

1. **Grab.** The client sets `holder = me`, `leaseUntil = now + LEASE_MS`
   (default 10 s), `version += 1`. It shows the object in hand at once
   (optimistic).
2. **Contention.** If two grabs are concurrent, Yjs LWW resolves `holder`
   deterministically for everyone. The loser sees the object leave their
   hand — a visible correction, not a silent loss.
3. **Carry.** While holding, the object is drawn attached to the holder's
   avatar on every client. The holder refreshes `leaseUntil` every
   `LEASE_MS / 2`.
4. **Put down.** The holder writes the final `pose`, sets `holder = null`.
5. **Dropped connection.** If `leaseUntil` passes without refresh, any client
   treats the object as free and draws it at its last stored `pose`. The next
   grab succeeds.

Awareness prevents most contention: you see the other avatar next to the
object before you reach for it. The PoC does not attempt rollback netcode.

### 4.7 Persistence

`swarm-collaborative-docs` writes each peer's view of the document to that
peer's own snapshot feed. The stored snapshot is the merged Yjs state, so
divergent snapshots from different peers merge harmlessly when read. A late
joiner loads the newest snapshot it can find via member discovery, then syncs
live. When the last peer leaves, the latest snapshot *is* the world's state.

## 5. What crosses the network

| Item | Transport | Rate | Durable |
|---|---|---|---|
| App bundle, scene, models | Swarm (immutable) | once | yes |
| Member discovery, SDP signalling | Swarm feeds (via library) | on join | briefly |
| Avatar pose | WebRTC data (Yjs awareness) | 1–10 Hz | no |
| Object pick-up / put-down | WebRTC data (Yjs doc) | on event | yes, via snapshot feeds |
| Lease refresh | WebRTC data (Yjs doc) | every 5 s while holding | yes |
| Voice | WebRTC audio | continuous | no |
| Document snapshot | Swarm feed (per peer) | periodic (library default) | yes |

## 6. Identity

PoC: an ephemeral secp256k1 keypair generated per session and kept in
`sessionStorage`. The peer id is derived from it. A display name is typed in
at start. Later: `dappdata` / Sign-In with Ethereum for a stable identity
(D-11).

## 7. Coordinate frames

- World: metres, right-handed, Y up, origin and spawn given in `world.json`.
- Vehicle: position on the ground surface, heading about Y.
- Phone: orientation from the sensor, expressed as a quaternion in the world
  frame after applying the recentre reference.
- Audio listener: vehicle pose. Forward = vehicle heading; up = +Y.

## 8. Failure behaviour

- No Bee reachable: the app loads only if served from a gateway; presence
  and objects are disabled and a banner says so.
- Peer drops: avatar disappears after the awareness timeout (30 s); leases
  expire; audio node is released.
- Sensor permission denied: the view is controlled by touch drag as a
  fallback so the app can still be demonstrated on a desktop.

## 9. Known limits (PoC)

- Full-mesh WebRTC limits earshot to about ten peers.
- Head orientation is assumed equal to phone orientation.
- Rooms are axis-aligned boxes with a hard audio cut; no doors, no
  attenuation through walls.
- Yaw drifts slowly between recentres; a recentre is one long press away.
- Screen physical size is estimated; the FOV calibration is a manual slider.
- Awareness has no authentication; anyone who can read the world's feeds can
  join and speak.

## 10. Later (not now)

- Spatial cells for discovery and interest management; earshot as a soft
  limit
- Head pose beyond eye position: gaze, head-relative audio; camera-based
  throttle if D-28 goes that way (eye distance itself is Phase 1c, D-27)
- Casting: phone as controller, TV or tablet as the window
- Terrain and buildings from open data as 3D Tiles on Swarm; regional upgrades
- Rollback reconciliation for objects; physics with input replication
- Stable identity via `dappdata`; friends, mute, block
- Amplifier priority beyond gain (queueing, floor control)
- PSS or GSOC transport once a released Bee supports pubsub
