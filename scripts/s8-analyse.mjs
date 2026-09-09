#!/usr/bin/env node
/**
 * Summarise S8 calibration records (spikes/records/s8-calibration.jsonl):
 * per distance, the size cues and the focal length each implies; then a
 * cross-check of how well a focal length fitted at one distance predicts
 * the others. Run: node scripts/s8-analyse.mjs [file]
 */
import { readFileSync } from 'node:fs';

const file = process.argv[2] ?? 'spikes/records/s8-calibration.jsonl';
const rows = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const IRIS = 1.17, IPD = 6.3; // cm
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = (xs) => Math.sqrt(mean(xs.map((x) => (x - mean(xs)) ** 2)));
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

const sessions = [...new Set(rows.map((r) => r.session))];
for (const session of sessions) {
  const rs = rows.filter((r) => r.session === session);
  console.log(`\n== session ${session} · ${rs.length} records · ${rs[0].t.slice(0, 16)} · ${rs[0].capture.w}×${rs[0].capture.h} · ${rs[0].delegate} ${mean(rs.map((r) => r.inferenceMs)).toFixed(0)} ms` +
    (rs[0].delegateMs ? ` · timing GPU ${rs[0].delegateMs.GPU?.toFixed(0) ?? '?'} CPU ${rs[0].delegateMs.CPU?.toFixed(0) ?? '?'}` : ''));
  const by = new Map();
  for (const r of rs) by.set(r.trueDistanceCm, [...(by.get(r.trueDistanceCm) ?? []), r]);
  const dists = [...by.keys()].sort((a, b) => b - a);
  console.log(`${'cm'.padStart(5)} ${'n'.padStart(2)} ${'iris px'.padStart(9)} ${'ipd px'.padStart(9)} ${'ipdCorr'.padStart(9)} ${'head°'.padStart(6)} ${'f_iris'.padStart(7)} ${'f_ipd'.padStart(7)} ${'f_ipdC'.padStart(7)}`);
  for (const d of dists) {
    const g = by.get(d);
    const iris = g.map((r) => r.irisMedianPx), ipd = g.map((r) => r.ipdPx), ipdc = g.map((r) => r.ipdCorrMedianPx ?? r.ipdPx);
    const head = g.map((r) => (r.foreshorten ? Math.acos(Math.min(1, r.foreshorten)) * 180 / Math.PI : NaN));
    console.log(`${String(d).padStart(5)} ${String(g.length).padStart(2)} ${(mean(iris).toFixed(1) + '±' + sd(iris).toFixed(1)).padStart(9)} ${(mean(ipd).toFixed(1) + '±' + sd(ipd).toFixed(1)).padStart(9)} ${(mean(ipdc).toFixed(1) + '±' + sd(ipdc).toFixed(1)).padStart(9)} ${(isNaN(head[0]) ? '—' : mean(head).toFixed(0)).padStart(6)} ${(median(iris) * d / IRIS).toFixed(0).padStart(7)} ${(median(ipd) * d / IPD).toFixed(0).padStart(7)} ${(median(ipdc) * d / IPD).toFixed(0).padStart(7)}`);
  }
  if (dists.length > 1) {
    console.log('cross-check: focal fitted at each distance, distances it predicts elsewhere (cm)');
    for (const cue of ['iris', 'ipdCorr']) {
      const size = (r) => (cue === 'iris' ? r.irisMedianPx : (r.ipdCorrMedianPx ?? r.ipdPx));
      const mm = cue === 'iris' ? IRIS : IPD;
      for (const d0 of dists) {
        const f = median(by.get(d0).map((r) => size(r))) * d0 / mm;
        const preds = dists.filter((d) => d !== d0).map((d) => `${d}→${mean(by.get(d).map((r) => f * mm / size(r))).toFixed(1)}`);
        console.log(`  ${cue.padEnd(8)} f@${d0} = ${f.toFixed(0)} px: ${preds.join('  ')}`);
      }
    }
  }
}
