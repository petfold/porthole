# porthole — Phase 0 spikes

Each spike is a small throwaway experiment under `spikes/<id>/`. Record the
result in the slot. A failed spike changes the design; say what changed.

Priority order: S1, S2, S4 first — the design depends on them. S3, S5, S6,
S7 can run in parallel.

S1, S6 and S7 are run from inside the app (D-21): open the app with `?panel`
(or tap the gear) and the panel shows API availability, rates, throttle
impulses with their spread, and the FOV calibration. Copy the numbers into
the result slots below.

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

---

## S8 — Eye distance from the front camera

Question: can the phone measure the distance from the screen to the user's
eye well enough to drive the window geometry, down to the closest distance
at which the eye can still focus on the screen (about 10 cm), including when
only part of the face is in view?

Method (D-27):

- Iris diameter is the primary cue: 11.7 mm ± 0.5 across adults (visible
  diameter, as seen through the cornea). With a focal length `f` in pixels
  and a measured iris diameter `p` in pixels, distance `d = f × 11.7 mm / p`.
  One visible iris is enough. The distance is to the entrance pupil (about
  3 mm behind the cornea), which is also the eye's centre of perspective, so
  the measured point is the viewpoint with no offset correction.
- Interpupillary distance (about 63 mm, ±4 mm) is the cross-check when both
  eyes are visible.
- `f` is not exposed by browsers. Calibrate once: hold the phone at a known
  distance (arm's length against the on-screen ruler, or the 40 cm default
  pose) and store `f = p × d / 11.7`.
- Landmarks from MediaPipe Face Landmarker (WASM, iris refinement on),
  running at 5–10 inferences per second from a `getUserMedia` stream
  requested at low resolution (640×480) and low `frameRate`. Between fixes,
  the displacement integrator in `src/sensing/motion.ts` propagates the
  distance along the screen normal; each fix resets its drift.

Try, on the Pixel 7a in Vanadium:

1. Log iris pixel diameter and reported distance at 40, 30, 20, 15, 10 and
   7 cm (ruler on the table, phone on a stand, eye at the marks).
2. At each distance note whether the face detector still fires when the
   frame shows: full face; eyes and nose only; one eye only.
3. Measure end-to-end latency (film the phone and a stopwatch, or step the
   phone between two marks and count frames until the value settles) at
   10 fps and 30 fps inference.
4. Measure the frame rate of the three.js render while inference runs.
5. Run five minutes and read the battery drain and thermal state.
6. Viewpoint eye (D-29): at 40, 20 and 10 cm, look through the window with
   the left eye, then the right, and check that the chosen eye follows
   without flicker; note how often it flips while looking straight at the
   screen with both eyes open.

Exit: distance error under 10 % from 40 cm down to 10 cm; the estimator
keeps working with one eye in frame; render stays at 60 fps with 10 fps
inference; latency of the camera path recorded (the inertial bridge hides
it). Or: the closest reliable distance is recorded and the window is
clamped there.

Result (session 1, 2026-09-09, Pixel 7a, Vanadium/Chromium 152, capture
480×640, GPU delegate on the main thread; `?calibrate` screen, five taps per
distance with an A4 sheet; analysis `node scripts/s8-analyse.mjs`):

| true cm | iris px | pupil spacing px | f from iris | f from spacing |
|---|---|---|---|---|
| 29.7 | 22.4 ± 0.4 | 107.7 ± 1.2 | 567 | 505 |
| 21.0 | 26.7 ± 0.9 | 140.3 ± 2.1 | 479 | 468 |

- **Inference 245 ms per frame** on the GPU delegate, i.e. 4 fixes/s and a
  blocked render loop. Inference moved to a worker; delegate now chosen by
  timing GPU and CPU on the device (D-30 amended).
- **Iris cue compresses**: from 29.7 to 21 cm the iris grew 19 %, geometry
  says 41 %. A focal length fitted at 29.7 cm predicts 24.9 cm at 21 cm
  (+19 %). Pupil spacing grew 30 % (predicts 22.7 cm, +8 %) and its noise
  was half. The chosen eye flipped to the left at 21 cm and the two irises
  differed by 13 %, consistent with the head turned about 20° towards the
  phone, which shrinks the spacing cue but not the iris cue — so part of the
  spacing error is head turn and part of the iris error is the model.
- Decision: pupil spacing corrected for head turn (from the model's pose
  matrix) is the primary cue; the iris cue is rescaled against it whenever
  both eyes are in frame and carries on alone otherwise. Default focal
  length for this phone 0.76 × longest capture side (486 px at 640).
- Session 2 planned: three distances (21.0, 29.7, A4 diagonal 36.4), head
  square to the camera, worker inference; verify the spacing cue within
  10 % and record GPU vs CPU timing.

Session 2 (2026-09-09, same phone, worker inference, head held square,
three distances × 5 and a head-pose block at 29.7 cm × 3):

| true cm | iris px | pupil spacing, corrected px | f from iris | f from spacing |
|---|---|---|---|---|
| 36.4 | 16.0 ± 0.6 | 84.8 ± 0.7 | 497 | 492 |
| 29.7 | 20.8 ± 0.2 | 105.4 ± 1.3 | 526 | 499 |
| 21.0 | 28.7 ± 1.1 | 142.8 ± 3.1 | 516 | 480 |

