/** Rolling events-per-second estimate for a sensor stream. */
export class RateMeter {
  private times: number[] = [];
  tick(now = performance.now()): void {
    this.times.push(now);
    const cutoff = now - 1000;
    while (this.times.length && (this.times[0] as number) < cutoff) this.times.shift();
  }
  get hz(): number {
    return this.times.length;
  }
  get age(): number {
    const last = this.times[this.times.length - 1];
    return last === undefined ? Infinity : performance.now() - last;
  }
}
