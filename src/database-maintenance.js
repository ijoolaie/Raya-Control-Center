import { acquireDatabaseRuntimeLock, acquireDatabaseMaintenanceLock, inspectDatabaseRuntimeLocks } from './database-runtime-lock.js';
import { DatabaseSync } from 'node:sqlite';
import { closeSync, constants, copyFileSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, chmodSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, parse, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { classifyRestoreRecoveryState } from './restore-recovery-state.js';
import { syncDirectory } from './file-system-durability.js';

function pathEntryExists(filename) {
  try { lstatSync(filename); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}


function inspectPath(filename) {
  try {
    const stat = lstatSync(filename);
    return { path: filename, exists: true, kind: stat.isSymbolicLink() ? 'symbolic-link' : stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : 'other', size: stat.isFile() ? stat.size : null };
  } catch (error) {
    if (error.code === 'ENOENT') return { path: filename, exists: false, kind: null, size: null };
    return { path: filename, exists: null, kind: null, size: null, error: error.code || 'inspection-failed' };
  }
}

export function inspectDatabaseRestore(databasePath) {
  const destination = resolve(databasePath);
  const journalPath = destination + '.restore-journal.json';
  let unsafeParentError = null;
  try { assertNoSymlinkComponents(dirname(destination), 'Database restore inspection'); }
  catch (error) { unsafeParentError = error; }
  const report = {
    operation: 'restore-inspect', readOnly: true,
    database: unsafeParentError
      ? { path: destination, exists: null, kind: null, size: null, error: 'unsafe-database-path' }
      : inspectPath(destination),
    locks: inspectDatabaseRuntimeLocks(destination),
    journal: unsafeParentError
      ? { path: journalPath, exists: null, kind: null, size: null, error: 'unsafe-database-path', status: 'unreadable', valid: null, record: null, artifacts: null, orphanedTemporaryFiles: [], warnings: ['Database parent path traverses a symbolic link or junction. Journal and artifacts were not inspected; no files or locks were changed.'] }
      : { ...inspectPath(journalPath), status: 'absent', valid: null, record: null, artifacts: null, orphanedTemporaryFiles: [], warnings: [] }
  };
  if (unsafeParentError) {
    report.recovery = classifyRestoreRecoveryState({ journalStatus: 'unreadable', locks: report.locks });
    return report;
  }  if (!report.journal.exists) {
    try {
      const prefix = basename(journalPath) + '.';
      report.journal.orphanedTemporaryFiles = readdirSync(dirname(journalPath))
        .filter(name => name.startsWith(prefix) && name.endsWith('.tmp')
          && /^[0-9a-f-]{36}$/i.test(name.slice(prefix.length, -'.tmp'.length)))
        .map(name => resolve(dirname(journalPath), name));
      if (report.journal.orphanedTemporaryFiles.length) {
        report.journal.warnings.push('Unpublished Restore journal temporary files were found. Preserve them for operator review; their presence does not establish whether Restore began.');
      }
    } catch (error) {
      report.journal.warnings.push('Restore journal temporary files could not be enumerated (' + (error.code || error.name) + ').');
    }
    report.recovery = classifyRestoreRecoveryState({ journalStatus: 'absent', locks: report.locks, artifacts: { destination: report.database } });
    return report;
  }
  if (report.journal.exists !== true || report.journal.kind !== 'file') {
    report.journal.status = 'unreadable';
    report.journal.warnings.push('Journal path is not a readable regular file; preserve it for operator review.');
    report.recovery = classifyRestoreRecoveryState({ journalStatus: report.journal.status, locks: report.locks });
    return report;
  }
  let record;
  try { record = JSON.parse(readFileSync(journalPath, 'utf8')); }
  catch (error) {
    report.journal.status = 'malformed';
    report.journal.warnings.push('Journal JSON could not be parsed (' + (error.code || error.name) + '); preserve all artifacts.');
    report.recovery = classifyRestoreRecoveryState({ journalStatus: report.journal.status, locks: report.locks });
    return report;
  }
  const required = ['source', 'destination', 'temporary', 'rollback'];
  const absolutePaths = record && required.every(key => typeof record[key] === 'string' && record[key].length > 0 && resolve(record[key]) === record[key]);
  const recordedDestination = absolutePaths ? record.destination : '';
  const temporaryName = record?.temporary ? basename(record.temporary) : '';
  const temporaryPrefix = recordedDestination ? '.' + basename(recordedDestination) + '.' : '';
  const temporaryToken = temporaryName.startsWith(temporaryPrefix) && temporaryName.endsWith('.restore')
    ? temporaryName.slice(temporaryPrefix.length, -'.restore'.length) : '';
  const rollbackPrefix = recordedDestination + '.pre-restore-';
  const rollbackToken = record?.rollback?.toLowerCase().startsWith(rollbackPrefix.toLowerCase())
    ? record.rollback.slice(rollbackPrefix.length) : '';
  const validShape = Boolean(record && typeof record === 'object' && !Array.isArray(record)
    && record.version === 1 && record.operation === 'restore' && absolutePaths
    && record.source.toLowerCase() !== recordedDestination.toLowerCase()
    && dirname(record.temporary).toLowerCase() === dirname(recordedDestination).toLowerCase()
    && /^[0-9a-f-]{36}$/i.test(temporaryToken)
    && /^[0-9a-f-]{36}$/i.test(rollbackToken));
  const destinationMatches = validShape && recordedDestination.toLowerCase() === destination.toLowerCase();
  report.journal.record = {
    version: record?.version ?? null, operation: record?.operation ?? null,
    pid: Number.isSafeInteger(record?.pid) && record.pid > 0 ? record.pid : null,
    startedAt: typeof record?.startedAt === 'string' ? record.startedAt : null,
    source: typeof record?.source === 'string' ? record.source : null,
    destination: typeof record?.destination === 'string' ? record.destination : null,
    temporary: typeof record?.temporary === 'string' ? record.temporary : null,
    rollback: typeof record?.rollback === 'string' ? record.rollback : null
  };
  report.journal.valid = Boolean(validShape && destinationMatches);
  report.journal.status = report.journal.valid ? 'valid' : 'invalid';
  if (!validShape) report.journal.warnings.push('Journal schema, version, operation, or absolute path fields are invalid.');
  if (validShape && !destinationMatches) report.journal.warnings.push('Journal destination does not match the database path supplied to inspect.');
  if (validShape) report.journal.artifacts = {
    source: inspectPath(record.source), destination: inspectPath(record.destination),
    temporary: inspectPath(record.temporary), rollback: inspectPath(record.rollback)
  };
  report.journal.warnings.push('Artifact presence does not establish which database is authoritative. Lock presence does not establish whether its owner is stale. No files or locks were changed.');
  report.recovery = classifyRestoreRecoveryState({ journalStatus: report.journal.status, journalValid: report.journal.valid, locks: report.locks, artifacts: report.journal.artifacts || {} });
  return report;
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
      if (error.code === 'ENOENT') return absolute;
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
    if (!Number.isInteger(version) || version < 1 || version > 6)
      throw new Error('Unsupported database schema version: ' + version);
    return { schemaVersion: version };
  } finally {
    db.close();
  }
}

function cleanupStaleMaintenanceTemps(directory, baseName, suffix) {
  const prefix = '.' + baseName + '.';
  let changed = false;
  for (const entry of readdirSync(directory)) {
    if (!entry.startsWith(prefix) || !entry.endsWith(suffix)) continue;
    const token = entry.slice(prefix.length, -suffix.length);
    if (!/^[0-9a-f-]{36}$/i.test(token)) continue;
    const candidate = resolve(directory, entry);
    const stat = lstatSync(candidate);
    if (stat.isFile() && !stat.isSymbolicLink()) {
      unlinkSync(candidate);
      changed = true;
      continue;
    }
    // Backup temp directories contain only the known snapshot file. Preserve
    // unexpected entries, links, and non-directory artifacts for operator review.
    if (suffix === '.tmp' && stat.isDirectory() && !stat.isSymbolicLink()) {
      const contents = readdirSync(candidate);
      if (contents.length > 1 || (contents.length === 1 && contents[0] !== 'snapshot.sqlite')) continue;
      if (contents.length === 1) {
        const snapshot = resolve(candidate, 'snapshot.sqlite');
        const snapshotStat = lstatSync(snapshot);
        if (!snapshotStat.isFile() || snapshotStat.isSymbolicLink()) continue;
        unlinkSync(snapshot);
      }
      rmdirSync(candidate);
      changed = true;
    }
  }
  if (changed) syncDirectory(directory);
}
function restrictSnapshotPermissions(filename) {
  // POSIX snapshots contain credentials and task data; never publish them with a permissive umask-derived mode.
  // Windows access control is governed by the destination directory ACL and remains an operator responsibility.
  if (process.platform !== 'win32') {
    chmodSync(filename, 0o600);
    const mode = statSync(filename).mode & 0o777;
    if (mode !== 0o600) throw new Error('Snapshot permissions could not be restricted to owner-only access');
  }
}

function syncFileContents(filename) {
  const descriptor = openSync(filename, 'r+');
  try { fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
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
  assertNoSymlinkComponents(dirname(destination), 'Backup destination parent');
  mkdirSync(dirname(destination), { recursive: true });
  assertNoSymlinkComponents(dirname(destination), 'Backup destination parent');
  cleanupStaleMaintenanceTemps(dirname(destination), basename(destination), '.tmp');
  const temporaryDirectory = resolve(dirname(destination), '.' + basename(destination) + '.' + randomUUID() + '.tmp');
  const temporary = resolve(temporaryDirectory, 'snapshot.sqlite');
  try {
    mkdirSync(temporaryDirectory, { mode: 0o700 });
    if (process.platform !== 'win32') {
      chmodSync(temporaryDirectory, 0o700);
      if ((statSync(temporaryDirectory).mode & 0o777) !== 0o700)
        throw new Error('Backup temporary directory permissions could not be restricted to owner-only access');
    }
    const db = new DatabaseSync(source);
    try {
      // Make VACUUM INTO's output durability requirement explicit.
      db.exec('PRAGMA synchronous = FULL');
      if (db.prepare('PRAGMA synchronous').get().synchronous !== 2) throw new Error('SQLite FULL synchronous mode could not be enabled for backup');
      // VACUUM INTO creates a consistent snapshot that includes committed WAL content.
      db.exec('VACUUM INTO ' + sqlString(temporary));
    } finally {
      db.close();
    }
    const metadata = validateSnapshot(temporary);
    restrictSnapshotPermissions(temporary);
    // Flush the completed snapshot file before publishing its directory entry.
    syncFileContents(temporary);
    if (pathEntryExists(destination)) throw new Error('Backup destination already exists: ' + destination);
    // The staging directory is inside the destination directory, keeping publication on the same volume.
    linkSync(temporary, destination);
    try { syncDirectory(dirname(destination)); }
    catch (error) { error.publishedArtifact = destination; throw error; }
    const cleanupWarnings = [];
    try { rmSync(temporaryDirectory, { recursive: true }); syncDirectory(dirname(destination)); }
    catch (cleanupError) {
      cleanupWarnings.push({ artifact: 'temporary', path: temporary, error: cleanupError.code || cleanupError.name });
    }
    return { path: destination, ...metadata, cleanupWarnings };
  } catch (error) {
    try { rmSync(temporaryDirectory, { recursive: true, force: true }); syncDirectory(dirname(destination)); }
    catch (cleanupError) {
      error.cleanupWarnings = [{ artifact: 'temporary', path: temporary, error: cleanupError.code || cleanupError.name }];
    }
    throw error;
  }
}
function createRestoreJournal(journalPath, record) {
  const temporary = journalPath + '.' + randomUUID() + '.tmp';
  let descriptor;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, JSON.stringify(record, null, 2) + '\n', 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    // Publish the complete, flushed journal atomically without replacing an earlier recovery record.
    linkSync(temporary, journalPath);
    syncDirectory(dirname(journalPath));
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try { unlinkSync(temporary); syncDirectory(dirname(journalPath)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
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
  assertNoSymlinkComponents(dirname(destination), 'Restore destination parent');
  mkdirSync(dirname(destination), { recursive: true });
  assertNoSymlinkComponents(dirname(destination), 'Restore destination parent');
  const journalPath = destination + '.restore-journal.json';
  if (pathEntryExists(journalPath)) throw new Error('An interrupted Restore journal already exists; inspect and resolve it before starting another Restore: ' + journalPath);
  cleanupStaleMaintenanceTemps(dirname(destination), basename(destination), '.restore');
  if (pathEntryExists(destination) && !lstatSync(destination).isFile())
    throw new Error('Restore destination must be a regular file');
  const temporary = resolve(dirname(destination), '.' + basename(destination) + '.' + randomUUID() + '.restore');
  const rollback = destination + '.pre-restore-' + randomUUID();
  let movedOriginal = false;
  let installPublished = false;
  let journalCreated = false;
  try {
    createRestoreJournal(journalPath, {
      version: 1,
      operation: 'restore',
      pid: process.pid,
      startedAt: new Date().toISOString(),
      source,
      destination,
      temporary,
      rollback
    });
    journalCreated = true;
    copyFileSync(source, temporary, constants.COPYFILE_EXCL);
    restrictSnapshotPermissions(temporary);
    // Validate the exact bytes that will be installed, not only the earlier source path.
    const metadata = validateSnapshot(temporary);
    // copyFileSync does not provide a durability guarantee; flush staged bytes before moving the live database.
    syncFileContents(temporary);
    if (pathEntryExists(destination)) {
      if (!lstatSync(destination).isFile()) throw new Error('Restore destination must be a regular file');
      renameSync(destination, rollback);
      movedOriginal = true;
      syncDirectory(dirname(destination));
    }
    // linkSync is atomic and fails if another process created the destination; renameSync could overwrite it on POSIX.
    linkSync(temporary, destination);
    installPublished = true;
    syncDirectory(dirname(destination));
    const cleanupWarnings = [];
    try { rmSync(temporary, { force: true }); syncDirectory(dirname(destination)); }
    catch (cleanupError) {
      cleanupWarnings.push({ artifact: 'temporary', path: temporary, error: cleanupError.code || cleanupError.name });
    }
    try { unlinkSync(journalPath); syncDirectory(dirname(journalPath)); }
    catch (cleanupError) {
      cleanupWarnings.push({ artifact: 'journal', path: journalPath, error: cleanupError.code || cleanupError.name });
    }
    return { path: destination, rollbackPath: movedOriginal ? rollback : null, ...metadata, cleanupWarnings };
  } catch (error) {
    try { rmSync(temporary, { force: true }); syncDirectory(dirname(destination)); } catch {}
    if (movedOriginal && !installPublished) {
      if (!pathEntryExists(destination)) {
        try { renameSync(rollback, destination); syncDirectory(dirname(destination)); }
        catch (rollbackError) {
          throw new AggregateError([error, rollbackError], 'Restore failed and automatic rollback could not complete; the original database remains at ' + rollback);
        }
      } else {
        throw new Error('Restore failed because the destination appeared concurrently; the original database remains at ' + rollback, { cause: error });
      }
    }
    if (journalCreated && ((!movedOriginal && !installPublished) || (movedOriginal && !installPublished && pathEntryExists(destination)))) {
      // No rollback decision remains outstanding; otherwise preserve the journal with the rollback file.
      try { unlinkSync(journalPath); syncDirectory(dirname(journalPath)); } catch {}
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
  assertNoSymlinkComponents(dirname(destination), 'Backup destination parent');
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
