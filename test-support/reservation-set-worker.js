import { acquireDatabaseReservationSet } from '../src/database-runtime-lock.js';

const [mode, firstDatabase, secondDatabase, holdMilliseconds = '1000'] = process.argv.slice(2);
const requests = [
  { databasePath: firstDatabase, lockClass: 'maintenance' },
  { databasePath: secondDatabase, lockClass: 'maintenance' }
];
if (mode === 'reverse') requests.reverse();

let guard;
try {
  guard = acquireDatabaseReservationSet(requests);
} catch (error) {
  if (/maintenance lock prevents access/.test(error.message)) {
    process.stdout.write('BLOCKED\n');
    process.exit(0);
  }
  throw error;
}

if (mode === 'crash') {
  process.stdout.write('LOCKED\n', () => process.kill(process.pid, 'SIGKILL'));
} else {
  process.stdout.write('LOCKED\n');
  const duration = Math.max(0, Math.min(10000, Number(holdMilliseconds) || 0));
  setTimeout(() => {
    guard.release();
    process.stdout.write('RELEASED\n');
  }, duration);
}
