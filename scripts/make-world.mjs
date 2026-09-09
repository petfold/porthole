#!/usr/bin/env node
/**
 * Build a city-fragment world from OpenStreetMap via the Overpass API and
 * write it as a static world.json. Runs once, offline from the app's point
 * of view: the phone never talks to Overpass (D-02).
 *
 *   node scripts/make-world.mjs paris-eiffel
 *
 * Data © OpenStreetMap contributors, ODbL — the attribution is written into
 * the manifest and shown on the start screen.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const WORLDS = {
  'paris-eiffel': {
    name: 'Paris — Champ de Mars',
    // Origin: centre of the Eiffel Tower. x = east, z = south (three.js -Z is north).
    origin: { lat: 48.85837, lon: 2.29448 },
    // Roughly 1.1 km square around the tower: Champ de Mars, the Seine, edge of Trocadéro.
    bbox: { south: 48.8535, west: 2.2870, north: 48.8635, east: 2.3020 },
    // On the Champ de Mars axis, 300 m south-east of the tower, looking back at it.
    spawn: { position: [212, 0, 212], heading: 45 },
    landmarks: [{ type: 'eiffel', position: [0, 0, 0], yaw: 45 }],
    // The tower is in OSM as a 330 m "building"; the procedural landmark replaces it.
    excludeBuildings: [5013364],
    defaultHeight: 19, // Haussmann-era Paris: about six storeys
  },
};

const key = process.argv[2] ?? 'paris-eiffel';
const cfg = WORLDS[key];
if (!cfg) { console.error(`unknown world ${key}; known: ${Object.keys(WORLDS).join(', ')}`); process.exit(2); }

const b = cfg.bbox;
const bboxStr = `${b.south},${b.west},${b.north},${b.east}`;
const query = `[out:json][timeout:90];
(
  way["building"](${bboxStr});
  relation["building"]["type"="multipolygon"](${bboxStr});
  way["highway"~"^(primary|secondary|tertiary|residential|unclassified|living_street|pedestrian|footway|service|trunk)$"](${bboxStr});
  way["natural"="water"](${bboxStr});
  relation["natural"="water"]["type"="multipolygon"](${bboxStr});
  way["waterway"="riverbank"](${bboxStr});
  way["leisure"~"^(park|garden)$"](${bboxStr});
  way["landuse"~"^(grass|recreation_ground)$"](${bboxStr});
  relation["leisure"~"^(park|garden)$"]["type"="multipolygon"](${bboxStr});
  way["railway"="rail"](${bboxStr});
);
out body; >; out skel qt;`;

console.error('Querying Overpass…');
const endpoint = process.env.OVERPASS_URL ?? 'https://overpass-api.de/api/interpreter';
const res = await fetch(endpoint, {
  method: 'POST',
  headers: {
    'User-Agent': 'porthole-make-world/0.1 (+https://github.com/petfold/porthole)',
    Accept: 'application/json',
    'Content-Type': 'application/x-www-form-urlencoded',
  },
  body: 'data=' + encodeURIComponent(query),
});
if (!res.ok) { console.error(`Overpass ${res.status}: ${await res.text()}`); process.exit(1); }
const osm = await res.json();
console.error(`${osm.elements.length} elements`);

// --- projection ---------------------------------------------------------
const R = 6378137;
const lat0 = (cfg.origin.lat * Math.PI) / 180;
const project = (lat, lon) => {
  const x = ((lon - cfg.origin.lon) * Math.PI / 180) * R * Math.cos(lat0);
  const north = ((lat - cfg.origin.lat) * Math.PI / 180) * R;
  return [round(x), round(-north)];
};
const round = (v) => Math.round(v * 10) / 10;

const nodes = new Map();
const ways = new Map();
const rels = [];
for (const e of osm.elements) {
  if (e.type === 'node') nodes.set(e.id, project(e.lat, e.lon));
  else if (e.type === 'way') ways.set(e.id, e);
  else if (e.type === 'relation') rels.push(e);
}
const wayCoords = (w) => w.nodes.map((id) => nodes.get(id)).filter(Boolean);

// Join open ways of a multipolygon role into closed rings by matching endpoints.
function assembleRings(members) {
  const segs = members.map((m) => ways.get(m.ref)).filter(Boolean).map(wayCoords).filter((c) => c.length > 1);
  const rings = [];
  while (segs.length) {
    let ring = segs.shift();
    let closed = false;
    for (let guard = 0; guard < 500 && !closed; guard++) {
      const [hx, hz] = ring[0];
      const [tx, tz] = ring[ring.length - 1];
      if (Math.hypot(hx - tx, hz - tz) < 0.5) { closed = true; break; }
      const i = segs.findIndex((s) => near(s[0], [tx, tz]) || near(s[s.length - 1], [tx, tz]));
      if (i < 0) break;
      let s = segs.splice(i, 1)[0];
      if (!near(s[0], [tx, tz])) s = s.slice().reverse();
      ring = ring.concat(s.slice(1));
    }
    if (ring.length >= 4) rings.push(ring);
  }
  return rings;
}
const near = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.5;

const dedupeClosed = (c) => (c.length > 1 && near(c[0], c[c.length - 1]) ? c.slice(0, -1) : c);

function parseHeight(tags) {
  const h = tags.height ?? tags['building:height'];
  if (h) { const m = parseFloat(String(h).replace(',', '.')); if (isFinite(m) && m > 0) return m; }
  const lv = parseFloat(tags['building:levels']);
  if (isFinite(lv) && lv > 0) return lv * 3.1 + (tags['roof:levels'] ? 3 : 1.5);
  if (tags.building === 'roof' || tags.building === 'shed' || tags.building === 'kiosk') return 3.5;
  return cfg.defaultHeight;
}

const excluded = new Set(cfg.excludeBuildings ?? []);
const buildings = [];
const areas = [];
const roads = [];
const rails = [];

function areaKind(tags) {
  if (tags.natural === 'water' || tags.waterway === 'riverbank') return 'water';
  if (tags.leisure === 'park' || tags.leisure === 'garden' || tags.landuse === 'grass' || tags.landuse === 'recreation_ground') return 'park';
  return null;
}

const usedInRelation = new Set();
for (const r of rels) {
  for (const m of r.members) if (m.type === 'way') usedInRelation.add(m.ref);
}

for (const r of rels) {
  const tags = r.tags ?? {};
  const outers = assembleRings(r.members.filter((m) => m.type === 'way' && (m.role === 'outer' || m.role === '')));
  const inners = assembleRings(r.members.filter((m) => m.type === 'way' && m.role === 'inner'));
  if (!outers.length) continue;
  if (tags.building) {
    if (excluded.has(r.id)) continue;
    const height = parseHeight(tags);
    for (const o of outers) buildings.push({ polygon: dedupeClosed(o), holes: inners.map(dedupeClosed), height, minHeight: parseFloat(tags.min_height) || 0 });
  } else {
    const kind = areaKind(tags);
    if (kind) for (const o of outers) areas.push({ kind, polygon: dedupeClosed(o), holes: inners.map(dedupeClosed) });
  }
}

for (const w of ways.values()) {
  const tags = w.tags ?? {};
  const coords = wayCoords(w);
  if (coords.length < 2) continue;
  const closed = near(coords[0], coords[coords.length - 1]);
  if (tags.building) {
    if (excluded.has(w.id) || usedInRelation.has(w.id) || !closed || coords.length < 4) continue;
    buildings.push({ polygon: dedupeClosed(coords), height: parseHeight(tags), minHeight: parseFloat(tags.min_height) || 0 });
  } else if (tags.highway) {
    const wide = /^(primary|trunk)$/.test(tags.highway) ? 16 : /^(secondary)$/.test(tags.highway) ? 12
      : /^(tertiary|residential|unclassified)$/.test(tags.highway) ? 8 : tags.highway === 'pedestrian' ? 6 : tags.highway === 'service' ? 4 : 2.5;
    roads.push({ width: wide, path: coords, kind: /^(footway|pedestrian)$/.test(tags.highway) ? 'path' : 'road' });
  } else if (tags.railway === 'rail') {
    rails.push({ width: 3, path: coords, kind: 'rail' });
  } else if (closed && !usedInRelation.has(w.id)) {
    const kind = areaKind(tags);
    if (kind) areas.push({ kind, polygon: dedupeClosed(coords) });
  }
}

// Clip nothing; just drop buildings entirely outside the ground square.
const half = 620;
const inside = (poly) => poly.some(([x, z]) => Math.abs(x) <= half && Math.abs(z) <= half);
const keptBuildings = buildings.filter((b) => inside(b.polygon));

const world = {
  name: cfg.name,
  attribution: 'Map data © OpenStreetMap contributors (ODbL). Tower model procedural.',
  origin: cfg.origin,
  frame: { units: 'metres', up: 'Y' },
  spawn: cfg.spawn,
  eyeHeight: 1.6,
  ground: { size: half * 2, color: '#cfc7b8', grid: false },
  sky: { color: '#bfd6ea', fog: 1400 },
  palette: {
    wall: ['#e3d9c6', '#dbcfba', '#e8dfcc', '#d6c9b2', '#e0d4bf'],
    roof: '#8d97a3',
    road: '#6a6e76',
    path: '#b9b0a0',
    rail: '#7a6f66',
    water: '#6d9fc4',
    park: '#8fb47a',
    tower: '#7a5f4b',
  },
  primitives: [],
  areas,
  roads: [...roads, ...rails],
  buildings: keptBuildings,
  landmarks: cfg.landmarks,
  objects: [],
  rooms: [],
};

const dir = resolve('public/worlds', key);
mkdirSync(dir, { recursive: true });
const out = resolve(dir, 'world.json');
writeFileSync(out, JSON.stringify(world));
console.error(`${keptBuildings.length} buildings, ${areas.length} areas, ${roads.length} roads, ${rails.length} rails → ${out} (${(Buffer.byteLength(JSON.stringify(world)) / 1024).toFixed(0)} kB)`);
