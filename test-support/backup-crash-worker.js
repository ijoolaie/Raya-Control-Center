import { writeFileSync } from 'node:fs';
import { acquireDatabaseMaintenanceLock } from '../src/database-runtime-lock.js';

const [destination, marker] = process.argv.slice(2);
acquireDatabaseMaintenanceLock(destination);
writeFileSync(marker, 'abandoned backup temporary file');
process.kill(process.pid, 'SIGKILL');
