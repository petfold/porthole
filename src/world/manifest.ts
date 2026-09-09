/**
 * World manifest (`world.json`). Phase 1a uses primitives (boxes, pyramids)
 * so a world needs no glTF. `scene` and `objects` are reserved for later
 * phases and are read but not yet used.
 */

export type Vec3 = [number, number, number];

export interface PrimitiveDef {
  id: string;
  type: 'box' | 'pyramid' | 'cylinder' | 'sphere';
  /** Centre of the footprint on the ground; y is the base height. */
  position: Vec3;
  /** Width (x), height (y), depth (z) in metres. */
  size: Vec3;
  /** Rotation about Y in degrees, counterclockwise seen from above. */
  yaw?: number;
  color: string;
}

export interface RoomDef {
  id: string;
  /** Axis-aligned box: min and max corners. Closed rooms cut audio (D-20). */
  min: Vec3;
  max: Vec3;
  closed: boolean;
}

export interface WorldManifest {
  name: string;
  frame: { units: 'metres'; up: 'Y' };
  spawn: { position: Vec3; heading: number };
  eyeHeight: number;
  ground: { size: number; color: string; grid?: boolean };
  sky?: { color: string; fog?: number };
  primitives: PrimitiveDef[];
  /** Reserved: static glTF scene relative to the manifest. */
  scene?: string;
  /** Reserved: movable objects (Phase 3). */
  objects?: unknown[];
  rooms?: RoomDef[];
}

export async function loadWorld(url: string): Promise<WorldManifest> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`world.json: ${res.status} ${res.statusText} at ${url}`);
  const m = (await res.json()) as Partial<WorldManifest>;
  if (!m.spawn || !m.ground) throw new Error('world.json: spawn and ground are required');
  return {
    name: m.name ?? 'untitled',
    frame: { units: 'metres', up: 'Y' },
    spawn: m.spawn,
    eyeHeight: m.eyeHeight ?? 1.6,
    ground: m.ground,
    sky: m.sky,
    primitives: m.primitives ?? [],
    scene: m.scene,
    objects: m.objects ?? [],
    rooms: m.rooms ?? [],
  };
}