- With the head square **both cues hold within about 5 %** over 21–36 cm:
  a focal length fitted at 29.7 cm predicts 37.1 and 22.0 cm (spacing) or
  38.4 and 21.5 cm (iris). Session 1's iris failure did not reproduce; it
  was most likely gaze or head pose, see below. Default focal length set to
  0.77 × longest capture side (492 px at 640); the two cues give the same
  focal length, so Peter's iris-to-pupil-spacing ratio matches the
  population constants.
- **Head pose block** (all at 29.7 cm; a good cue stays constant):

  | pose | iris px | spacing raw | spacing corrected | model yaw / pitch |
  |---|---|---|---|---|
  | square | 20.3 | 103.3 | 103.2 | −1° / −15° |
  | left | 18.8 (−7 %) | 97.6 (−6 %) | 104.7 (+1 %) | −22° / −21° |
  | right | 18.8 (−7 %) | 88.5 (−14 %) | 97.7 (−5 %) | +25° / −22° |
  | chin up, eyes down | 16.7 (−18 %) | 94.2 (−9 %) | 95.3 (−8 %) | +4° / −41° |
  | chin down, eyes up | 21.9 (+8 %) | 110.7 (+7 %) | 110.4 (+7 %) | +4° / −10° |

  - The model reports −15° pitch for a square head: that is the real
    viewing angle of a camera 7 cm above the eyes at 30 cm (13.6°), so the
    pose output is geometric, not an artefact.
  - Yaw: the head-turn correction fixes the spacing cue for a left turn
    (+1 %) and under-corrects a right turn (−5 %); the raw iris drops 7 %
    either way. Spacing corrected stays the better cue under yaw (D-31
    confirmed).
  - Pitch: with the chin up and the **eyes looking down** the iris reading
    collapses by 18 % while spacing moves 9 %; chin down moves both by
    +7 %. Both cues moving together means the eye really moved (the head
    pivots about the neck, so the sheet's end at the cheek no longer
    measures the eye). The extra iris drop is eyelid occlusion under
    downward gaze, which the landmark model reports as a smaller iris.
    Consequence: the iris cue is unreliable when the user looks down at a
    phone held low, exactly the common case, so it must stay secondary.
- **Inference time is the open problem.** Session 1: 245 ms on the GPU
  delegate, main thread. Session 2 in the worker: GPU 549 ms, CPU 1251 ms.
  Two to four fixes per second. Suspects: Vanadium's per-site JavaScript
  JIT being off by default (the MediaPipe glue and XNNPACK paths are
  JavaScript-heavy), thermal throttling after a long session, or the
  worker's WebGL context not being hardware accelerated. Next: retest with
  JIT allowed for the site; if still slow, switch the spacing cue to the
  BlazeFace detector (six keypoints incl. both eye centres, about a
  millisecond) and keep the landmarker only for the iris fallback.

Session 3 (2026-09-09, JIT allowed for the site in Vanadium, detector +
landmarker workers, D-32; sheet end at the outer corner of the left eye):

- **Speed with JIT**: detector 18–26 ms at 24–29 fixes/s; landmarker 57–77 ms
  on the CPU (GPU 211 ms), running 3–4/s under its 25 % duty limit. The JIT
  was the cause of the 250–1250 ms times; the app now has a fix on nearly
  every camera frame.
- **Detector spacing is steadier than the landmarker's**: 79.3 ± 0.4,
  99.3 ± 0.3, 131.7 ± 1.1 px at 36.4, 29.7, 21.0 cm (sd 0.3–0.8 %), against
  1–3 % for the landmarker's pupil centres in session 2.
- **The two models measure different points**: detector keypoint spacing is
  1.07–1.09× smaller than the landmarker's pupil spacing. The estimator now
  learns this ratio online whenever both report within 400 ms (start 1.075).
- **Geometry**: a plain inverse law fits the three distances to 3.4 %
  (detector) / 2.1 % (landmarker); allowing for the camera 7.2 cm above the
  point the sheet touched, or equivalently a +2–3 cm offset, brings both to
  under 2 %. The app keeps the plain law with f = 0.77 × longest side and
  the 1.075 detector scale, giving 36.4 → 36.4, 29.7 → 29.1, 21.0 → 21.9 cm.
  S8's 10 % target is met over 21–36 cm.
- **Pose block is confounded** here: with the sheet pinned at the left
  eye's outer corner, turning the head moves the right eye and so the eye
  midpoint (Peter's observation). Corrected spacing moved −10 %/+8 % for
  right/left turns, plausibly a real midpoint depth change of 1–2 cm
  amplified by the pivot being the neck, not the eye. Not usable to
  validate the correction; repeat with the sheet at the nose bridge if it
  matters. Chin up/down changed the corrected spacing by −5 %/+1 %, iris by
  −10 %/0 %: the iris cue again suffers under downward gaze.

Not yet measured: latency, one-eye tracking at close range (the detector
needs most of the face in frame, so below about 15 cm the estimate will
hold its last value), render fps with both workers running.
