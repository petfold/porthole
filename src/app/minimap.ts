/**
 * North-up minimap. The whole world is drawn once to an offscreen canvas at
 * a fixed scale; each frame a window of it is blitted centred on the
 * vehicle, then the position dot and the view sector are drawn on top.
 * Map axes: world x (east) → right, world z (south) → down.
 */
import type { WorldManifest, Vec2 } from '../world/manifest';
import { halfWidth } from '../world/eiffel';

const SIZE_CSS = 140;        // on-screen diameter, CSS px
const RADIUS_M = 220;        // metres from centre to the rim
const DOT_PX = 4;
const SECTOR_PX = 15;

export class Minimap {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly map: HTMLCanvasElement;
  /** Offscreen map pixels per metre. */
  private readonly ppm: number;
  private readonly half: number;
  private readonly dpr = Math.min(window.devicePixelRatio || 1, 2);

  constructor(root: HTMLElement, world: WorldManifest) {
    this.half = world.ground.size / 2;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'minimap';
    this.canvas.width = this.canvas.height = Math.round(SIZE_CSS * this.dpr);
    root.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d') as CanvasRenderingContext2D;

    // Offscreen scale: the on-screen scale times dpr, so blitting is 1:1.
    this.ppm = ((SIZE_CSS / 2) / RADIUS_M) * this.dpr;
    this.map = document.createElement('canvas');
    const px = Math.ceil(world.ground.size * this.ppm) + 2;
    this.map.width = this.map.height = px;
    this.drawWorld(world);
  }

  private toMap(x: number, z: number): [number, number] {
    return [(x + this.half) * this.ppm + 1, (z + this.half) * this.ppm + 1];
  }

  private polygon(c: CanvasRenderingContext2D, poly: Vec2[], holes?: Vec2[][]): void {
    c.beginPath();
    const ring = (r: Vec2[]) => {
      r.forEach(([x, z], i) => { const [mx, mz] = this.toMap(x, z); if (i === 0) c.moveTo(mx, mz); else c.lineTo(mx, mz); });
      c.closePath();
    };
    ring(poly);
    for (const h of holes ?? []) ring(h);
  }

  private drawWorld(world: WorldManifest): void {
    const c = this.map.getContext('2d') as CanvasRenderingContext2D;
    const p = world.palette;
    c.fillStyle = world.ground.color;
    c.fillRect(0, 0, this.map.width, this.map.height);

    for (const a of world.areas) {
      this.polygon(c, a.polygon, a.holes);
      c.fillStyle = a.kind === 'water' ? p.water : p.park;
      c.fill('evenodd');
    }
    c.lineCap = 'round';
    c.lineJoin = 'round';
    for (const r of world.roads) {
      c.beginPath();
      r.path.forEach(([x, z], i) => { const [mx, mz] = this.toMap(x, z); if (i === 0) c.moveTo(mx, mz); else c.lineTo(mx, mz); });
      c.strokeStyle = r.kind === 'road' ? p.road : r.kind === 'rail' ? p.rail : p.path;
      c.lineWidth = Math.max(r.kind === 'road' ? 1 : 0.6, r.width * this.ppm);
      c.stroke();
    }
    c.fillStyle = '#8f867a';
    for (const b of world.buildings) {
      this.polygon(c, b.polygon, b.holes);
      c.fill('evenodd');
    }
    for (const q of world.primitives) {
      const [x, , z] = q.position;
      const [w, , d] = q.size;
      const [mx, mz] = this.toMap(x, z);
      c.save();
      c.translate(mx, mz);
      c.rotate((-(q.yaw ?? 0) * Math.PI) / 180);
      c.fillStyle = q.color;
      if (q.type === 'cylinder' || q.type === 'sphere') { c.beginPath(); c.arc(0, 0, (w / 2) * this.ppm, 0, Math.PI * 2); c.fill(); }
      else c.fillRect((-w / 2) * this.ppm, (-d / 2) * this.ppm, w * this.ppm, d * this.ppm);
      c.restore();
    }
    for (const l of world.landmarks) {
      if (l.type !== 'eiffel') continue;
      const [mx, mz] = this.toMap(l.position[0], l.position[2]);
      const hw = (halfWidth(0) + 6) * this.ppm;
      c.save();
      c.translate(mx, mz);
      c.rotate((-(l.yaw ?? 0) * Math.PI) / 180);
      c.fillStyle = p.tower;
      c.fillRect(-hw, -hw, hw * 2, hw * 2);
      c.restore();
    }
  }

  /** @param heading view yaw in radians (0 = north/−z, counterclockwise from above); @param hfov horizontal FOV in radians. */
  update(x: number, z: number, heading: number, hfov: number): void {
    const c = this.ctx;
    const S = this.canvas.width;
    const r = S / 2;
    c.clearRect(0, 0, S, S);
    c.save();
    c.beginPath();
    c.arc(r, r, r - 1, 0, Math.PI * 2);
    c.clip();
    c.fillStyle = '#1d232b';
    c.fillRect(0, 0, S, S);
    const [mx, mz] = this.toMap(x, z);
    c.drawImage(this.map, mx - r, mz - r, S, S, 0, 0, S, S);

    // View sector: forward in map space is (−sin h, −cos h).
    const a = Math.atan2(-Math.cos(heading), -Math.sin(heading));
    c.beginPath();
    c.moveTo(r, r);
    c.arc(r, r, SECTOR_PX * this.dpr, a - hfov / 2, a + hfov / 2);
    c.closePath();
    c.fillStyle = 'rgba(255, 60, 40, 0.5)';
    c.fill();
    c.strokeStyle = 'rgba(255, 90, 70, 0.9)';
    c.lineWidth = 1 * this.dpr;
    c.stroke();

    c.beginPath();
    c.arc(r, r, DOT_PX * this.dpr, 0, Math.PI * 2);
    c.fillStyle = '#e8281c';
    c.fill();
    c.strokeStyle = '#fff';
    c.lineWidth = 1.2 * this.dpr;
    c.stroke();
    c.restore();

    // Rim and north tick.
    c.beginPath();
    c.arc(r, r, r - 1, 0, Math.PI * 2);
    c.strokeStyle = 'rgba(255,255,255,0.7)';
    c.lineWidth = 1.5 * this.dpr;
    c.stroke();
    c.fillStyle = 'rgba(255,255,255,0.85)';
    c.font = `${10 * this.dpr}px system-ui, sans-serif`;
    c.textAlign = 'center';
    c.fillText('N', r, 11 * this.dpr);
  }
}
