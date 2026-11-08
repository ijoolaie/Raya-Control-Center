import { DatabaseSync } from 'node:sqlite';
import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join, parse, resolve, sep } from 'node:path';

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
  try {
    if (lstatSync(database).isSymbolicLink()) {
      throw new Error('Symbolic-link database paths are not supported for runtime locking.');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return database + '.runtime.lock';
}

function lockPathFor(databasePath, suffix) {
  const runtimePath = databaseRuntimeLockPath(databasePath);
  return runtimePath ? runtimePath.slice(0, -'.runtime.lock'.length) + suffix : null;
}

function isBusyError(error) {
  return error?.code === 'SQLITE_BUSY' || /database is locked|SQLITE_BUSY/i.test(error?.message || '');
}

function heldError(label, lockPath) {
  return new Error('An existing ' + label + ' lock prevents access. Verify that its owner has stopped before taking operator action: ' + lockPath + '.');
}

function openLockDatabase(lockPath) {
  try {
    const stat = lstatSync(lockPath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size !== 0 || stat.nlink !== 1) throw new Error('Lock path must be a zero-byte regular non-symbolic-link file with exactly one hard link: ' + lockPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const database = new DatabaseSync(lockPath);
  try {
    // The lock transaction performs no data writes. OFF avoids leaving a hot
    // rollback journal if the owning process is terminated without cleanup.
    database.exec('PRAGMA journal_mode=OFF');
    // Reject legacy JSON lock files and other non-SQLite artifacts; preserve them.
    database.exec('PRAGMA schema_version');
    return database;
  } catch (error) {
    try { database.close(); } catch {}
    throw error;
  }
}
function acquireDatabaseFileLock(databasePath, suffix, label) {
  const lockPath = lockPathFor(databasePath, suffix);
  if (!lockPath) return () => {};

  // The persistent zero-byte SQLite file is only a rendezvous point. The open
  // BEGIN IMMEDIATE transaction, not a pathname record, represents ownership.
  // Never unlink this file: SQLite releases the reservation on close or crash.
  let database;
  try {
    database = openLockDatabase(lockPath);
    database.exec('BEGIN IMMEDIATE');
  } catch (error) {
    try { database?.close(); } catch {}
    if (isBusyError(error)) throw heldError(label, lockPath);
    error.lockPath = lockPath;
    throw error;
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      database.exec('ROLLBACK');
    } finally {
      database.close();
    }
  };
}

export function inspectDatabaseFileLock(lockPath) {
  let stat;
  try { stat = lstatSync(lockPath); }
  catch (error) {
    if (error.code === 'ENOENT') return { path: lockPath, exists: false, kind: null, active: false, error: null };
    return { path: lockPath, exists: null, kind: null, active: null, error: error.code || 'inspection-failed' };
  }
  const kind = stat.isSymbolicLink() ? 'symbolic-link' : stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : 'other';
  if (!stat.isFile()) return { path: lockPath, exists: true, kind, active: null, error: 'not-a-regular-file' };

  let database;
  try {
    database = openLockDatabase(lockPath);
    database.exec('BEGIN IMMEDIATE');
    database.exec('ROLLBACK');
    return { path: lockPath, exists: true, kind: 'sqlite-lock', active: false, error: null };
  } catch (error) {
    if (isBusyError(error)) return { path: lockPath, exists: true, kind: 'sqlite-lock', active: true, error: null };
    return { path: lockPath, exists: true, kind: 'unrecognized-lock-artifact', active: null, error: error.code || error.name || 'inspection-failed' };
  } finally {
    try { database?.close(); } catch {}
  }
}

export function inspectDatabaseRuntimeLocks(databasePath) {
  const database = resolve(databasePath);
  return {
    runtime: inspectDatabaseFileLock(database + '.runtime.lock'),
    maintenance: inspectDatabaseFileLock(database + '.maintenance.lock')
  };
}

export function acquireDatabaseRuntimeLock(databasePath) {
  return acquireDatabaseFileLock(databasePath, '.runtime.lock', 'runtime');
}

export function acquireDatabaseMaintenanceLock(databasePath) {
  return acquireDatabaseFileLock(databasePath, '.maintenance.lock', 'maintenance');
}
