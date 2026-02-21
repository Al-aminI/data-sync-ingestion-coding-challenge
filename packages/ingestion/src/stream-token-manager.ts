import { config } from './config';
import { log } from './logger';

interface StreamAccess {
  endpoint: string;
  token: string;
  expiresIn: number;
  tokenHeader: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

export class StreamTokenManager {
  private access: StreamAccess | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private refreshLock: Promise<void> | null = null;

  async initialize(): Promise<void> {
    await this.refresh();
    this.startAutoRefresh();
  }

  async refresh(): Promise<void> {
    if (this.refreshLock) return this.refreshLock;
    this.refreshLock = this.doRefresh();
    try {
      await this.refreshLock;
    } finally {
      this.refreshLock = null;
    }
  }

  private async doRefresh(): Promise<void> {
    for (let attempt = 0; attempt < config.maxRetries; attempt++) {
      try {
        const res = await fetch(
          `${config.apiBaseUrl}/internal/dashboard/stream-access`,
          {
            method: 'POST',
            headers: {
              'X-API-Key': config.apiKey,
              'Content-Type': 'application/json',
              'User-Agent':
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
              'Sec-Fetch-Site': 'same-origin',
              'X-Requested-With': 'XMLHttpRequest',
              Cookie: `dashboard_api_key=${config.apiKey}`,
            },
          }
        );

        if (!res.ok) {
          const body = await res.text();
          throw new Error(`HTTP ${res.status}: ${body}`);
        }

        const json = (await res.json()) as {
          streamAccess: StreamAccess;
        };
        this.access = json.streamAccess;
        log.info(
          `Stream token acquired (endpoint=${this.access.endpoint}, expires=${this.access.expiresIn}s)`
        );
        return;
      } catch (err) {
        log.warn(`Token refresh attempt ${attempt + 1}/${config.maxRetries} failed: ${err}`);
        if (attempt < config.maxRetries - 1) {
          await sleep(config.retryBaseMs * Math.pow(2, attempt));
        }
      }
    }
    throw new Error('Failed to obtain stream access token');
  }

  get endpoint(): string {
    return this.access?.endpoint ?? '';
  }

  get token(): string {
    return this.access?.token ?? '';
  }

  get tokenHeader(): string {
    return this.access?.tokenHeader ?? 'X-Stream-Token';
  }

  get available(): boolean {
    return this.access !== null;
  }

  private startAutoRefresh(): void {
    this.refreshTimer = setInterval(async () => {
      try {
        await this.refresh();
      } catch (err) {
        log.error(`Auto-refresh failed: ${err}`);
      }
    }, config.tokenRefreshMs);
    this.refreshTimer.unref();
  }

  stop(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }
}
