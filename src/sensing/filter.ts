/**
 * One Euro filter (Casiez, Roussel, Vogel 2012): an exponential smoother
 * whose cutoff rises with the signal's speed. Slow changes and jitter are
 * smoothed hard; fast, deliberate moves pass with little lag.
 */
export class OneEuroFilter {
  private x: number | null = null;
  private dx = 0;
  private t = 0;

  /**
   * @param minCutoff Hz: smoothing at rest; lower = smoother, more lag.
   * @param beta speed coefficient: higher = less lag when moving fast.
   * @param dCutoff Hz: cutoff for the derivative estimate.
   */
  constructor(public minCutoff = 1, public beta = 0, public dCutoff = 1) {}

  reset(): void { this.x = null; }

  /** Jump to a value without smoothing (e.g. after a long gap). */
  set(v: number, t: number): void { this.x = v; this.dx = 0; this.t = t; }

  filter(v: number, t: number): number {
    if (this.x === null) { this.x = v; this.t = t; return v; }
    const dt = Math.max(1e-3, (t - this.t) / 1000);
    this.t = t;
    const alpha = (cutoff: number) => { const tau = 1 / (2 * Math.PI * cutoff); return 1 / (1 + tau / dt); };
    const dxRaw = (v - this.x) / dt;
    this.dx += (dxRaw - this.dx) * alpha(this.dCutoff);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += (v - this.x) * alpha(cutoff);
    return this.x;
  }
}
