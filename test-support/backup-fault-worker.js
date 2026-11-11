import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { syncBuiltinESMExports } from 'node:module';
import { dirname } from 'node:path';
import { createDatabaseBackup } from '../src/database-maintenance.js';

const [database, destination, mode, marker] = process.argv.slice(2);
const originalExec = DatabaseSync.prototype.exec;
const originalLink = fs.linkSync;
const originalUnlink = fs.unlinkSync;
DatabaseSync.prototype.exec = function (sql) {
  if (mode === 'concurrent-write' && sql.startsWith('VACUUM INTO ')) {
    const match = sql.match(/^VACUUM INTO '((?:''|[^'])*)'$/);
    if (!match) throw new Error('unexpected-vacuum-sql');
    const snapshot = match[1].replaceAll("''", "'");
    fs.writeFileSync(marker, String(fs.statSync(dirname(snapshot)).mode & 0o777));
  }
  if (!['destination-race', 'concurrent-write', 'cleanup-failure', 'sync-failure'].includes(mode) && sql.startsWith('VACUUM INTO ')) {
    const match = sql.match(/^VACUUM INTO '((?:''|[^'])*)'$/);
    if (!match) throw new Error('unexpected-vacuum-sql');
    const partialPath = match[1].replaceAll("''", "'");
    fs.writeFileSync(partialPath, 'partial snapshot');
    throw new Error('injected-vacuum-failure');
  }
  return originalExec.call(this, sql);
};
if (mode === 'destination-race') {
  fs.linkSync = (source, target) => {
    if (target === destination) fs.writeFileSync(target, 'concurrent destination');
    return originalLink(source, target);
  };
}
if (mode === 'cleanup-failure' || mode === 'vacuum-cleanup-failure') {
  fs.unlinkSync = target => {
    if (typeof target === 'string' && target.endsWith('snapshot.sqlite')) {
      throw Object.assign(new Error('injected-backup-temp-cleanup-failure'), { code: 'EBUSY' });
    }
    return originalUnlink(target);
  };
}
if (mode === 'sync-failure') {
  const originalOpen = fs.openSync;
  const originalFsync = fs.fsyncSync;
  const tracked = new Set();
  fs.openSync = (target, flags, permissions) => {
    const descriptor = originalOpen(target, flags, permissions);
    if (typeof target === 'string' && target.endsWith('snapshot.sqlite')) tracked.add(descriptor);
    return descriptor;
  };
  fs.fsyncSync = descriptor => {
    if (tracked.has(descriptor)) throw Object.assign(new Error('injected-backup-fsync-failure'), { code: 'EIO' });
    return originalFsync(descriptor);
  };
}
syncBuiltinESMExports();
try {
  const result = createDatabaseBackup(database, destination);
  process.stdout.write(JSON.stringify({ ok: true, result }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, message: error.message, cleanupWarnings: error.cleanupWarnings ?? [] }));
}
