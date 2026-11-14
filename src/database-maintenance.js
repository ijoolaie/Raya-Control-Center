import { acquireDatabaseReservationSet, canonicalDatabasePath, inspectDatabaseRuntimeLocks } from './database-runtime-lock.js';
import { DatabaseSync } from 'node:sqlite';
import { closeSync, constants, copyFileSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, rmdirSync, chmodSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, parse, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { classifyRestoreRecoveryState } from './restore-recovery-state.js';
import { LATEST_SCHEMA_VERSION } from './db.js';

const UUID_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuidToken = value => UUID_TOKEN.test(value);
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

export function readRestoreJournal(journalPath, read = readFileSync) {
  let text;
  try { text = read(journalPath, 'utf8'); }
  catch (error) { return { status: 'unreadable', error }; }
  try { return { status: 'read', record: JSON.parse(text) }; }
  catch (error) { return { status: 'malformed', error }; }
}
export function inspectDatabaseRestore(databasePath) {
  const destination = resolve(databasePath);
  const journalPath = destination + '.restore-journal.json';
  let unsafeParentError = null;
  try { assertNoSymlinkComponents(dirname(destination), 'Database restore inspection'); }
  catch (error) { unsafeParentError = error; }
  const report = {
    operation: 'restore-inspect', readOnly: true,
    artifactIdentity: { verified: false, method: 'path-based-lstat', limitation: 'Path inspection does not bind names to native file identities; replacement races and same-name substitutions remain unverified.' },
    database: unsafeParentError
      ? { path: destination, exists: null, kind: null, size: null, error: 'unsafe-database-path' }
      : inspectPath(destination),
    locks: inspectDatabaseRuntimeLocks(destination),
    journal: unsafeParentError
      ? { path: journalPath, exists: null, kind: null, size: null, error: 'unsafe-database-path', status: 'unreadable', valid: null, record: null, artifacts: null, artifactInventory: [], orphanedTemporaryFiles: [], orphanedRollbackFiles: [], orphanedRestoreTemporaryFiles: [], artifactInventoryComplete: false, warnings: ['Database parent path traverses a symbolic link or junction. Journal and artifacts were not inspected; no files or locks were changed.'] }
      : { ...inspectPath(journalPath), status: 'absent', valid: null, record: null, artifacts: null, artifactInventory: [], orphanedTemporaryFiles: [], orphanedRollbackFiles: [], orphanedRestoreTemporaryFiles: [], artifactInventoryComplete: null, warnings: [] }
  };
  if (unsafeParentError) {
    report.recovery = classifyRestoreRecoveryState({ journalStatus: 'unreadable', locks: report.locks });
    return report;
  }
  if (report.journal.exists === false) {
    const directory = dirname(journalPath);
    try {
      report.journal.artifactInventory = buildRestoreArtifactInventory(directory, destination, journalPath);
      const inventoryEntries = report.journal.artifactInventory.entries;
      report.journal.orphanedTemporaryFiles = inventoryEntries
        .filter(entry => entry.role === 'journal-temp-candidate')
        .map(entry => entry.path);
      report.journal.orphanedRollbackFiles = inventoryEntries
        .filter(entry => entry.role === 'rollback-candidate')
        .map(({ path, exists, kind, size }) => ({ path, exists, kind, size }));
      report.journal.orphanedRestoreTemporaryFiles = inventoryEntries
        .filter(entry => entry.role === 'restore-stage-candidate')
        .map(({ path, exists, kind, size }) => ({ path, exists, kind, size }));
      report.journal.artifactInventoryComplete = report.journal.artifactInventory.complete && [
        ...report.journal.orphanedRollbackFiles,
        ...report.journal.orphanedRestoreTemporaryFiles
      ].every(artifact => artifact.exists === true);
      if (report.journal.orphanedTemporaryFiles.length) {
        report.journal.warnings.push('Unpublished Restore journal temporary files were found. Preserve them for operator review; their presence does not establish whether Restore began.');
      }
      if (report.journal.orphanedRollbackFiles.length) {
        report.journal.warnings.push('Restore rollback candidates remain without a published journal. Preserve them until the live database has been verified and a separate backup has been created.');
      }
      if (report.journal.orphanedRestoreTemporaryFiles.length) {
        report.journal.warnings.push('Staged Restore files remain without a published journal. Preserve them for operator review; they are not verified backups.');
      }
    } catch (error) {
      if (error.code === 'ENOENT') report.journal.artifactInventoryComplete = false;
      else {
        report.journal.artifactInventoryComplete = false;
        report.journal.warnings.push('Restore recovery artifacts could not be fully enumerated (' + (error.code || error.name) + ').');
      }
    }
    report.recovery = classifyRestoreRecoveryState({
      journalStatus: 'absent', locks: report.locks,
      artifacts: {
        destination: report.database,
        rollback: { exists: report.journal.orphanedRollbackFiles.length ? true : false },
        temporary: { exists: report.journal.orphanedRestoreTemporaryFiles.length ? true : false },
        journalTemporary: { exists: report.journal.orphanedTemporaryFiles.length ? true : false },
        inventoryComplete: report.journal.artifactInventoryComplete
      }
    });
    return report;
  }
  if (report.journal.exists !== true || report.journal.kind !== 'file') {
    report.journal.status = 'unreadable';
    report.journal.warnings.push('Journal path is not a readable regular file; preserve it for operator review.');
    report.recovery = classifyRestoreRecoveryState({ journalStatus: report.journal.status, locks: report.locks });
    return report;
  }
  const journalRead = readRestoreJournal(journalPath);
  if (journalRead.status === 'unreadable') {
    report.journal.status = 'unreadable';
    report.journal.warnings.push('Journal contents could not be read (' + (journalRead.error.code || journalRead.error.name) + '); preserve all artifacts.');
    report.recovery = classifyRestoreRecoveryState({ journalStatus: report.journal.status, locks: report.locks });
    return report;
  }
  if (journalRead.status === 'malformed') {
    report.journal.status = 'malformed';
    report.journal.warnings.push('Journal JSON could not be parsed (' + journalRead.error.name + '); preserve all artifacts.');
    report.recovery = classifyRestoreRecoveryState({ journalStatus: report.journal.status, locks: report.locks });
    return report;
  }
  const record = journalRead.record;
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
  const operationIdValid = record?.version === 2
    ? isUuidToken(record.operationId || '')
      && temporaryToken.toLowerCase() === record.operationId.toLowerCase()
      && rollbackToken.toLowerCase() === record.operationId.toLowerCase()
      && record.temporaryId === record.operationId
      && record.rollbackId === record.operationId
      && record.journalTemporaryId === record.operationId
    : record?.version === 1
      && isUuidToken(temporaryToken)
      && isUuidToken(rollbackToken);
  const validShape = Boolean(record && typeof record === 'object' && !Array.isArray(record)
    && (record.version === 1 || record.version === 2) && record.operation === 'restore' && absolutePaths
    && record.source.toLowerCase() !== recordedDestination.toLowerCase()
    && dirname(record.temporary).toLowerCase() === dirname(recordedDestination).toLowerCase()
    && operationIdValid);
  const destinationMatches = validShape && recordedDestination.toLowerCase() === destination.toLowerCase();
  // A crash after the journal hard link is published but before its temporary
  // hard link is removed leaves both names. Inventory these even when the
  // published journal is valid; inspection must never silently omit evidence.
  try {
    const directory = dirname(journalPath);
    report.journal.artifactInventory = buildRestoreArtifactInventory(directory, destination, journalPath, record);
    report.journal.orphanedTemporaryFiles = report.journal.artifactInventory.entries
      .filter(entry => entry.role === 'journal-temp-candidate')
      .map(entry => entry.path);
    report.journal.artifactInventoryComplete = report.journal.artifactInventory.complete;
    if (report.journal.orphanedTemporaryFiles.length) {
      report.journal.warnings.push('Restore journal temporary hard links remain beside the published journal. Preserve them for operator review; they may contain the same published journal record.');
    }
  } catch (error) {
    report.journal.artifactInventoryComplete = false;
    report.journal.warnings.push('Restore journal temporary artifacts could not be fully enumerated (' + (error.code || error.name) + ').');
  }
  report.journal.record = {
    version: record?.version ?? null, operation: record?.operation ?? null,
    operationId: typeof record?.operationId === 'string' ? record.operationId : null,
    temporaryId: typeof record?.temporaryId === 'string' ? record.temporaryId : null,
    rollbackId: typeof record?.rollbackId === 'string' ? record.rollbackId : null,
    journalTemporaryId: typeof record?.journalTemporaryId === 'string' ? record.journalTemporaryId : null,
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
  report.recovery = classifyRestoreRecoveryState({ journalStatus: report.journal.status, journalValid: report.journal.valid, locks: report.locks, artifacts: { ...(report.journal.artifacts || {}), inventoryComplete: report.journal.artifactInventoryComplete } });
  return report;
}


export function buildRestoreArtifactInventory(directory, destination, journalPath, record = null, fsOps = { readdirSync, lstatSync }) {
  const names = fsOps.readdirSync(directory);
  const maxEntries = 4096;
  const selected = names.slice(0, maxEntries);
  const rollbackPrefix = basename(destination) + '.pre-restore-';
  const stagePrefix = '.' + basename(destination) + '.';
  const journalTemporaryPrefix = basename(journalPath) + '.';
  const expected = new Map([
    [basename(destination), 'live-database'],
    [basename(journalPath), 'journal']
  ]);
  if (record && typeof record === 'object') {
    for (const [key, role] of [['temporary', 'restore-stage'], ['rollback', 'rollback']]) {
      if (typeof record[key] === 'string' && dirname(record[key]) === directory) expected.set(basename(record[key]), role);
    }
  }
  const entries = selected.map(name => {
    const path = resolve(directory, name);
    const token = name.startsWith(rollbackPrefix) ? name.slice(rollbackPrefix.length)
      : name.startsWith(stagePrefix) && name.endsWith('.restore') ? name.slice(stagePrefix.length, -'.restore'.length)
        : name.startsWith(journalTemporaryPrefix) && name.endsWith('.tmp') ? name.slice(journalTemporaryPrefix.length, -'.tmp'.length) : '';
    const candidate = Boolean(token && isUuidToken(token));
    const role = expected.get(name) || (candidate
      ? name.startsWith(rollbackPrefix) ? 'rollback-candidate'
        : name.startsWith(stagePrefix) && name.endsWith('.restore') ? 'restore-stage-candidate' : 'journal-temp-candidate'
      : 'unknown');
    let exists = null;
    let kind = null;
    let size = null;
    let fingerprint = null;
    try {
      const stat = fsOps.lstatSync(path, { bigint: true });
      exists = true;
      kind = stat.isSymbolicLink() ? 'symbolic-link' : stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : 'other';
      size = stat.isFile() ? Number(stat.size) : null;
      fingerprint = [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(':');
    } catch (error) {
      exists = error.code === 'ENOENT' ? false : null;
    }
    return { name, path, role, status: role === 'unknown' ? 'unknown' : candidate && role.endsWith('-candidate') ? 'candidate' : exists === true ? 'present' : 'unavailable', exists, kind, size, identityVerified: false, fingerprint };  });
  // Confirm names and per-entry metadata after pathname inspection to catch ordinary replacement/churn.
  const confirmationNames = fsOps.readdirSync(directory);
  const firstSorted = [...names].sort();
  const confirmationSorted = [...confirmationNames].sort();
  let entriesStable = true;
  for (const entry of entries) {
    try {
      const stat = fsOps.lstatSync(entry.path, { bigint: true });
      const fingerprint = [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(':');
      if (entry.fingerprint === null || fingerprint !== entry.fingerprint) entriesStable = false;
    } catch { entriesStable = false; }
  }
  const namesStable = firstSorted.length === confirmationSorted.length
    && firstSorted.every((name, index) => name === confirmationSorted[index]);
  const stable = namesStable && entriesStable;
  if (!stable) {
    for (const entry of entries) entry.status = 'unstable-inventory';
  }
  for (const entry of entries) delete entry.fingerprint;
  return {
    complete: names.length <= maxEntries && stable,
    stable,
    stabilityMethod: 'two-name-enumerations-plus-entry-metadata-revalidation',
    entryCount: names.length,
    confirmationEntryCount: confirmationNames.length,
    truncated: names.length > maxEntries,
    identityVerified: false,
    entries
  };
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

function snapshotFileObjectIdentity(filename, label) {
  const stat = lstatSync(filename, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error(label + ' must remain a regular non-symbolic-link file: ' + filename);
  return { device: stat.dev, inode: stat.ino };
}

function snapshotFileIdentity(filename) {
  const stat = lstatSync(filename, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error('Restore source must remain a regular non-symbolic-link file: ' + filename);
  return {
    device: stat.dev, inode: stat.ino, size: stat.size,
    modified: stat.mtimeNs, changed: stat.ctimeNs
  };
}

function sameFileObjectIdentity(left, right) {
  return left.device === right.device && left.inode === right.inode;
}

function sameSnapshotFileIdentity(left, right) {
  return left.device === right.device && left.inode === right.inode
    && left.size === right.size && left.modified === right.modified
    && left.changed === right.changed;
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
    if (!Number.isInteger(version) || version < 1 || version > LATEST_SCHEMA_VERSION)
      throw new Error('Unsupported database schema version: ' + version);
    return { schemaVersion: version };
  } finally {
    db.close();
  }
}

function removeBackupTemporaryDirectory(directory) {
  let stat;
  try { stat = lstatSync(directory); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error('Backup temporary path is not an owned regular directory: ' + directory);
  const contents = readdirSync(directory);
  if (contents.length === 1 && contents[0] === 'snapshot.sqlite') {
    const snapshot = resolve(directory, 'snapshot.sqlite');
    const snapshotStat = lstatSync(snapshot);
    if (!snapshotStat.isFile() || snapshotStat.isSymbolicLink())
      throw new Error('Unexpected backup staging snapshot artifact was preserved: ' + snapshot);
    unlinkSync(snapshot);
  } else if (contents.length !== 0) {
    throw new Error('Unexpected backup staging contents were preserved for operator review: ' + directory);
  }
  rmdirSync(directory);
  syncDirectory(dirname(directory));
}

function cleanupStaleMaintenanceTemps(directory, baseName, suffix) {
  const prefix = '.' + baseName + '.';
  let changed = false;
  for (const entry of readdirSync(directory)) {
    if (!entry.startsWith(prefix) || !entry.endsWith(suffix)) continue;
    const token = entry.slice(prefix.length, -suffix.length);
    if (!isUuidToken(token)) continue;
    const candidate = resolve(directory, entry);
    const stat = lstatSync(candidate);
    // Backup staging artifacts are directories. A regular file with the same
    // UUID-shaped name is unexpected evidence, not a stale staging directory.
    // Preserve it for operator review rather than deleting it by filename alone.
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
  const sourceIdentity = snapshotFileObjectIdentity(source, 'Backup source');
  const destination = resolve(backupPath);
  if (source.toLowerCase() === destination.toLowerCase())
    throw new Error('Backup destination must differ from the live database');
  assertNoSymlinkComponents(dirname(destination), 'Backup destination parent');
  mkdirSync(dirname(destination), { recursive: true });
  assertNoSymlinkComponents(dirname(destination), 'Backup destination parent');
  // Reconcile only recognized stale staging directories while holding both
  // source and destination maintenance locks, even when the published backup
  // already exists (for example, after a crash between publication and cleanup).
  cleanupStaleMaintenanceTemps(dirname(destination), basename(destination), '.tmp');
  if (pathEntryExists(destination)) throw new Error('Backup destination already exists: ' + destination);
  const temporaryDirectory = resolve(dirname(destination), '.' + basename(destination) + '.' + randomUUID() + '.tmp');
  const temporary = resolve(temporaryDirectory, 'snapshot.sqlite');
  let temporaryDirectoryCreated = false;
  try {
    mkdirSync(temporaryDirectory, { mode: 0o700 });
    temporaryDirectoryCreated = true;
    if (process.platform !== 'win32') {
      chmodSync(temporaryDirectory, 0o700);
      if ((statSync(temporaryDirectory).mode & 0o777) !== 0o700)
        throw new Error('Backup temporary directory permissions could not be restricted to owner-only access');
    }
    const db = new DatabaseSync(source);
    try {
      // Detect an ordinary path replacement between preflight and SQLite open.
      if (!sameFileObjectIdentity(sourceIdentity, snapshotFileObjectIdentity(source, 'Backup source'))) {
        throw new Error('Backup source changed while opening; refusing to snapshot a different database');
      }
      // Make VACUUM INTO's output durability requirement explicit.
      db.exec('PRAGMA synchronous = FULL');
      if (db.prepare('PRAGMA synchronous').get().synchronous !== 2) throw new Error('SQLite FULL synchronous mode could not be enabled for backup');
      // VACUUM INTO creates a consistent snapshot that includes committed WAL content.
      db.exec('VACUUM INTO ' + sqlString(temporary));
      // Refuse to publish if the selected source path was replaced while the
      // snapshot was being generated. Live writes preserve the same file object.
      if (!sameFileObjectIdentity(sourceIdentity, snapshotFileObjectIdentity(source, 'Backup source'))) {
        throw new Error('Backup source changed while snapshotting; refusing to publish the snapshot');
      }
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
    try { removeBackupTemporaryDirectory(temporaryDirectory); }
    catch (cleanupError) {
      cleanupWarnings.push({ artifact: 'temporary', path: temporary, error: cleanupError.code || cleanupError.name });
    }
    return { path: destination, ...metadata, cleanupWarnings };
  } catch (error) {
    try {
      if (temporaryDirectoryCreated) {
        removeBackupTemporaryDirectory(temporaryDirectory);
      }
    }
    catch (cleanupError) {
      error.cleanupWarnings = [{ artifact: 'temporary', path: temporary, error: cleanupError.code || cleanupError.name }];
    }
    throw error;
  }
}
function createRestoreJournal(journalPath, record, operationId) {
  const temporary = journalPath + '.' + operationId + '.tmp';
  record.journalTemporaryId = operationId;
  let descriptor;
  let temporaryCreated = false;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    temporaryCreated = true;
    writeFileSync(descriptor, JSON.stringify(record, null, 2) + '\n', 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    // Publish the complete, flushed journal atomically without replacing an earlier recovery record.
    linkSync(temporary, journalPath);
    syncDirectory(dirname(journalPath));
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (temporaryCreated) {
      try { unlinkSync(temporary); syncDirectory(dirname(journalPath)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
}

function restoreDatabaseBackupUnlocked(backupPath, databasePath) {
  const source = assertRegularFile(backupPath, 'Backup source');
  const sourceIdentity = snapshotFileIdentity(source);
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
  const restoreTemporaryPrefix = '.' + basename(destination) + '.';
  const orphanedRestoreTemporaries = readdirSync(dirname(destination)).filter(name =>
    name.startsWith(restoreTemporaryPrefix) && name.endsWith('.restore')
    && isUuidToken(name.slice(restoreTemporaryPrefix.length, -'.restore'.length)));
  if (orphanedRestoreTemporaries.length) {
    throw new Error('Orphaned Restore temporary files exist; inspect and preserve them before retrying: '
      + orphanedRestoreTemporaries.map(name => resolve(dirname(destination), name)).join(', '));
  }
  const journalTemporaryPrefix = basename(journalPath) + '.';
  const orphanedJournalTemporaries = readdirSync(dirname(journalPath)).filter(name =>
    name.startsWith(journalTemporaryPrefix) && name.endsWith('.tmp')
    && isUuidToken(name.slice(journalTemporaryPrefix.length, -'.tmp'.length)));
  if (orphanedJournalTemporaries.length) {
    throw new Error('Orphaned Restore journal temporary files exist; inspect and preserve them before retrying: '
      + orphanedJournalTemporaries.map(name => resolve(dirname(journalPath), name)).join(', '));
  }
  if (pathEntryExists(destination) && !lstatSync(destination).isFile())
    throw new Error('Restore destination must be a regular file');
  const operationId = randomUUID();
  const temporaryId = operationId;
  const rollbackId = operationId;
  const temporary = resolve(dirname(destination), '.' + basename(destination) + '.' + temporaryId + '.restore');
  const rollback = destination + '.pre-restore-' + rollbackId;
  let temporaryCreated = false;
  let rollbackPublished = false;
  let movedOriginal = false;
  let installPublished = false;
  let journalCreated = false;
  try {
    createRestoreJournal(journalPath, {
      version: 2,
      operation: 'restore',
      operationId,
      temporaryId,
      rollbackId,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      source,
      destination,
      temporary,
      rollback
    }, operationId);
    journalCreated = true;
    copyFileSync(source, temporary, constants.COPYFILE_EXCL);
    temporaryCreated = true;
    // Bind the validated backup path to the bytes staged for installation.
    // A path replacement or in-place mutation between validation and copy
    // must not silently switch the selected backup.
    if (!sameSnapshotFileIdentity(sourceIdentity, snapshotFileIdentity(source))) {
      throw new Error('Restore source changed during staging; refusing to install a different backup');
    }
    restrictSnapshotPermissions(temporary);
    // Validate the exact bytes that will be installed, not only the earlier source path.
    const metadata = validateSnapshot(temporary);
    // copyFileSync does not provide a durability guarantee; flush staged bytes before moving the live database.
    syncFileContents(temporary);
    if (pathEntryExists(destination)) {
      if (!lstatSync(destination).isFile()) throw new Error('Restore destination must be a regular file');
      // Publish the rollback name with no-replace semantics. renameSync may
      // overwrite an existing target on POSIX; linkSync fails if it exists.
      linkSync(destination, rollback);
      rollbackPublished = true;
      unlinkSync(destination);
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
    if (temporaryCreated) {
      try { unlinkSync(temporary); syncDirectory(dirname(destination)); } catch {}
    }
    let rollbackRestored = false;
    if (movedOriginal && !installPublished) {
      if (!pathEntryExists(destination)) {
        try {
          // Restore the rollback link without replacing a destination that may
          // have appeared concurrently. Flush the restored name before unlinking
          // the redundant rollback link.
          linkSync(rollback, destination);
          syncDirectory(dirname(destination));
          unlinkSync(rollback);
          rollbackRestored = true;
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], 'Restore failed and automatic rollback could not complete; the original database remains at ' + rollback);
        }
      } else {
        throw new Error('Restore failed because the destination appeared concurrently; the original database remains at ' + rollback, { cause: error });
      }
    }
    if (journalCreated && !installPublished && (!rollbackPublished || rollbackRestored)) {
      // Keep the journal if a rollback link was published but the original path
      // could not be removed, or if a concurrent destination blocks rollback.
      try { unlinkSync(journalPath); syncDirectory(dirname(journalPath)); } catch {}
    }
    throw error;
  }
}

function sameCanonicalDatabasePath(left, right) {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

export function createDatabaseBackup(databasePath, backupPath) {
  const source = canonicalDatabasePath(databasePath);
  const destination = canonicalDatabasePath(backupPath);
  if (sameCanonicalDatabasePath(source, destination))
    throw new Error('Backup destination must differ from the live database');

  const guard = acquireDatabaseReservationSet([
    { databasePath: source, lockClass: 'maintenance' },
    { databasePath: destination, lockClass: 'maintenance' }
  ]);
  try {
    guard.assertHeld();
    return createDatabaseBackupUnlocked(databasePath, backupPath);
  } finally {
    guard.release();
  }
}

export function restoreDatabaseBackup(backupPath, databasePath) {
  const source = canonicalDatabasePath(backupPath);
  const destination = canonicalDatabasePath(databasePath);
  if (sameCanonicalDatabasePath(source, destination))
    throw new Error('Restore source must differ from the live database');

  const guard = acquireDatabaseReservationSet([
    { databasePath: destination, lockClass: 'runtime' },
    { databasePath: source, lockClass: 'maintenance' },
    { databasePath: destination, lockClass: 'maintenance' }
  ]);
  try {
    guard.assertHeld();
    return restoreDatabaseBackupUnlocked(backupPath, databasePath);
  } finally {
    guard.release();
  }
}
