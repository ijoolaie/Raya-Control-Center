import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

function assertDatabaseFile(filename) {
  const path = resolve(filename);
  if (!existsSync(path)) throw new Error('Database file does not exist: ' + path);
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
    if (!Number.isInteger(version) || version < 1 || version > 4)
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
  const source = assertDatabaseFile(databasePath);
  const destination = resolve(backupPath);
  if (source.toLowerCase() === destination.toLowerCase())
    throw new Error('Backup destination must differ from the live database');
  if (existsSync(destination)) throw new Error('Backup destination already exists: ' + destination);
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
    renameSync(temporary, destination);
    return { path: destination, ...metadata };
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

export function restoreDatabaseBackup(backupPath, databasePath) {
  const source = assertDatabaseFile(backupPath);
  const destination = resolve(databasePath);
  if (source.toLowerCase() === destination.toLowerCase())
    throw new Error('Restore source must differ from the live database');
  const metadata = validateSnapshot(source);
  const walPath = destination + '-wal';
  const shmPath = destination + '-shm';
  if (existsSync(walPath) || existsSync(shmPath))
    throw new Error('Database WAL sidecars exist; stop the server and ensure all database connections are closed before restore');
  mkdirSync(dirname(destination), { recursive: true });
  const temporary = resolve(dirname(destination), '.' + basename(destination) + '.' + randomUUID() + '.restore');
  const rollback = destination + '.pre-restore-' + randomUUID();
  copyFileSync(source, temporary);
  let movedOriginal = false;
  try {
    if (existsSync(destination)) {
      renameSync(destination, rollback);
      movedOriginal = true;
    }
    renameSync(temporary, destination);
  } catch (error) {
    rmSync(temporary, { force: true });
    if (movedOriginal && !existsSync(destination)) renameSync(rollback, destination);
    throw error;
  }
  return { path: destination, rollbackPath: movedOriginal ? rollback : null, ...metadata };
}
