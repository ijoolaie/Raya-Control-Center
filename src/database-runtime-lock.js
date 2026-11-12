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

export function canonicalDatabasePath(databasePath) {
  if (typeof databasePath !== 'string' || !databasePath || databasePath === ':memory:') {
    throw new Error('A file-backed database path is required for reservations');
  }
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
  return database;
}

export function databaseRuntimeLockPath(databasePath) {
  if (databasePath === ':memory:') return null;
  return canonicalDatabasePath(databasePath) + '.runtime.lock';
}

function lockPathFor(databasePath, suffix) {
  if (databasePath === ':memory:') return null;
  const database = canonicalDatabasePath(databasePath);
  return database + suffix;
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

function acquireDatabaseFileLockAtPath(lockPath, label) {
  if (!lockPath) return () => {};
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

function acquireDatabaseFileLock(databasePath, suffix, label) {
  return acquireDatabaseFileLockAtPath(lockPathFor(databasePath, suffix), label);
}

const LOCK_SUFFIX = Object.freeze({ runtime: '.runtime.lock', maintenance: '.maintenance.lock' });
const LOCK_RANK = Object.freeze({ runtime: 0, maintenance: 1 });

function compareOrdinal(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizedDatabasePath(databasePath) {
  return process.platform === 'win32' ? databasePath.toLowerCase() : databasePath;
}

/**
 * Acquire a complete, deterministically ordered set of per-database reservations.
 * The returned guard owns every lock until release() and never exposes raw callbacks.
 */
export function acquireDatabaseReservationSet(requests) {
  if (!Array.isArray(requests) || requests.length === 0) {
    throw new Error('At least one database reservation is required');
  }

  const unique = new Map();
  for (const request of requests) {
    if (!request || typeof request !== 'object' || !Object.hasOwn(LOCK_SUFFIX, request.lockClass)) {
      throw new Error('Reservation request must specify runtime or maintenance lockClass');
    }
    const databasePath = canonicalDatabasePath(request.databasePath);
    const keyPath = normalizedDatabasePath(databasePath);
    const key = keyPath + String.fromCharCode(0) + request.lockClass;
    if (!unique.has(key)) unique.set(key, {
      databasePath,
      normalizedPath: keyPath,
      lockClass: request.lockClass
    });
  }

  const ordered = [...unique.values()].sort((left, right) =>
    compareOrdinal(left.normalizedPath, right.normalizedPath)
      || LOCK_RANK[left.lockClass] - LOCK_RANK[right.lockClass]
  );

  const releases = [];
  try {
    for (const item of ordered) {
      const lockPath = item.databasePath + LOCK_SUFFIX[item.lockClass];
      releases.push(acquireDatabaseFileLockAtPath(lockPath, item.lockClass));
    }
  } catch (error) {
    const releaseErrors = [];
    for (const release of releases.reverse()) {
      try { release(); } catch (releaseError) { releaseErrors.push(releaseError); }
    }
    if (releaseErrors.length) throw new AggregateError([error, ...releaseErrors], 'Reservation acquisition failed and one or more partial reservations could not be released');
    throw error;
  }

  let released = false;
  return Object.freeze({
    keys: Object.freeze(ordered.map(({ databasePath, lockClass }) => Object.freeze({ databasePath, lockClass }))),
    assertHeld() {
      if (released) throw new Error('Database reservation guard has already been released');
      return true;
    },
    release() {
      if (released) return;
      released = true;
      const errors = [];
      for (const release of [...releases].reverse()) {
        try { release(); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors, 'One or more database reservations could not be released cleanly');
    }
  });
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
  const absolute = resolve(databasePath);
  const parentDirectory = dirname(absolute);
  let database;
  try {
    // Match acquisition's canonical parent path without creating directories.
    // Inspection must fail closed rather than report absent locks through an alias.
    assertNoSymlinkParentComponents(parentDirectory);
    let canonicalParent;
    try { canonicalParent = realpathSync(parentDirectory); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      canonicalParent = parentDirectory;
    }
    database = join(canonicalParent, basename(absolute));
    try {
      if (lstatSync(database).isSymbolicLink()) {
        throw new Error('Symbolic-link database paths are not supported for runtime locking.');
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  } catch (error) {
    const reason = error.code || (error.message.includes('symbolic link') ? 'unsafe-database-path' : 'inspection-failed');
    const unknown = suffix => ({ path: absolute + suffix, exists: null, kind: null, active: null, error: reason });
    return { runtime: unknown('.runtime.lock'), maintenance: unknown('.maintenance.lock') };
  }
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
