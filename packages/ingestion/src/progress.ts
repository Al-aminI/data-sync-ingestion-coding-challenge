import { config } from './config';

export class ProgressTracker {
  private total: number;
  private ingested: number;
  private startTime: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private workerCounts: Map<number, number> = new Map();

  constructor(total: number, initial: number = 0) {
    this.total = total;
    this.ingested = initial;
    this.startTime = Date.now();
  }

  onBatch(workerId: number, count: number): void {
    this.ingested += count;
    this.workerCounts.set(workerId, (this.workerCounts.get(workerId) || 0) + count);
  }

  start(): void {
    this.startTime = Date.now();
    this.timer = setInterval(() => this.print(), 5_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.print();
  }

  private print(): void {
    const elapsed = (Date.now() - this.startTime) / 1000;
    const rate = elapsed > 0 ? Math.round(this.ingested / elapsed) : 0;
    const pct = ((this.ingested / this.total) * 100).toFixed(1);
    const remaining = rate > 0 ? Math.round((this.total - this.ingested) / rate) : 0;
    const bar = this.bar(this.ingested / this.total);
    const activeWorkers = this.workerCounts.size;

    console.log(
      `[${this.fmtTime(elapsed)}] ${bar} ${this.fmtNum(this.ingested)}/${this.fmtNum(this.total)} (${pct}%) | ${this.fmtNum(rate)} evt/s | ETA ${this.fmtTime(remaining)} | ${activeWorkers}w`
    );
  }

  private bar(ratio: number): string {
    const width = 30;
    const filled = Math.min(width, Math.max(0, Math.round(ratio * width)));
    return '█'.repeat(filled) + '░'.repeat(width - filled);
  }

  private fmtNum(n: number): string {
    return n.toLocaleString('en-US');
  }

  private fmtTime(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}m${s.toString().padStart(2, '0')}s`;
  }
}
