import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const database = process.argv[2];
const lockPath = database + '.maintenance.lock';
const originalReadFile = fs.readFileSync;
const originalUnlink = fs.unlinkSync;
const originalWriteFile = fs.writeFileSync;
let replaced = false;
fs.readFileSync = (target, ...args) => {
  const contents = originalReadFile(target, ...args);
  if (target === lockPath && !replaced) {
    replaced = true;
    originalUnlink(lockPath);
    originalWriteFile(lockPath, JSON.stringify({ pid: process.pid + 1, startedAt: '2099-01-01T00:00:00.000Z' }) + '\n', 'utf8');
  }
  return contents;
};
syncBuiltinESMExports();
const { acquireDatabaseMaintenanceLock } = await import('../src/database-runtime-lock.js');
const release = acquireDatabaseMaintenanceLock(database);
release();
const remaining = JSON.parse(originalReadFile(lockPath, 'utf8'));
process.stdout.write(JSON.stringify({ replaced, exists: fs.existsSync(lockPath), remaining }));
