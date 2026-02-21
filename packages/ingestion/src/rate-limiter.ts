export class SharedRateLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly maxTokens: number;
  private readonly refillRate: number;
  private backoffUntil = 0;
  private consecutiveBackoffs = 0;

  constructor(requestsPerSecond: number, burst: number = requestsPerSecond * 2) {
    this.maxTokens = burst;
    this.tokens = burst;
    this.refillRate = requestsPerSecond / 1000;
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    if (now < this.backoffUntil) return;
    const elapsed = now - this.lastRefill;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
  }

  async acquire(): Promise<void> {
    while (true) {
      const now = Date.now();
      if (now < this.backoffUntil) {
        await new Promise<void>(r => setTimeout(r, this.backoffUntil - now + Math.random() * 1000));
        continue;
      }

      this.refill();

      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }

      const waitMs = (1 - this.tokens) / this.refillRate + Math.random() * 500;
      await new Promise<void>(r => setTimeout(r, waitMs));
    }
  }

  release(): void {
    // no-op now, keeping for API compatibility
  }

  backoff(): void {
    this.consecutiveBackoffs++;
    const backoffMs = Math.min(30_000, 5_000 * this.consecutiveBackoffs);
    this.backoffUntil = Date.now() + backoffMs;
    this.tokens = 0;
    this.lastRefill = Date.now() + backoffMs;
  }

  onSuccess(): void {
    this.consecutiveBackoffs = Math.max(0, this.consecutiveBackoffs - 1);
  }
}
