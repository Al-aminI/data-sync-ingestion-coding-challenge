import { Pool } from 'pg';
import { from as copyFrom } from 'pg-copy-streams';
import { normalizeTimestamp } from '../timestamp-normalizer';
import { ApiEvent } from '../types';

function escapeCopy(val: string | null | undefined): string {
  if (val === null || val === undefined) return '\\N';
  return val
    .replace(/\\/g, '\\\\')
    .replace(/\t/g, '\\t')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

export async function insertEvents(pool: Pool, events: ApiEvent[]): Promise<void> {
  const client = await pool.connect();
  try {
    const stream = client.query(
      copyFrom(
        'COPY ingested_events (id, session_id, user_id, type, name, properties, timestamp, device_type, browser) FROM STDIN'
      )
    );

    const writePromise = new Promise<void>((resolve, reject) => {
      stream.on('finish', resolve);
      stream.on('error', reject);
    });

    for (const e of events) {
      const row = [
        escapeCopy(e.id),
        escapeCopy(e.sessionId),
        escapeCopy(e.userId),
        escapeCopy(e.type),
        escapeCopy(e.name),
        escapeCopy(JSON.stringify(e.properties ?? {})),
        escapeCopy(normalizeTimestamp(e.timestamp)),
        escapeCopy(e.session?.deviceType),
        escapeCopy(e.session?.browser),
      ].join('\t') + '\n';

      if (!stream.write(row)) {
        await new Promise<void>(r => stream.once('drain', r));
      }
    }

    stream.end();
    await writePromise;
  } finally {
    client.release();
  }
}
