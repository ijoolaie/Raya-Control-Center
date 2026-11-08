import { acquireDatabaseMaintenanceLock } from '../src/database-runtime-lock.js';

const [mode, database] = process.argv.slice(2);
const release = acquireDatabaseMaintenanceLock(database);

if (mode === 'crash') {
  process.kill(process.pid, 'SIGKILL');
} else if (mode === 'hold') {
  process.stdout.write('LOCKED\n');
  setInterval(() => {}, 1000);
} else {
  release();
  process.stdout.write('RELEASED\n');
}
