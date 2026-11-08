import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const [mode, database] = process.argv.slice(2);
const lockPath = database + '.maintenance.lock';
const originalOpen = fs.openSync;
const originalWriteFile = fs.writeFileSync;
const originalWrite = fs.writeSync;
const originalFsync = fs.fsyncSync;
const originalUnlink = fs.unlinkSync;
const lockDescriptors = new Set();
const terminate = () => process.kill(process.pid, 'SIGKILL');

fs.openSync = (target, flags, permissions) => {
  const descriptor = originalOpen(target, flags, permissions);
  if (target === lockPath) {
    lockDescriptors.add(descriptor);
    if (mode === 'after-open') terminate();
  }
  return descriptor;
};
if (mode === 'after-partial-write') {
  fs.writeFileSync = (target, data, ...args) => {
    if (typeof target === 'number' && lockDescriptors.has(target)) {
      originalWrite(target, Buffer.from('{\"pid\":'), 0, 7, null);
      terminate();
    }
    return originalWriteFile(target, data, ...args);
  };
}
if (mode === 'after-file-fsync') {
  fs.fsyncSync = descriptor => {
    const result = originalFsync(descriptor);
    if (lockDescriptors.has(descriptor)) terminate();
    return result;
  };
}
if (mode === 'after-unlink') {
  fs.unlinkSync = target => {
    const result = originalUnlink(target);
    if (target === lockPath) terminate();
    return result;
  };
}
syncBuiltinESMExports();
const { acquireDatabaseMaintenanceLock } = await import('../src/database-runtime-lock.js');
const release = acquireDatabaseMaintenanceLock(database);
if (mode === 'after-unlink') release();
process.stdout.write('unexpected-normal-exit');
