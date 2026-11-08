import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { acquireDatabaseMaintenanceLock } from '../src/database-runtime-lock.js';

const [mode, database] = process.argv.slice(2);
const originalOpen = fs.openSync;
const originalFsync = fs.fsyncSync;
const originalClose = fs.closeSync;
const lockDescriptors = new Set();
const directoryDescriptors = new Set();
let directorySyncCount = 0;
fs.openSync = (target, flags, permissions) => {
  const descriptor = originalOpen(target, flags, permissions);
  if (typeof target === 'string' && target.endsWith('.maintenance.lock')) lockDescriptors.add(descriptor);
  if (typeof target === 'string') {
    try { if (fs.statSync(target).isDirectory()) directoryDescriptors.add(descriptor); } catch {}
  }
  return descriptor;
};
fs.closeSync = descriptor => {
  lockDescriptors.delete(descriptor);
  directoryDescriptors.delete(descriptor);
  return originalClose(descriptor);
};
fs.fsyncSync = descriptor => {
  if (mode === 'file-fsync-failure' && lockDescriptors.has(descriptor)) {
    throw Object.assign(new Error('injected-lock-file-fsync-failure'), { code: 'EIO' });
  }
  if (mode === 'release-directory-fsync-failure' && directoryDescriptors.has(descriptor)) {
    directorySyncCount += 1;
    if (directorySyncCount === 2) throw Object.assign(new Error('injected-lock-release-directory-fsync-failure'), { code: 'EIO' });
  }
  return originalFsync(descriptor);
};
syncBuiltinESMExports();

let release;
try {
  release = acquireDatabaseMaintenanceLock(database);
  if (mode === 'release-directory-fsync-failure') {
    try { release(); process.stdout.write(JSON.stringify({ ok: true })); }
    catch (error) {
      release();
      process.stdout.write(JSON.stringify({ ok: false, message: error.message, code: error.code, lockStillExists: fs.existsSync(database + '.maintenance.lock') }));
    }
  } else {
    process.stdout.write(JSON.stringify({ ok: true }));
  }
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, message: error.message, code: error.code, lockPath: error.lockPath }));
}
