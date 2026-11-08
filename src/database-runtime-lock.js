import { closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, parse, resolve, sep } from 'node:path';
import { syncDirectory } from './file-system-durability.js';

function assertNoSymlinkParentComponents(filename) {
  const absolute = resolve(filename);
  const parsed = parse(absolute);
  const components = absolute.slice(parsed.root.length).split(sep).filter(Boolean);
  let current = parsed.root;
  for (const component of components) {
    current = join(current, component);
    let stat;
    try { stat = lstatSync(current); }
    catch (error) {
      if (error.code === 'ENOENT') return absolute;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new Error('Database parent path must not traverse a symbolic link or junction: ' + current);
    }
  }
  return absolute;
}

export function databaseRuntimeLockPath(databasePath) {
  if (databasePath === ':memory:') return null;
  const absolute = resolve(databasePath);
  const parentDirectory = dirname(absolute);
  assertNoSymlinkParentComponents(parentDirectory);
  mkdirSync(parentDirectory, { recursive: true });
  assertNoSymlinkParentComponents(parentDirectory);
  const parent = realpathSync(parentDirectory);
  const database = join(parent, basename(absolute));
  if (existsSync(database) && lstatSync(database).isSymbolicLink()) {
    throw new Error('Symbolic-link database paths are not supported for runtime locking.');
  }
  return database + '.runtime.lock';
}

function acquireDatabaseFileLock(databasePath, suffix, label) {
  const basePath = databaseRuntimeLockPath(databasePath);
  const lockPath = basePath ? basePath.slice(0, -'.runtime.lock'.length) + suffix : null;
  if (!lockPath) return () => {};
  let descriptor;
  let lockIdentity;
  const owner = { pid: process.pid, startedAt: new Date().toISOString() };
  try {
    descriptor = openSync(lockPath, 'wx', 0o600);
    lockIdentity = fstatSync(descriptor);
    writeFileSync(descriptor, JSON.stringify(owner) + '\n', 'utf8');
    fsyncSync(descriptor);
    syncDirectory(dirname(lockPath));
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch {}
      // Once the lock path has been created, a failed write/fsync/directory flush
      // leaves its publication state uncertain. Preserve it for operator review;
      // deleting by pathname here could remove a replacement lock owned by another process.
      error.lockPath = lockPath;
    }
    if (error.code === 'EEXIST') {
      let detail = 'An existing ' + label + ' lock prevents access.';
      try {
        const current = JSON.parse(readFileSync(lockPath, 'utf8'));
        detail = (label === 'runtime' ? 'Database is already locked by process ' : label + ' lock is already held by process ') + String(current.pid) + ' (started ' + String(current.startedAt) + ').';
      } catch {}
      throw new Error(detail + ' If this is a stale lock, verify the process is stopped before removing ' + lockPath + '.');
    }
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      const current = JSON.parse(readFileSync(lockPath, 'utf8'));
      if (current.pid === owner.pid && current.startedAt === owner.startedAt) {
        const currentIdentity = lstatSync(lockPath);
        if (!currentIdentity.isFile() || currentIdentity.dev !== lockIdentity.dev || currentIdentity.ino !== lockIdentity.ino) return;
        unlinkSync(lockPath);
        syncDirectory(dirname(lockPath));
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    } finally {
      try { closeSync(descriptor); } catch {}
    }
  };
}

export function acquireDatabaseRuntimeLock(databasePath) { return acquireDatabaseFileLock(databasePath, '.runtime.lock', 'runtime'); }
export function acquireDatabaseMaintenanceLock(databasePath) { return acquireDatabaseFileLock(databasePath, '.maintenance.lock', 'maintenance'); }
