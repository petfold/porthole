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

export type Vec2 = [number, number];

/** Flat coloured area on the ground (water, park). Polygon in (x, z) metres. */
export interface AreaDef {
  kind: 'water' | 'park';
  polygon: Vec2[];
  holes?: Vec2[][];
}

/** A road or path drawn as a flat ribbon along a polyline. */
export interface RoadDef {
  kind: 'road' | 'path' | 'rail';
  width: number;
  path: Vec2[];
}

/** Building footprint extruded to `height` (from `minHeight`). */
export interface BuildingDef {
  polygon: Vec2[];
  holes?: Vec2[][];
  height: number;
  minHeight?: number;
}

/** Procedural landmark models that OSM cannot describe as extrusions. */
export interface LandmarkDef {
  type: 'eiffel';
  position: Vec3;
  yaw?: number;
}

export interface Palette {
  wall: string[];
  roof: string;
  road: string;
  path: string;
  rail: string;
  water: string;
  park: string;
  tower: string;
}

export const DEFAULT_PALETTE: Palette = {
  wall: ['#e3d9c6', '#dbcfba', '#e8dfcc', '#d6c9b2', '#e0d4bf'],
  roof: '#8d97a3',
  road: '#6a6e76',
  path: '#b9b0a0',
  rail: '#7a6f66',
  water: '#6d9fc4',
  park: '#8fb47a',
  tower: '#7a5f4b',
};

export interface WorldManifest {
  name: string;
  attribution?: string;
  origin?: { lat: number; lon: number };
  frame: { units: 'metres'; up: 'Y' };
  spawn: { position: Vec3; heading: number };
  eyeHeight: number;
  ground: { size: number; color: string; grid?: boolean };
  sky?: { color: string; fog?: number };
  primitives: PrimitiveDef[];
  areas: AreaDef[];
  roads: RoadDef[];
  buildings: BuildingDef[];
  landmarks: LandmarkDef[];
  palette: Palette;
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
    attribution: m.attribution,
    origin: m.origin,
    frame: { units: 'metres', up: 'Y' },
    spawn: m.spawn,
    eyeHeight: m.eyeHeight ?? 1.6,
    ground: m.ground,
    sky: m.sky,
    primitives: m.primitives ?? [],
    areas: m.areas ?? [],
    roads: m.roads ?? [],
    buildings: m.buildings ?? [],
    landmarks: m.landmarks ?? [],
    palette: { ...DEFAULT_PALETTE, ...(m.palette ?? {}) },
    scene: m.scene,
    objects: m.objects ?? [],
    rooms: m.rooms ?? [],
  };
}
