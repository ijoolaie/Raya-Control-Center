import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

export function databaseRuntimeLockPath(databasePath) {
  if (databasePath === ':memory:') return null;
  const absolute = resolve(databasePath);
  mkdirSync(dirname(absolute), { recursive: true });
  const parent = realpathSync(dirname(absolute));
  const database = join(parent, basename(absolute));
  if (existsSync(database) && lstatSync(database).isSymbolicLink()) {
    throw new Error('Symbolic-link database paths are not supported for runtime locking.');
  }
  return database + '.runtime.lock';
}

export function acquireDatabaseRuntimeLock(databasePath) {
  const lockPath = databaseRuntimeLockPath(databasePath);
  if (!lockPath) return () => {};
  let descriptor;
  const owner = { pid: process.pid, startedAt: new Date().toISOString() };
  try {
    descriptor = openSync(lockPath, 'wx', 0o600);
    writeFileSync(descriptor, JSON.stringify(owner) + '\n', 'utf8');
    fsyncSync(descriptor);
  } catch (error) {
    if (descriptor !== undefined) {
      closeSync(descriptor);
      try { unlinkSync(lockPath); } catch {}
    }
    if (error.code === 'EEXIST') {
      let detail = 'An existing runtime lock prevents access.';
      try {
        const current = JSON.parse(readFileSync(lockPath, 'utf8'));
        detail = 'Database is already locked by process ' + String(current.pid) + ' (started ' + String(current.startedAt) + ').';
      } catch {}
      throw new Error(detail + ' If this is a stale lock, verify the process is stopped before removing ' + lockPath + '.');
    }
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try { closeSync(descriptor); } catch {}
    try {
      const current = JSON.parse(readFileSync(lockPath, 'utf8'));
      if (current.pid === owner.pid && current.startedAt === owner.startedAt) unlinkSync(lockPath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  };
}
