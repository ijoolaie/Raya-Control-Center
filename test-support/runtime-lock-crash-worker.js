import { acquireDatabaseMaintenanceLock } from '../src/database-runtime-lock.js';

const [mode, database] = process.argv.slice(2);
let release;
try {
  release = acquireDatabaseMaintenanceLock(database);
} catch (error) {
  if (mode === 'contend' && /maintenance lock prevents access/.test(error.message)) {
    process.stdout.write('BLOCKED\n');
    process.exit(0);
  }
  throw error;
}

if (mode === 'crash') {
  process.kill(process.pid, 'SIGKILL');
} else if (mode === 'hold' || mode === 'contend') {
  process.stdout.write('LOCKED\n');
  setInterval(() => {}, 1000);
} else {
  release();
  process.stdout.write('RELEASED\n');
}
