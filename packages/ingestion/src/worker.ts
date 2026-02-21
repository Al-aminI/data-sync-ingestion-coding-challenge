import { Pool } from 'pg';
import { StreamTokenManager } from './stream-token-manager';
import { SharedRateLimiter } from './rate-limiter';
import { createFabricatedCursor } from './cursor-factory';
import { config } from './config';
import { log } from './logger';
import { insertEvents } from './db/writer';
import { saveCheckpoint, markWorkerComplete } from './db/checkpoint';
import { ApiResponse, Partition } from './types';

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

let shuttingDown = false;
export function requestShutdown(): void {
  shuttingDown = true;
}

async function fetchPage(
  tokenManager: StreamTokenManager,
  cursor: string | null,
  workerId: number,
  limiter: SharedRateLimiter
): Promise<ApiResponse | 'cursor_expired'> {
  const useStream = tokenManager.available;

  for (let attempt = 0; attempt < config.maxRetries + 5; attempt++) {
    await limiter.acquire();
    try {
      let url: string;
      const headers: Record<string, string> = {
        'X-API-Key': config.apiKey,
        'Accept-Encoding': 'gzip',
      };

      if (useStream) {
        url = `${config.apiBaseUrl}${tokenManager.endpoint}?limit=${config.batchSize}`;
        headers[tokenManager.tokenHeader] = tokenManager.token;
      } else {
        url = `${config.apiBaseUrl}/api/v1/events?limit=${config.batchSize}`;
      }

      if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;

      const res = await fetch(url, { headers });

      if (res.status === 403 && useStream) {
        log.warn(`W${workerId}: 403, refreshing token...`);
        await tokenManager.refresh();
        continue;
      }

      if (res.status === 400) {
        const body = await res.text();
        if (body.includes('CURSOR_EXPIRED') || body.includes('Cursor expired')) {
          log.warn(`W${workerId}: cursor expired`);
          return 'cursor_expired';
        }
        throw new Error(`HTTP 400: ${body}`);
      }

      if (res.status === 429) {
        const retryAfter = res.headers.get('Retry-After');
        const waitBase = retryAfter ? parseInt(retryAfter, 10) : 15;
        log.warn(`W${workerId}: rate limited (Retry-After=${retryAfter || 'none'})`);
        limiter.backoff();
        await sleep(waitBase * 1000 + Math.random() * 5000);
        continue;
      }

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`HTTP ${res.status}: ${body}`);
      }

      limiter.onSuccess();
      return (await res.json()) as ApiResponse;
    } catch (err: any) {
      if (err.message === 'cursor_expired') return 'cursor_expired';
      if (attempt < config.maxRetries + 4) {
        const delay = Math.min(
          config.retryBaseMs * Math.pow(2, Math.min(attempt, 5)) + Math.random() * 2000,
          config.retryMaxMs
        );
        log.warn(`W${workerId}: attempt ${attempt + 1} failed: ${err.message}, retry in ${Math.round(delay)}ms`);
        await sleep(delay);
      } else {
        throw err;
      }
    }
  }
  throw new Error(`W${workerId}: exhausted all retries`);
}

export async function runWorker(
  partition: Partition,
  pool: Pool,
  tokenManager: StreamTokenManager,
  limiter: SharedRateLimiter,
  onProgress: (workerId: number, count: number) => void
): Promise<number> {
  const wid = partition.workerId;
  let cursor = partition.resumeCursor ?? partition.startCursor;
  let totalEvents = partition.resumeCount ?? 0;

  await sleep(wid * 250);

  log.info(`W${wid} starting (boundary=${new Date(partition.boundaryTs).toISOString().slice(0, 10)})`);

  while (!shuttingDown) {
    const result = await fetchPage(tokenManager, cursor, wid, limiter);

    if (result === 'cursor_expired') {
      // Re-fabricate cursor for this partition's start
      cursor = partition.startCursor
        ? createFabricatedCursor(
            Math.floor(partition.boundaryTs + (config.latestEventTs - partition.boundaryTs) * 0.5)
          )
        : null;
      if (!cursor) break;
      log.info(`W${wid}: re-fabricated cursor, continuing`);
      continue;
    }

    if (!result.data || result.data.length === 0) break;

    await insertEvents(pool, result.data);
    totalEvents += result.data.length;
    onProgress(wid, result.data.length);

    cursor = result.pagination.nextCursor ?? null;
    await saveCheckpoint(pool, wid, cursor, totalEvents, partition.boundaryTs);

    if (!result.pagination.hasMore || !cursor) break;
  }

  await markWorkerComplete(pool, wid);
  log.info(`W${wid} done: ${totalEvents} events`);
  return totalEvents;
}
