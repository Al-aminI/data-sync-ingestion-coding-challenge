export const config = {
  databaseUrl: process.env.DATABASE_URL || 'postgresql://postgres:postgres@postgres:5432/ingestion',
  apiBaseUrl: process.env.API_BASE_URL || 'http://datasync-dev-alb-101078500.us-east-1.elb.amazonaws.com',
  apiKey: process.env.API_KEY || '',
  workerCount: parseInt(process.env.WORKER_COUNT || '20', 10),
  batchSize: parseInt(process.env.BATCH_SIZE || '5000', 10),
  tokenRefreshMs: 240_000,
  maxRetries: 5,
  retryBaseMs: 1000,
  retryMaxMs: 30_000,
  totalEvents: 3_000_000,
  latestEventTs: 1769541612369,
  dataRangeDays: 31,
};
