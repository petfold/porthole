#!/usr/bin/env node
/**
 * Find jumps in the rendered eye direction and explain them from the trace.
 *   node scripts/s8-trace-analyse.mjs [file] [session]
 * A "jump" is a frame where the eye's screen-frame direction moved by more
 * than JUMP_DEG. For each, print what happened around it: new fix (which
 * model, eye, cue, spacing), eye switch, status change, phone rotation
 * rate, gap since the previous fix, and any MARK within ±1 s.
 */
import { readFileSync } from 'node:fs';

const file = process.argv[2] ?? 'spikes/records/s8-trace.jsonl';
const rows = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const sessions = [...new Set(rows.map((r) => r.s))];
const session = process.argv[3] ?? sessions[sessions.length - 1];
const rs = rows.filter((r) => r.s === session);
const frames = rs.filter((r) => r.k === 'f');
const marks = rs.filter((r) => r.k === 'mark').map((m) => m.t);
if (frames.length < 2) { console.log(`session ${session}: ${frames.length} frames, nothing to analyse`); process.exit(0); }
console.log(`session ${session} (${sessions.length} in file) · ${frames.length} frames · ${((frames.at(-1).t - frames[0].t) / 1000).toFixed(0)} s`);

const JUMP_DEG = 1.0;
const deg = (v) => (v * 180) / Math.PI;
const norm = (v) => Math.hypot(...v);
const dir = (e) => { const n = norm(e); return e.map((x) => x / n); };
const angle = (a0, b0) => { const a = dir(a0), b = dir(b0); return deg(Math.acos(Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])))); };
const qAngle = (a, b) => deg(2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]))));

// Frame rate and fix rate.
const dts = frames.map((f) => f.dt).filter((d) => d > 0);
const fixes = frames.filter((f) => f.fix);
const fixGaps = fixes.slice(1).map((f, i) => f.fix.t - fixes[i].fix.t);
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(p * (s.length - 1))]; };
console.log(`render dt: median ${pct(dts, 0.5)} ms, p95 ${pct(dts, 0.95)} ms, max ${Math.max(...dts)} ms`);
console.log(`fixes: ${fixes.length}, gap median ${pct(fixGaps, 0.5).toFixed(0)} ms, p95 ${pct(fixGaps, 0.95).toFixed(0)} ms, max ${Math.max(...fixGaps).toFixed(0)} ms`);
const bySrc = {}; for (const f of fixes) bySrc[f.fix.src] = (bySrc[f.fix.src] ?? 0) + 1;
console.log(`fix sources: ${JSON.stringify(bySrc)} · eye switches: ${fixes.filter((f, i) => i && f.fix.eye !== fixes[i - 1].fix.eye).length}`);

// Raw fix scatter while the phone is still: lateral angle of raw world direction between consecutive fixes.
const rawSteps = fixes.slice(1).map((f, i) => angle(f.fix.dwr, fixes[i].fix.dwr));
console.log(`raw fix direction step: median ${pct(rawSteps, 0.5).toFixed(2)}°, p95 ${pct(rawSteps, 0.95).toFixed(2)}°, max ${Math.max(...rawSteps).toFixed(2)}°`);

// Jumps: frames where the eye estimate moved in the WORLD (not explained by phone rotation) by more
// than JUMP_DEG, or where the range to the eye changed by more than 5 % in one frame.
const jumps = [];
let rotOnly = 0;
for (let i = 1; i < frames.length; i++) {
  const a = frames[i - 1], b = frames[i];
  const screenStep = angle(a.e, b.e);
  const phoneRot = qAngle(a.q, b.q);
  const worldStep = angle(a.dw, b.dw);
  const rangeStep = Math.abs(norm(b.e) / norm(a.e) - 1);
  if (screenStep > JUMP_DEG && worldStep <= 0.3 && rangeStep < 0.05) rotOnly++;
  if (worldStep > 0.3 || rangeStep >= 0.05) jumps.push({ i, t: b.t, screenStep, phoneRot, worldStep, rangeStep, dt: b.dt });
}
console.log(`\nframes with > ${JUMP_DEG}° screen motion explained purely by phone rotation (correct behaviour): ${rotOnly}`);
console.log(`unexplained jumps (world direction > 0.3° or range > 5 % in one frame): ${jumps.length}`);
const lastFixBefore = (i) => { for (let j = i; j >= 0; j--) if (frames[j].fix) return frames[j]; return null; };
for (const j of jumps.slice(0, 40)) {
  const f = frames[j.i];
  const fx = lastFixBefore(j.i), fxPrev = fx ? lastFixBefore(frames.indexOf(fx) - 1) : null;
  const nearMark = marks.find((m) => Math.abs(m - j.t) < 1000);
  const why = [];
  if (f.fix) why.push(`new fix ${f.fix.src}/${f.fix.eye}/${f.fix.cue} ipdc ${f.fix.ipdc} fs ${f.fix.fs}`);
  if (fx && fxPrev && fx.fix.eye !== fxPrev.fix.eye) why.push(`EYE SWITCH ${fxPrev.fix.eye}→${fx.fix.eye}`);
  if (fx && fxPrev && fx.fix.src !== fxPrev.fix.src) why.push(`source ${fxPrev.fix.src}→${fx.fix.src}`);
  if (fx && fxPrev) why.push(`fix gap ${(fx.fix.t - fxPrev.fix.t).toFixed(0)} ms, raw step ${angle(fx.fix.dwr, fxPrev.fix.dwr).toFixed(2)}°`);
  if (f.status) why.push(`status "${f.status}"`);
  if (j.phoneRot > 0.5) why.push(`phone rotated ${j.phoneRot.toFixed(2)}° this frame`);
  if (j.worldStep > 0.3) why.push(`world dir moved ${j.worldStep.toFixed(2)}°`);
  console.log(`  t+${((j.t - frames[0].t) / 1000).toFixed(2)} s: world ${j.worldStep.toFixed(2)}°, range ${(100 * j.rangeStep).toFixed(1)} %, screen ${j.screenStep.toFixed(2)}°${nearMark ? ' ★MARK' : ''} — ${why.join('; ') || 'no event'}`);
}
if (marks.length) {
  console.log('\nmarks and the largest screen-direction step within the preceding 1.5 s:');
  for (const m of marks) {
    let best = { step: 0 };
    for (let i = 1; i < frames.length; i++) {
      if (frames[i].t > m || frames[i].t < m - 1500) continue;
      const step = angle(dir(frames[i - 1].e), dir(frames[i].e));
      if (step > best.step) best = { step, i };
    }
    const f = best.i ? frames[best.i] : null;
    const fx = best.i ? lastFixBefore(best.i) : null;
    console.log(`  mark t+${((m - frames[0].t) / 1000).toFixed(1)} s: max step ${best.step.toFixed(2)}°` + (f ? ` at t+${((f.t - frames[0].t) / 1000).toFixed(2)} s; last fix ${fx?.fix.src}/${fx?.fix.eye}; phone rot ${qAngle(frames[best.i - 1].q, f.q).toFixed(2)}°/frame` : ''));
  }
}
