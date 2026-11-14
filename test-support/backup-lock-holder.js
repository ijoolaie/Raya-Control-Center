import { writeFileSync } from 'node:fs';
import { acquireDatabaseMaintenanceLock } from '../src/database-runtime-lock.js';

const [destination, marker] = process.argv.slice(2);
const release = acquireDatabaseMaintenanceLock(destination);
try {
  writeFileSync(marker, 'active backup temporary file');
  process.stdout.write('ready\n');
  await new Promise(resolve => process.stdin.once('data', resolve));
} finally {
  release();
}