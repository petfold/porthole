/**
 * Procedural Eiffel Tower. OpenStreetMap only has its footprint, so the
 * silhouette is built from the published dimensions: 125 m square base,
 * platforms at 57 m, 116 m and 276 m, 300 m to the top of the structure,
 * 330 m with the antenna. Four legs follow the real profile (an exponential
 * taper) as chains of tapering cylinders, braced with cross members and the
 * arches under the first platform. Not a lattice, but unmistakable.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/** Half-width of the tower (centre to leg centre) at height h, metres. */
export function halfWidth(h: number): number {
  // Fit through: 0 → 55 (leg centres), 57 → 33, 116 → 19, 276 → 5, 300 → 3.5
  if (h <= 57) return 55 - (22 * h) / 57;
  if (h <= 116) return 33 - (14 * (h - 57)) / 59;
  if (h <= 276) return 19 * Math.exp(-Math.log(19 / 5) * ((h - 116) / 160));
  return 5 - (1.5 * (h - 276)) / 24;
}

/** Leg thickness (cylinder radius) at height h. */
function legRadius(h: number): number {
  if (h <= 57) return 5 - (2 * h) / 57;
  if (h <= 116) return 3 - (1.2 * (h - 57)) / 59;
  return Math.max(0.9, 1.8 - (0.9 * (h - 116)) / 184);
}

const UP = new THREE.Vector3(0, 1, 0);

function segment(a: THREE.Vector3, b: THREE.Vector3, ra: number, rb: number): THREE.BufferGeometry {
  const dir = b.clone().sub(a);
  const len = dir.length();
  const g = new THREE.CylinderGeometry(rb, ra, len, 8, 1);
  const q = new THREE.Quaternion().setFromUnitVectors(UP, dir.normalize());
  g.applyQuaternion(q);
  g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  return g;
}

function platform(h: number, hw: number, thickness: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(hw * 2, thickness, hw * 2);
  g.translate(0, h + thickness / 2, 0);
  return g;
}

export function buildEiffel(color: string): THREE.Mesh {
  const parts: THREE.BufferGeometry[] = [];
  const heights = [0, 15, 30, 45, 57, 75, 95, 116, 140, 170, 200, 230, 260, 276, 290, 300];
  const corners: [number, number][] = [[1, 1], [1, -1], [-1, 1], [-1, -1]];

  // Legs.
  for (const [sx, sz] of corners) {
    for (let i = 0; i + 1 < heights.length; i++) {
      const h0 = heights[i] as number, h1 = heights[i + 1] as number;
      const a = new THREE.Vector3(sx * halfWidth(h0), h0, sz * halfWidth(h0));
      const b = new THREE.Vector3(sx * halfWidth(h1), h1, sz * halfWidth(h1));
      parts.push(segment(a, b, legRadius(h0), legRadius(h1)));
    }
  }

  // Cross bracing between neighbouring legs, below each platform.
  const brace = (h0: number, h1: number, r: number) => {
    const pairs: [[number, number], [number, number]][] = [
      [[1, 1], [1, -1]], [[1, -1], [-1, -1]], [[-1, -1], [-1, 1]], [[-1, 1], [1, 1]],
    ];
    for (const [p, q] of pairs) {
      const a = new THREE.Vector3(p[0] * halfWidth(h0), h0, p[1] * halfWidth(h0));
      const b = new THREE.Vector3(q[0] * halfWidth(h1), h1, q[1] * halfWidth(h1));
      const c = new THREE.Vector3(q[0] * halfWidth(h0), h0, q[1] * halfWidth(h0));
      const d = new THREE.Vector3(p[0] * halfWidth(h1), h1, p[1] * halfWidth(h1));
      parts.push(segment(a, b, r, r), segment(c, d, r, r));
    }
  };
  brace(0, 28, 0.9);
  brace(28, 57, 0.8);
  brace(60, 88, 0.6);
  brace(88, 116, 0.6);
  for (let h = 120; h < 276; h += 26) brace(h, Math.min(h + 26, 276), 0.45);

  // Arches under the first platform: a half-ring between each pair of legs.
  for (const [p, q] of [[[1, 1], [1, -1]], [[1, -1], [-1, -1]], [[-1, -1], [-1, 1]], [[-1, 1], [1, 1]]] as [[number, number], [number, number]][]) {
    // The arch apex sits just under the first platform; its feet meet the legs around 20 m.
    const radius = 36;
    const apex = 55;
    const hw = halfWidth(apex - radius) - 1;
    const cx = ((p[0] + q[0]) / 2) * hw, cz = ((p[1] + q[1]) / 2) * hw;
    const ring = new THREE.TorusGeometry(radius, 1.4, 6, 32, Math.PI);
    // Torus lies in its local XY plane; stand it up along the side it spans.
    const alongX = p[1] === q[1];
    ring.rotateY(alongX ? 0 : Math.PI / 2);
    ring.translate(cx, apex - radius, cz);
    parts.push(ring);
  }

  // Platforms and the top.
  parts.push(platform(57, halfWidth(57) + 4, 4));
  parts.push(platform(116, halfWidth(116) + 3, 3.5));
  parts.push(platform(276, halfWidth(276) + 3, 3));
  parts.push(platform(300, 4.5, 2));
  const antenna = new THREE.CylinderGeometry(0.4, 1.2, 30, 8);
  antenna.translate(0, 315, 0);
  parts.push(antenna);

  const merged = mergeGeometries(parts, false) as THREE.BufferGeometry;
  for (const g of parts) g.dispose();
  merged.computeVertexNormals();
  const mesh = new THREE.Mesh(merged, new THREE.MeshLambertMaterial({ color }));
  mesh.name = 'eiffel';
  return mesh;
}
