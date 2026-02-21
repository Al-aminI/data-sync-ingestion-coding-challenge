import { Pool } from 'pg';
import { config } from './config';
import { log } from './logger';
import { getPool, closePool } from './db/connection';
import { createSchema, getEventCount } from './db/schema';
import { getCheckpoints } from './db/checkpoint';
import { StreamTokenManager } from './stream-token-manager';
import { SharedRateLimiter } from './rate-limiter';
import { createPartitions } from './cursor-factory';
import { runWorker, requestShutdown } from './worker';
import { ProgressTracker } from './progress';
import { Partition } from './types';

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function waitForDb(pool: Pool): Promise<void> {
  for (let i = 0; i < 30; i++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch {
      log.info(`Waiting for database... (${i + 1}/30)`);
      await sleep(2000);
    }
  }
  throw new Error('Database not available after 60 seconds');
}

export async function run(): Promise<void> {
  log.info('DataSync Ingestion Pipeline starting');
  log.info(`Config: workers=${config.workerCount} batchSize=${config.batchSize}`);

  const pool = getPool();

  process.on('SIGTERM', () => {
    log.info('SIGTERM received, shutting down gracefully...');
    requestShutdown();
  });
  process.on('SIGINT', () => {
    log.info('SIGINT received, shutting down gracefully...');
    requestShutdown();
  });

  try {
    await waitForDb(pool);
    await createSchema(pool);

    const existingCount = await getEventCount(pool);
    log.info(`Existing events in database: ${existingCount}`);

    if (existingCount >= config.totalEvents) {
      log.info(`Already have ${existingCount} events, nothing to do`);
      console.log('ingestion complete');
      return;
    }

    const tokenManager = new StreamTokenManager();
    let useStream = true;
    try {
      await tokenManager.initialize();
      log.info('Stream endpoint available - using high-throughput mode');
    } catch (err) {
      log.warn(`Stream access failed: ${err}. Falling back to standard endpoint`);
      useStream = false;
    }

    const partitions = createPartitions(
      config.workerCount,
      config.latestEventTs,
      config.dataRangeDays
    );

    const checkpoints = await getCheckpoints(pool);
    const activePartitions: Partition[] = [];

    for (const p of partitions) {
      const cp = checkpoints.get(p.workerId);
      if (cp && cp.status === 'completed') {
        log.info(`Worker ${p.workerId} already completed (${cp.eventsIngested} events), skipping`);
        continue;
      }
      if (cp && cp.cursor) {
        p.resumeCursor = cp.cursor;
        p.resumeCount = cp.eventsIngested;
        log.info(`Worker ${p.workerId} resuming from checkpoint (${cp.eventsIngested} events so far)`);
      }
      activePartitions.push(p);
    }

    if (activePartitions.length === 0) {
      log.info('All workers already completed');
      console.log('ingestion complete');
      return;
    }

    // ~0.7 requests/sec sustained (42/min), burst of 15 for initial acceleration
    const limiter = new SharedRateLimiter(0.7, 15);
    log.info(`Launching ${activePartitions.length} workers with shared rate limiter...`);
    const progress = new ProgressTracker(config.totalEvents, existingCount);
    progress.start();

    const results = await Promise.allSettled(
      activePartitions.map(p => runWorker(p, pool, tokenManager, limiter, progress.onBatch.bind(progress)))
    );

    progress.stop();
    tokenManager.stop();

    let totalIngested = existingCount;
    for (const r of results) {
      if (r.status === 'fulfilled') {
        totalIngested += r.value;
      } else {
        log.error(`Worker failed: ${r.reason}`);
      }
    }

    const finalCount = await getEventCount(pool);
    log.info(`Ingestion finished. Events in database: ${finalCount}`);

    if (finalCount < config.totalEvents) {
      log.warn(`Expected ${config.totalEvents} but have ${finalCount}. Running sequential gap fill...`);
      await gapFill(pool, tokenManager, finalCount, progress);
    }

    const verifiedCount = await getEventCount(pool);
    log.info(`Final verified count: ${verifiedCount}`);
    console.log('ingestion complete');
  } finally {
    await closePool();
  }
}

async function gapFill(
  pool: Pool,
  tokenManager: StreamTokenManager,
  currentCount: number,
  progressTracker: ProgressTracker
): Promise<void> {
  log.info('Starting gap fill from the beginning...');

  const { insertEvents } = await import('./db/writer');
  const limiter = new SharedRateLimiter(0.5, 3);

  let cursor: string | null = null;
  let fetched = 0;
  const target = config.totalEvents - currentCount + 10_000;
  let tokenRefreshed = false;

  while (fetched < target) {
    try {
      await limiter.acquire();

      let url: string;
      const headers: Record<string, string> = {
        'X-API-Key': config.apiKey,
      };

      if (tokenManager.available) {
        if (!tokenRefreshed) {
          await tokenManager.refresh();
          tokenRefreshed = true;
        }
        url = `${config.apiBaseUrl}${tokenManager.endpoint}?limit=${config.batchSize}`;
        headers[tokenManager.tokenHeader] = tokenManager.token;
      } else {
        url = `${config.apiBaseUrl}/api/v1/events?limit=${config.batchSize}`;
      }

      if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;

      const res = await fetch(url, { headers });

      if (res.status === 429) {
        const wait = parseInt(res.headers.get('Retry-After') || '15', 10);
        limiter.backoff();
        await sleep(wait * 1000 + Math.random() * 3000);
        continue;
      }

      if (res.status === 403 && tokenManager.available) {
        await tokenManager.refresh();
        tokenRefreshed = true;
        continue;
      }

      if (res.status === 400) {
        const body = await res.text();
        if (body.includes('CURSOR_EXPIRED')) {
          log.warn('Gap fill cursor expired, restarting from beginning');
          cursor = null;
          continue;
        }
      }

      if (!res.ok) break;

      limiter.onSuccess();
      const body = (await res.json()) as any;
      if (!body.data || body.data.length === 0) break;

      await insertEvents(pool, body.data);
      fetched += body.data.length;
      progressTracker.onBatch(-1, body.data.length);

      cursor = body.pagination?.nextCursor ?? null;
      if (!body.pagination?.hasMore || !cursor) break;
    } catch (err) {
      log.error(`Gap fill error: ${err}`);
      await sleep(5000);
    }
  }

  log.info(`Gap fill complete: ${fetched} additional events fetched`);
}
