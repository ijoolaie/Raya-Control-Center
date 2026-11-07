import { acquireDatabaseRuntimeLock, acquireDatabaseMaintenanceLock } from './database-runtime-lock.js';
import { DatabaseSync } from 'node:sqlite';
import { constants, copyFileSync, linkSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, unlinkSync } from 'node:fs';
import { basename, dirname, parse, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

function pathEntryExists(filename) {
  try { lstatSync(filename); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}


function assertNoSymlinkComponents(filename, label) {
  const absolute = resolve(filename);
  const parsed = parse(absolute);
  const components = absolute.slice(parsed.root.length).split(sep).filter(Boolean);
  let current = parsed.root;
  for (const component of components) {
    current = current ? current + (current.endsWith(sep) ? '' : sep) + component : component;
    let stat;
    try { stat = lstatSync(current); }
    catch (error) {
      if (error.code === 'ENOENT') throw new Error(label + ' path component does not exist: ' + current);
      throw error;
    }
    // On Windows, Node reports directory junctions as symbolic links as well.
    if (stat.isSymbolicLink()) throw new Error(label + ' path must not traverse a symbolic link or junction: ' + current);
  }
  return absolute;
}

function assertRegularFile(filename, label) {
  const path = assertNoSymlinkComponents(filename, label);
  let stat;
  try { stat = lstatSync(path); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error(label + ' does not exist: ' + path);
    throw error;
  }
  if (!stat.isFile()) throw new Error(label + ' must be a regular file: ' + path);
  return path;
}

function validateSnapshot(filename) {
  const db = new DatabaseSync(filename);
  try {
    const integrity = db.prepare('PRAGMA integrity_check').all();
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok')
      throw new Error('SQLite integrity_check failed');
    const violations = db.prepare('PRAGMA foreign_key_check').all();
    if (violations.length) throw new Error('SQLite foreign_key_check found violations');
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (!Number.isInteger(version) || version < 1 || version > 5)
      throw new Error('Unsupported database schema version: ' + version);
    return { schemaVersion: version };
  } finally {
    db.close();
  }
}

function cleanupStaleMaintenanceTemps(directory, baseName, suffix) {
  const prefix = '.' + baseName + '.';
  for (const entry of readdirSync(directory)) {
    if (!entry.startsWith(prefix) || !entry.endsWith(suffix)) continue;
    const token = entry.slice(prefix.length, -suffix.length);
    if (!/^[0-9a-f-]{36}$/i.test(token)) continue;
    const candidate = resolve(directory, entry);
    const stat = lstatSync(candidate);
    // Never follow or remove links/directories during stale-temp cleanup.
    if (stat.isFile() && !stat.isSymbolicLink()) unlinkSync(candidate);
  }
}
function sqlString(value) {
  return "'" + value.replaceAll("'", "''") + "'";
}

function createDatabaseBackupUnlocked(databasePath, backupPath) {
  const source = assertRegularFile(databasePath, 'Database source');
  const destination = resolve(backupPath);
  if (source.toLowerCase() === destination.toLowerCase())
    throw new Error('Backup destination must differ from the live database');
  if (pathEntryExists(destination)) throw new Error('Backup destination already exists: ' + destination);
  mkdirSync(dirname(destination), { recursive: true });
  assertNoSymlinkComponents(dirname(destination), 'Backup destination parent');
  cleanupStaleMaintenanceTemps(dirname(destination), basename(destination), '.tmp');
  const temporary = resolve(dirname(destination), '.' + basename(destination) + '.' + randomUUID() + '.tmp');
  try {
    const db = new DatabaseSync(source);
    try {
      // VACUUM INTO creates a consistent snapshot that includes committed WAL content.
      db.exec('VACUUM INTO ' + sqlString(temporary));
    } finally {
      db.close();
    }
    const metadata = validateSnapshot(temporary);
    if (pathEntryExists(destination)) throw new Error('Backup destination already exists: ' + destination);
    // A same-directory hard link installs the validated snapshot atomically without replacing a raced-in destination.
    linkSync(temporary, destination);
    try { rmSync(temporary, { force: true }); } catch { /* The installed backup is valid; a stale temp link is harmless. */ }
    return { path: destination, ...metadata };
  } catch (error) {
    try { rmSync(temporary, { force: true }); } catch {}
    throw error;
  }
}
function restoreDatabaseBackupUnlocked(backupPath, databasePath) {
  const source = assertRegularFile(backupPath, 'Backup source');
  const destination = resolve(databasePath);
  if (source.toLowerCase() === destination.toLowerCase())
    throw new Error('Restore source must differ from the live database');
  validateSnapshot(source);
  const walPath = destination + '-wal';
  const shmPath = destination + '-shm';
  if (pathEntryExists(walPath) || pathEntryExists(shmPath))
    throw new Error('Database WAL sidecars exist; stop the server and ensure all database connections are closed before restore');
  mkdirSync(dirname(destination), { recursive: true });
  assertNoSymlinkComponents(dirname(destination), 'Restore destination parent');
  cleanupStaleMaintenanceTemps(dirname(destination), basename(destination), '.restore');
  if (pathEntryExists(destination) && !lstatSync(destination).isFile())
    throw new Error('Restore destination must be a regular file');
  const temporary = resolve(dirname(destination), '.' + basename(destination) + '.' + randomUUID() + '.restore');
  const rollback = destination + '.pre-restore-' + randomUUID();
  let movedOriginal = false;
  try {
    copyFileSync(source, temporary, constants.COPYFILE_EXCL);
    // Validate the exact bytes that will be installed, not only the earlier source path.
    const metadata = validateSnapshot(temporary);
    if (pathEntryExists(destination)) {
      if (!lstatSync(destination).isFile()) throw new Error('Restore destination must be a regular file');
      renameSync(destination, rollback);
      movedOriginal = true;
    }
    // linkSync is atomic and fails if another process created the destination; renameSync could overwrite it on POSIX.
    linkSync(temporary, destination);
    try { rmSync(temporary, { force: true }); } catch { /* The installed database is valid; a stale temp link is harmless. */ }
    return { path: destination, rollbackPath: movedOriginal ? rollback : null, ...metadata };
  } catch (error) {
    rmSync(temporary, { force: true });
    if (movedOriginal) {
      if (!pathEntryExists(destination)) {
        try { renameSync(rollback, destination); }
        catch (rollbackError) {
          throw new AggregateError([error, rollbackError], 'Restore failed and automatic rollback could not complete; the original database remains at ' + rollback);
        }
      } else {
        throw new Error('Restore failed because the destination appeared concurrently; the original database remains at ' + rollback, { cause: error });
      }
    }
    throw error;
  }
}

export function createDatabaseBackup(databasePath, backupPath) {
  const source = resolve(databasePath);
  const destination = resolve(backupPath);
  if (source.toLowerCase() === destination.toLowerCase())
    throw new Error('Backup destination must differ from the live database');
  // Serialize by both source database and destination name. The destination lock
  // prevents another source database's cleanup from deleting our active temp file.
  mkdirSync(dirname(destination), { recursive: true });
  assertNoSymlinkComponents(dirname(destination), 'Backup destination parent');
  const releaseSourceLock = acquireDatabaseMaintenanceLock(databasePath);
  let releaseDestinationLock;
  try {
    releaseDestinationLock = acquireDatabaseMaintenanceLock(destination);
    return createDatabaseBackupUnlocked(databasePath, backupPath);
  } finally {
    try { releaseDestinationLock?.(); }
    finally { releaseSourceLock(); }
  }
}

export function restoreDatabaseBackup(backupPath, databasePath) {
  const releaseRuntimeLock = acquireDatabaseRuntimeLock(databasePath);
  let releaseMaintenanceLock;
  try {
    releaseMaintenanceLock = acquireDatabaseMaintenanceLock(databasePath);
    return restoreDatabaseBackupUnlocked(backupPath, databasePath);
  } finally {
    try { releaseMaintenanceLock?.(); }
    finally { releaseRuntimeLock(); }
  }
}
