import { run } from './orchestrator';

run().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
