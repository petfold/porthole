/**
 * Dev-only trace: buffers JSON records and posts them once a second to the
 * dev server's /__record endpoint (see vite.config.ts), which appends them
 * to spikes/records/<name>.jsonl. Enabled with `?trace`. Nothing is sent
 * in a production bundle unless the endpoint exists, and it never does.
 */
export class Tracer {
  private buf: string[] = [];
  private timer = 0;
  session = '';
  recording = false;
  sent = 0;
  failed = 0;

  constructor(readonly name: string) {
    this.timer = window.setInterval(() => void this.flush(), 1000);
    window.addEventListener('pagehide', () => void this.flush());
  }

  /** Begin a new recording session; records logged before this are dropped. */
  start(meta: Record<string, unknown> = {}): void {
    this.session = new Date().toISOString().replace(/[-:]/g, '').slice(4, 15);
    this.recording = true;
    this.log({ k: 'start', t: performance.now(), ...meta });
  }

  stopRecording(): void {
    if (!this.recording) return;
    this.log({ k: 'stop', t: performance.now() });
    this.recording = false;
    void this.flush();
  }

  log(rec: Record<string, unknown>): void {
    if (!this.recording) return;
    this.buf.push(JSON.stringify({ s: this.session, ...rec }));
  }

  async flush(): Promise<void> {
    if (!this.buf.length) return;
    const body = this.buf.join('\n');
    this.buf = [];
    try {
      const res = await fetch(new URL(`__record?name=${this.name}`, location.href), { method: 'POST', body, keepalive: true });
      if (res.ok) this.sent += body.length; else this.failed++;
    } catch { this.failed++; }
  }

  stop(): void { clearInterval(this.timer); void this.flush(); }
}
