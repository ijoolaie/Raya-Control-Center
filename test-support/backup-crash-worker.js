import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { acquireDatabaseMaintenanceLock } from '../src/database-runtime-lock.js';

const [destination, marker] = process.argv.slice(2);
acquireDatabaseMaintenanceLock(destination);
mkdirSync(marker, { mode: 0o700 });
writeFileSync(join(marker, 'snapshot.sqlite'), 'abandoned backup temporary snapshot');
process.kill(process.pid, 'SIGKILL');
