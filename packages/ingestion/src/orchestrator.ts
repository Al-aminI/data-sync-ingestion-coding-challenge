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
    try {
      await tokenManager.initialize();
      log.info('Stream endpoint available - using high-throughput mode');
    } catch (err) {
      log.warn(`Stream access failed: ${err}. Falling back to standard endpoint`);
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

    for (const r of results) {
      if (r.status === 'rejected') {
        log.error(`Worker failed: ${r.reason}`);
      }
    }

    tokenManager.stop();

    const finalCount = await getEventCount(pool);
    log.info(`Final verified count: ${finalCount} unique events`);
    console.log('ingestion complete');
  } finally {
    await closePool();
  }
}
