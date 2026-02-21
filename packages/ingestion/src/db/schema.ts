import { Pool } from 'pg';
import { log } from '../logger';

export async function createSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE UNLOGGED TABLE IF NOT EXISTS ingested_events (
      id          TEXT NOT NULL,
      session_id  TEXT,
      user_id     TEXT,
      type        TEXT,
      name        TEXT,
      properties  TEXT,
      timestamp   TIMESTAMPTZ,
      device_type TEXT,
      browser     TEXT
    );

    CREATE TABLE IF NOT EXISTS ingestion_progress (
      worker_id       INTEGER PRIMARY KEY,
      cursor_value    TEXT,
      events_ingested BIGINT DEFAULT 0,
      boundary_ts     BIGINT,
      last_checkpoint TIMESTAMPTZ DEFAULT NOW(),
      status          TEXT DEFAULT 'running'
    );
  `);
  log.info('Database schema ready');
}

export async function getEventCount(pool: Pool): Promise<number> {
  const result = await pool.query('SELECT COUNT(*)::int AS count FROM ingested_events');
  return result.rows[0].count;
}

export async function addIndexes(pool: Pool): Promise<void> {
  log.info('Adding primary key index...');
  try {
    await pool.query('ALTER TABLE ingested_events ADD CONSTRAINT ingested_events_pkey PRIMARY KEY (id)');
  } catch {
    log.warn('Primary key already exists or duplicates found, skipping');
  }
}
