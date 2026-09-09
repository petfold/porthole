# porthole

A phone as a window onto a shared 3D world on Swarm.

Hold the phone up and turn it: you look around. Push it away from you: you
ride forward on a vehicle. Turn it: you steer. Other people in the world are
heard through your headphones from where they stand — close voices loud,
distant voices faint, an amplified speaker audible from anywhere. Pick up an
object and put it down somewhere else; everyone sees the same result.

There is no server. The world, the app, and the durable state live on Swarm.
Presence, voice, and object moves run peer-to-peer over WebRTC, with the
phones finding each other through Swarm feeds.

**Status:** design only. Proof of concept in planning. See `docs/`.

## Layout

- `CLAUDE.md` — entry point for Claude Code
- `docs/design.md` — architecture
- `docs/plan.md` — phases
- `docs/spikes.md` — Phase 0 experiments
- `docs/decisions.md` — decision log
- `docs/references.md` — libraries and prior work

## Related

- [swarm-collaborative-docs](https://github.com/Solar-Punk-Ltd/swarm-collaborative-docs) — the sync layer porthole builds on

## Licence

To be decided (see `docs/decisions.md` D-15).
