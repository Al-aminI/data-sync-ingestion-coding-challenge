import { Partition } from './types';

export function createFabricatedCursor(ts: number): string {
  const cursor = {
    id: '00000000-0000-0000-0000-000000000000',
    ts,
    v: 2,
    exp: Date.now() + 7_200_000,
  };
  return Buffer.from(JSON.stringify(cursor)).toString('base64');
}

export function createPartitions(
  workerCount: number,
  latestTs: number,
  rangeDays: number
): Partition[] {
  const totalMs = rangeDays * 24 * 60 * 60 * 1000;
  const partitionMs = totalMs / workerCount;
  const partitions: Partition[] = [];

  for (let i = 0; i < workerCount; i++) {
    const startTs = latestTs - i * partitionMs;
    const boundaryTs = latestTs - (i + 1) * partitionMs;

    partitions.push({
      workerId: i,
      startCursor: i === 0 ? null : createFabricatedCursor(Math.floor(startTs)),
      boundaryTs: Math.floor(boundaryTs),
    });
  }

  return partitions;
}
