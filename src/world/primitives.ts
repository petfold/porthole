import * as THREE from 'three';
import type { PrimitiveDef, WorldManifest } from './manifest';
import { buildAreas, buildBuildings, buildRoads } from './city';
import { buildEiffel } from './eiffel';

/** Build the static scene for a primitive-based world. */
export function buildWorld(world: WorldManifest): THREE.Group {
  const group = new THREE.Group();
  group.name = `world:${world.name}`;

  const half = world.ground.size / 2;
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(world.ground.size, world.ground.size),
    new THREE.MeshLambertMaterial({ color: world.ground.color }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  group.add(ground);

  if (world.ground.grid !== false) {
    const grid = new THREE.GridHelper(world.ground.size, world.ground.size / 2, 0x2b3d29, 0x3a5236);
    grid.position.y = 0.01;
    group.add(grid);
  }

  // Edge markers so the boundary is visible.
  const edge = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(world.ground.size, 0.01, world.ground.size)),
    new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.4 }),
  );
  edge.position.y = 0.02;
  group.add(edge);
  void half;

  for (const p of world.primitives) group.add(buildPrimitive(p));

  const areas = buildAreas(world.areas, world.palette);
  if (areas) group.add(areas);
  const roads = buildRoads(world.roads, world.palette);
  if (roads) group.add(roads);
  const buildings = buildBuildings(world.buildings, world.palette);
  if (buildings) group.add(buildings);
  for (const l of world.landmarks) {
    const mesh = l.type === 'eiffel' ? buildEiffel(world.palette.tower) : null;
    if (!mesh) continue;
    mesh.position.set(l.position[0], l.position[1], l.position[2]);
    mesh.rotation.y = THREE.MathUtils.degToRad(l.yaw ?? 0);
    group.add(mesh);
  }
  return group;
}

export function buildPrimitive(p: PrimitiveDef): THREE.Mesh {
  const [w, h, d] = p.size;
  let geometry: THREE.BufferGeometry;
  switch (p.type) {
    case 'box':
      geometry = new THREE.BoxGeometry(w, h, d);
      break;
    case 'pyramid':
      // A 4-sided cone is a square pyramid; rotate 45° so faces align with axes.
      geometry = new THREE.ConeGeometry(Math.SQRT1_2 * Math.max(w, d), h, 4, 1);
      geometry.rotateY(Math.PI / 4);
      break;
    case 'cylinder':
      geometry = new THREE.CylinderGeometry(w / 2, w / 2, h, 24);
      break;
    case 'sphere':
      geometry = new THREE.SphereGeometry(w / 2, 24, 16);
      break;
  }
  const mesh = new THREE.Mesh(geometry, new THREE.MeshLambertMaterial({ color: p.color }));
  mesh.name = p.id;
  // position.y is the base height; geometry is centred, so lift by half.
  mesh.position.set(p.position[0], p.position[1] + h / 2, p.position[2]);
  mesh.rotation.y = THREE.MathUtils.degToRad(p.yaw ?? 0);
  mesh.castShadow = true;
  return mesh;
}
