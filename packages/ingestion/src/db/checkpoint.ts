import { Pool } from 'pg';

export interface Checkpoint {
  workerId: number;
  cursor: string | null;
  eventsIngested: number;
  boundaryTs: number;
  status: string;
}

export async function saveCheckpoint(
  pool: Pool,
  workerId: number,
  cursor: string | null,
  eventsIngested: number,
  boundaryTs: number
): Promise<void> {
  await pool.query(
    `INSERT INTO ingestion_progress (worker_id, cursor_value, events_ingested, boundary_ts, last_checkpoint, status)
     VALUES ($1, $2, $3, $4, NOW(), 'running')
     ON CONFLICT (worker_id) DO UPDATE SET
       cursor_value = $2,
       events_ingested = $3,
       boundary_ts = $4,
       last_checkpoint = NOW(),
       status = 'running'`,
    [workerId, cursor, eventsIngested, boundaryTs]
  );
}

export async function markWorkerComplete(pool: Pool, workerId: number): Promise<void> {
  await pool.query(
    `UPDATE ingestion_progress SET status = 'completed', last_checkpoint = NOW() WHERE worker_id = $1`,
    [workerId]
  );
}

export async function getCheckpoints(pool: Pool): Promise<Map<number, Checkpoint>> {
  const result = await pool.query(
    'SELECT worker_id, cursor_value, events_ingested, boundary_ts, status FROM ingestion_progress'
  );
  const map = new Map<number, Checkpoint>();
  for (const row of result.rows) {
    map.set(row.worker_id, {
      workerId: row.worker_id,
      cursor: row.cursor_value,
      eventsIngested: parseInt(row.events_ingested, 10),
      boundaryTs: parseInt(row.boundary_ts, 10),
      status: row.status,
    });
  }
  return map;
}
