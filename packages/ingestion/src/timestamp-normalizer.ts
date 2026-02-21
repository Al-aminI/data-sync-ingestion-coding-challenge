export function normalizeTimestamp(ts: number | string): string {
  if (typeof ts === 'number') {
    const ms = ts < 10_000_000_000 ? ts * 1000 : ts;
    return new Date(ms).toISOString();
  }
  if (typeof ts === 'string') {
    const d = new Date(ts);
    if (!isNaN(d.getTime())) return d.toISOString();
    const num = Number(ts);
    if (!isNaN(num)) return normalizeTimestamp(num);
  }
  return new Date().toISOString();
}

export function getTimestampMs(ts: number | string): number {
  if (typeof ts === 'number') {
    return ts < 10_000_000_000 ? ts * 1000 : ts;
  }
  if (typeof ts === 'string') {
    const d = new Date(ts);
    if (!isNaN(d.getTime())) return d.getTime();
    const num = Number(ts);
    if (!isNaN(num)) return getTimestampMs(num);
  }
  return Date.now();
}
