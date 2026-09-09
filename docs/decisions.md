# porthole — decisions

Status values: DECIDED, PROPOSED (Claude's suggestion, awaiting Peter),
OPEN (needs Peter). Append new lines; do not rewrite old ones. To reverse a
decision, add a new one that supersedes it.

| Id | Decision | Status | Notes |
|---|---|---|---|
| D-01 | Project name `porthole`. Repo `porthole`. | DECIDED 2026-09-09 | Free under `petfold` and `Solar-Punk-Ltd` on GitHub. The unscoped npm name is taken by an unrelated package; not needed for an app. Second choice was `periscope`. |
| D-02 | No server, ever. Swarm plus peer-to-peer WebRTC only. | DECIDED | Same rule as `swarm-collaborative-docs` and `galley`. |
| D-03 | Build presence and object sync on `swarm-collaborative-docs`; do not write a new sync layer. | DECIDED | Spike S2 checks awareness and audio-track support. If the library lacks a hook, add it upstream rather than fork. |
| D-04 | three.js for rendering; TypeScript; Vite. | PROPOSED | Babylon.js is the alternative; three.js has the larger ecosystem for glTF and later 3D Tiles (`3d-tiles-renderer`). |
| D-05 | Strict geometry. Rendered FOV equals the screen's true angular size at an assumed 40 cm. No FOV widening, no rotation gain. Recentre and window-height offset are allowed as rigid transforms. | DECIDED | Reason: audio and vision must agree, and the vestibular system is calibrated. Discussion 2026-09-09. |
| D-06 | Audio: WebRTC Opus tracks; Web Audio `PannerNode` HRTF; inverse distance model with `rolloffFactor: 2`; amplified peers `rolloffFactor: 0.5`, gain 1.5×. | PROPOSED | Steeper-than-physics rolloff so stepping away gives privacy. Numbers to tune in Phase 2. |
| D-07 | Avatars via Yjs awareness (ephemeral); objects via the Yjs document (durable). | DECIDED | Awareness is never written to Swarm. |
| D-08 | Earshot = nearest `MAX_PEERS` (default 10) by world distance, plus all amplified peers. Recompute every 2 s with hysteresis. | DECIDED | Simple first. Spatial cells later. |
| D-09 | Object ownership: `holder` LWW register plus `leaseUntil` (default 10 s, refreshed at 5 s). Optimistic grab with visible correction on loss. No rollback netcode. | DECIDED | Matches the July 2026 CRDT discussion: move LWW from "where" to "who holds", add leases. |
| D-10 | Controls: yaw steers and looks (handlebars); push adds speed, pull subtracts; touch brakes; long press recentres. Ground-following; flight off. | PROPOSED | Alternative kept for later: roll steers, yaw looks freely. Decide after Phase 1 feel test. |
| D-11 | Identity: ephemeral per-session keypair and typed display name. | DECIDED for PoC | Later: `dappdata` / SIWE. |
| D-12 | World content: one hand-built glTF scene with a flat ground and a few landmarks, plus two or three movable objects. | DECIDED for PoC | Open-data terrain and 3D Tiles are later work (see design §10). |
| D-13 | Out of scope for the PoC: abuse controls, face tracking, casting, physics, more than about ten peers. | DECIDED 2026-09-09 | Peter: "let's not worry about abuse at this stage at all". |
| D-14 | Amplifier is a self-set flag on the avatar with no authorisation. | DECIDED for PoC | Priority beyond gain (floor control) is later work. |
| D-15 | Licence. | OPEN | Peter to choose. Suggest matching `swarm-collaborative-docs`. |
| D-16 | Repository home: `Solar-Punk-Ltd/porthole` or `petfold/porthole`. | OPEN | Both names are free. |
| D-17 | STUN server for WebRTC. | OPEN | Same question as `galley` D-15; reuse whatever `swarm-collaborative-docs` defaults to. |
| D-18 | Microphone open by default (no push-to-talk) in the demo. | PROPOSED | Simplest for a two-person conversation. Add push-to-talk if echo or noise is a problem. |
