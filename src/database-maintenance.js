import { DatabaseSync } from 'node:sqlite';
import { constants, copyFileSync, lstatSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

function pathEntryExists(filename) {
  try { lstatSync(filename); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function assertRegularFile(filename, label) {
  const path = resolve(filename);
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

function sqlString(value) {
  return "'" + value.replaceAll("'", "''") + "'";
}

export function createDatabaseBackup(databasePath, backupPath) {
  const source = assertRegularFile(databasePath, 'Database source');
  const destination = resolve(backupPath);
  if (source.toLowerCase() === destination.toLowerCase())
    throw new Error('Backup destination must differ from the live database');
  if (pathEntryExists(destination)) throw new Error('Backup destination already exists: ' + destination);
  mkdirSync(dirname(destination), { recursive: true });
  const temporary = resolve(dirname(destination), '.' + basename(destination) + '.' + randomUUID() + '.tmp');
  const db = new DatabaseSync(source);
  try {
    // VACUUM INTO creates a consistent snapshot that includes committed WAL content.
    db.exec('VACUUM INTO ' + sqlString(temporary));
  } finally {
    db.close();
  }
  try {
    const metadata = validateSnapshot(temporary);
    if (pathEntryExists(destination)) throw new Error('Backup destination already exists: ' + destination);
    renameSync(temporary, destination);
    return { path: destination, ...metadata };
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

export function restoreDatabaseBackup(backupPath, databasePath) {
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
    renameSync(temporary, destination);
    return { path: destination, rollbackPath: movedOriginal ? rollback : null, ...metadata };
  } catch (error) {
    rmSync(temporary, { force: true });
    if (movedOriginal && !pathEntryExists(destination)) renameSync(rollback, destination);
    throw error;
  }
}
