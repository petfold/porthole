# porthole — Phase 0 spikes

Each spike is a small throwaway experiment under `spikes/<id>/`. Record the
result in the slot. A failed spike changes the design; say what changed.

Priority order: S1, S2, S4 first — the design depends on them. S3, S5, S6,
S7 can run in parallel.

---

## S1 — Sensor APIs in Vanadium on GrapheneOS

Question: which orientation and motion APIs work, at what rate, with what
permission prompts, in Vanadium?

Try: `deviceorientation` (relative and `absolute`), `devicemotion`,
`RelativeOrientationSensor`, `AbsoluteOrientationSensor`, `Accelerometer`,
`LinearAccelerationSensor`, `Gyroscope`. Log sample rate, latency to screen
(estimate by filming), and drift of yaw over five minutes at rest. Check
whether GrapheneOS's sensor permission toggle changes anything.

Exit: a table of API × availability × rate × permission behaviour, and a
chosen orientation source and motion source.

Result: _pending_

---

## S2 — swarm-collaborative-docs: awareness and audio tracks

Question: does the library (a) sync Yjs awareness, not just the document,
over its WebRTC transport, and (b) expose the `RTCPeerConnection` (or a
hook) so an audio track can be added to the same connection?

Try: two browser tabs sharing a document through the library's Swarm-feed
signalling; set awareness state in one, observe in the other; then attempt
`pc.addTrack(...)` from the exposed connection. If neither hook exists,
prototype a second connection for audio that reuses the library's signalling
feed topic with a `-audio` suffix.

Also measure: time from tab open to first data-channel message, using a local
Bee light node. Note the Bee version.

Exit: awareness round-trips; audio track plays across tabs; join latency
recorded. Or: a documented fallback design for audio.

Result: _pending_

---

## S3 — HRTF panning cost on a phone

Question: can Web Audio run ten `PannerNode`s in HRTF mode with moving
positions at 60 fps render on a Pixel-class phone without glitches?

Try: ten looping test tones on ten panners orbiting the listener; three.js
scene rendering at the same time. Measure audio dropouts (`AudioContext`
`baseLatency`/`outputLatency`, listen for clicks) and frame rate.

Exit: ten HRTF panners with no audible glitching, or a lower ceiling recorded
and `MAX_PEERS` adjusted.

Result: _pending_

---

## S4 — Serving the bundle from Swarm as a secure context

Question: do `getUserMedia`, sensor APIs, and WebRTC all work when the bundle
is loaded from (a) `http://localhost:1633/bzz/<ref>/` and (b) an `https://`
gateway?

Try: a minimal page that requests the microphone, subscribes to
`deviceorientation`, and opens a data channel to itself, uploaded as a Swarm
collection with an `index.html` default. Check MIME types served for `.js`,
`.glb`, `.wasm`.

Exit: all three APIs work from both origins, or the working origin is
recorded and the other marked unsupported.

Result: _pending_

---

## S5 — Holder register and lease under contention

Question: does a `Y.Map` with `holder` and `leaseUntil` converge as described
in `design.md` §4.6 when two peers grab concurrently, and does lease expiry
free the object when one peer disappears?

Try: two tabs, artificial 500 ms delay on the transport, both grab within
the delay window. Then: one tab closed mid-hold.

Exit: both tabs agree on `holder` after sync; the object frees after the
lease; the sequence of observed states is written down.

Result: _pending_

---

## S6 — Push/pull throttle gesture

Question: does integrating the first half of a `devicemotion` push along the
screen normal give a repeatable impulse, and does the mapping to vehicle
speed feel right?

Try: log acceleration along the device Z axis for ten deliberate pushes and
ten pulls; compute the impulse to the first sign flip; check the spread.
Then wire it to a speed value shown on screen and try it for two minutes.

Exit: push and pull are distinguished 20 of 20 times; impulse spread within
±30 %; a first-guess gain and clamp recorded.

Result: _pending_

---

## S7 — FOV from screen size

Question: how far off is the estimated screen physical size from
`devicePixelRatio` and `screen.width/height` on two or three phones, and does
a "match this ruler" calibration take under ten seconds?

Try: compute estimated width; measure real width; compute the error in
rendered FOV at a 40 cm viewing distance. Build the slider.

Exit: error table; slider works; decision on whether to ship the estimate
alone or always ask for calibration.

Result: _pending_
