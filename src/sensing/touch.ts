/**
 * Touch controls on the view: hold to brake, double-tap to recentre.
 * Keyboard for desktop: W/S or ↑/↓ throttle, space brakes, R recentres.
 * Drag-to-look is handled by DragOrientation when sensors are unavailable.
 */
export interface TouchHandlers {
  onBrake(active: boolean): void;
  onRecentre(): void;
  /** Desktop only: a synthetic impulse in m/s (positive = push). */
  onImpulse(value: number): void;
}

export class TouchControls {
  private lastTapUp = 0;
  private downAt = 0;
  private downPos: { x: number; y: number } | null = null;
  private moved = false;
  private pointers = 0;

  constructor(private readonly el: HTMLElement, private readonly h: TouchHandlers) {}

  private onDown = (e: PointerEvent): void => {
    this.pointers++;
    this.downAt = performance.now();
    this.downPos = { x: e.clientX, y: e.clientY };
    this.moved = false;
    this.h.onBrake(true);
  };
  private onMove = (e: PointerEvent): void => {
    if (!this.downPos) return;
    if (!this.moved && Math.hypot(e.clientX - this.downPos.x, e.clientY - this.downPos.y) > 12) {
      // A drag is a look (desktop fallback), not a brake.
      this.moved = true;
      this.h.onBrake(false);
    }
  };
  private onUp = (): void => {
    this.pointers = Math.max(0, this.pointers - 1);
    if (this.pointers === 0 && !this.moved) this.h.onBrake(false);
    const now = performance.now();
    const shortTap = now - this.downAt < 300 && !this.moved;
    if (shortTap && now - this.lastTapUp < 350) {
      this.h.onRecentre();
      this.lastTapUp = 0;
    } else {
      this.lastTapUp = shortTap ? now : 0;
    }
    this.downPos = null;
  };
  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.repeat) return;
    switch (e.key) {
      case 'w': case 'ArrowUp': this.h.onImpulse(0.5); break;
      case 's': case 'ArrowDown': this.h.onImpulse(-0.5); break;
      case ' ': this.h.onBrake(true); break;
      case 'r': this.h.onRecentre(); break;
    }
  };
  private onKeyUp = (e: KeyboardEvent): void => {
    if (e.key === ' ') this.h.onBrake(false);
  };

  start(): void {
    this.el.addEventListener('pointerdown', this.onDown);
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    window.addEventListener('pointercancel', this.onUp);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    this.el.addEventListener('contextmenu', (e) => e.preventDefault());
  }
}
