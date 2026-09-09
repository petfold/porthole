/**
 * Build city geometry from a world manifest: extruded building footprints,
 * flat areas (water, parks) and road ribbons. Everything is merged into a
 * handful of meshes so a phone can draw a thousand buildings in one pass.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { AreaDef, BuildingDef, Palette, RoadDef, Vec2 } from './manifest';

/** Shape coordinates are (x, -z) so that rotateX(-90°) lands them on the ground plane with y up. */
function shapeOf(polygon: Vec2[], holes: Vec2[][] = []): THREE.Shape | null {
  if (polygon.length < 3) return null;
  const shape = new THREE.Shape(polygon.map(([x, z]) => new THREE.Vector2(x, -z)));
  for (const h of holes) if (h.length >= 3) shape.holes.push(new THREE.Path(h.map(([x, z]) => new THREE.Vector2(x, -z))));
  return shape;
}

const ROT = new THREE.Matrix4().makeRotationX(-Math.PI / 2);

function colorAttr(geometry: THREE.BufferGeometry, color: THREE.Color): void {
  const n = geometry.getAttribute('position').count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = color.r; arr[i * 3 + 1] = color.g; arr[i * 3 + 2] = color.b; }
  geometry.setAttribute('color', new THREE.BufferAttribute(arr, 3));
}

/** Paint the caps (roof) and sides (walls) of an extrusion with different colours. */
function paintExtrusion(geometry: THREE.ExtrudeGeometry, wall: THREE.Color, roof: THREE.Color): void {
  const n = geometry.getAttribute('position').count;
  const arr = new Float32Array(n * 3);
  const caps = geometry.groups.find((g) => g.materialIndex === 0);
  const capEnd = caps ? caps.start + caps.count : 0;
  for (let i = 0; i < n; i++) {
    const c = i < capEnd ? roof : wall;
    arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  geometry.clearGroups();
}

export function buildBuildings(buildings: BuildingDef[], palette: Palette): THREE.Mesh | null {
  const walls = palette.wall.map((c) => new THREE.Color(c));
  const roof = new THREE.Color(palette.roof);
  const geoms: THREE.BufferGeometry[] = [];
  buildings.forEach((b, i) => {
    const shape = shapeOf(b.polygon, b.holes);
    if (!shape) return;
    const min = b.minHeight ?? 0;
    const depth = Math.max(0.5, b.height - min);
    let g: THREE.ExtrudeGeometry;
    try {
      g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 4 });
    } catch {
      return; // degenerate footprint
    }
    // Slightly darken the walls with height so tall blocks read as solid.
    const wall = (walls[i % walls.length] as THREE.Color).clone().multiplyScalar(1 - Math.min(0.12, b.height / 400));
    paintExtrusion(g, wall, roof);
    g.applyMatrix4(ROT);
    if (min) g.translate(0, min, 0);
    geoms.push(g);
  });
  if (!geoms.length) return null;
  const merged = mergeGeometries(geoms, false);
  for (const g of geoms) g.dispose();
  if (!merged) return null;
  merged.computeVertexNormals();
  const mesh = new THREE.Mesh(merged, new THREE.MeshLambertMaterial({ vertexColors: true }));
  mesh.name = 'buildings';
  return mesh;
}

export function buildAreas(areas: AreaDef[], palette: Palette): THREE.Mesh | null {
  const geoms: THREE.BufferGeometry[] = [];
  const colors = { water: new THREE.Color(palette.water), park: new THREE.Color(palette.park) };
  const heights = { water: 0.02, park: 0.03 };
  for (const a of areas) {
    const shape = shapeOf(a.polygon, a.holes);
    if (!shape) continue;
    let g: THREE.ShapeGeometry;
    try { g = new THREE.ShapeGeometry(shape, 4); } catch { continue; }
    colorAttr(g, colors[a.kind]);
    g.applyMatrix4(ROT);
    g.translate(0, heights[a.kind], 0);
    geoms.push(g);
  }
  if (!geoms.length) return null;
  const merged = mergeGeometries(geoms, false);
  for (const g of geoms) g.dispose();
  if (!merged) return null;
  const mesh = new THREE.Mesh(merged, new THREE.MeshLambertMaterial({ vertexColors: true }));
  mesh.name = 'areas';
  return mesh;
}

/** Ribbons: one quad per segment, plus a small disc at joints to hide gaps. */
export function buildRoads(roads: RoadDef[], palette: Palette): THREE.Mesh | null {
  const colors = { road: new THREE.Color(palette.road), path: new THREE.Color(palette.path), rail: new THREE.Color(palette.rail) };
  const heights = { road: 0.05, path: 0.06, rail: 0.07 };
  const positions: number[] = [];
  const cols: number[] = [];
  const push = (x: number, y: number, z: number, c: THREE.Color) => { positions.push(x, y, z); cols.push(c.r, c.g, c.b); };
  for (const r of roads) {
    const c = colors[r.kind];
    const y = heights[r.kind];
    const hw = r.width / 2;
    for (let i = 0; i + 1 < r.path.length; i++) {
      const [ax, az] = r.path[i] as Vec2;
      const [bx, bz] = r.path[i + 1] as Vec2;
      const dx = bx - ax, dz = bz - az;
      const len = Math.hypot(dx, dz);
      if (len < 0.01) continue;
      const nx = (-dz / len) * hw, nz = (dx / len) * hw;
      // Two triangles, counterclockwise seen from above (+Y).
      push(ax + nx, y, az + nz, c); push(bx + nx, y, bz + nz, c); push(bx - nx, y, bz - nz, c);
      push(ax + nx, y, az + nz, c); push(bx - nx, y, bz - nz, c); push(ax - nx, y, az - nz, c);
      // Joint fan at b (octagon).
      if (i + 2 < r.path.length) {
        for (let k = 0; k < 8; k++) {
          const t0 = (k / 8) * Math.PI * 2, t1 = ((k + 1) / 8) * Math.PI * 2;
          push(bx, y, bz, c); push(bx + Math.cos(t1) * hw, y, bz + Math.sin(t1) * hw, c); push(bx + Math.cos(t0) * hw, y, bz + Math.sin(t0) * hw, c);
        }
      }
    }
  }
  if (!positions.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  const normals = new Float32Array(positions.length);
  for (let i = 1; i < normals.length; i += 3) normals[i] = 1;
  g.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  const mesh = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true }));
  mesh.name = 'roads';
  return mesh;
}
