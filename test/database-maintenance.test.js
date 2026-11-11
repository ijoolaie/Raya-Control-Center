import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { existsSync, linkSync, mkdirSync, mkdtempSync, chmodSync, statSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LATEST_SCHEMA_VERSION, openDatabase } from '../src/db.js';
import { ControlCenter } from '../src/control-center.js';
import { createDatabaseBackup, inspectDatabaseRestore, restoreDatabaseBackup } from '../src/database-maintenance.js';
import { startControlCenter } from '../src/server-runtime.js';
import { acquireDatabaseMaintenanceLock, inspectDatabaseFileLock, inspectDatabaseRuntimeLocks } from '../src/database-runtime-lock.js';
import { classifyRestoreRecoveryState } from '../src/restore-recovery-state.js';
import { bootstrapOperatorToken, rotateOperatorToken } from '../src/operator-auth.js';
import { recoverOperatorToken } from '../src/rotate-operator-token.js';



test('Restore recovery state model is conservative across observed artifact combinations', () => {
  const artifact = (exists) => ({ exists });
  const base = { journalStatus: 'valid', journalValid: true, locks: {}, artifacts: { source: artifact(true) } };
  const cases = [
    [{ ...base, journalStatus: 'absent' }, 'no-pending-restore'],
    [{ ...base, journalStatus: 'absent', locks: { runtime: artifact(true) } }, 'no-pending-restore-lock-present'],
    [{ ...base, journalStatus: 'absent', artifacts: { destination: artifact(true), rollback: artifact(true) } }, 'no-journal-recovery-artifacts-present'],
    [{ ...base, journalStatus: 'absent', artifacts: { destination: artifact(true), temporary: artifact(true) } }, 'no-journal-recovery-artifacts-present'],
    [{ ...base, journalStatus: 'absent', artifacts: { inventoryComplete: false } }, 'no-pending-restore-artifact-state-unknown'],
    [{ ...base, journalStatus: 'malformed' }, 'manual-review-invalid-journal'],
    [{ ...base, locks: { runtime: artifact(true) } }, 'blocked-lock-present'],
    [{ ...base, artifacts: { ...base.artifacts, destination: artifact(false), rollback: artifact(true), temporary: artifact(true) } }, 'live-missing-rollback-present'],
    [{ ...base, artifacts: { ...base.artifacts, destination: artifact(true), rollback: artifact(true) } }, 'live-and-rollback-present-ambiguous'],
    [{ ...base, artifacts: { ...base.artifacts, destination: artifact(false), rollback: artifact(false), temporary: artifact(true) } }, 'live-and-rollback-missing'],
    [{ ...base, artifacts: { ...base.artifacts, destination: artifact(true), rollback: artifact(false), temporary: artifact(true) } }, 'live-present-temporary-present-no-rollback'],
    [{ ...base, artifacts: { ...base.artifacts, destination: artifact(true), rollback: artifact(false), temporary: artifact(false) } }, 'live-present-no-rollback']
  ];
  for (const [input, expected] of cases) {
    const result = classifyRestoreRecoveryState(input);
    assert.equal(result.state, expected);
    assert.equal(result.automaticAction, 'none');
    assert.ok(result.guidance.length > 0);
  }
});

test('Restore recovery state model fails closed when lock inspection is unknown', () => {
  const unknown = { exists: null, active: null, error: 'unsafe-database-path' };
  const absentJournal = classifyRestoreRecoveryState({ journalStatus: 'absent', locks: { runtime: unknown } });
  assert.equal(absentJournal.state, 'no-pending-restore-lock-state-unknown');
  assert.equal(absentJournal.automaticAction, 'none');

  const validJournal = classifyRestoreRecoveryState({
    journalStatus: 'valid', journalValid: true, locks: { maintenance: unknown },
    artifacts: { destination: { exists: true }, rollback: { exists: false } }
  });
  assert.equal(validJournal.state, 'manual-review-lock-state-unknown');
  assert.equal(validJournal.severity, 'critical');
  assert.equal(validJournal.automaticAction, 'none');
});
test('Restore recovery state model never treats a lock as proof of a live or stale owner', () => {
  const result = classifyRestoreRecoveryState({
    journalStatus: 'valid', journalValid: true, locks: { maintenance: { exists: true } },
    artifacts: { destination: { exists: true }, rollback: { exists: false } }
  });
  assert.equal(result.state, 'blocked-lock-present');
  assert.equal(result.observations.maintenanceLock, true);
  assert.match(result.guidance, /not classified as stale/);
});

test('restore inspect refuses symlinked parent paths before reading recovery journals', () => {
  const directory = mkdtempSync(join(tmpdir(), 'raya-cc-restore-inspect-link-'));
  const realDirectory = join(directory, 'real');
  const linkedDirectory = join(directory, 'linked');
  try {
    mkdirSync(realDirectory);
    symlinkSync(realDirectory, linkedDirectory, process.platform === 'win32' ? 'junction' : 'dir');
    const database = join(linkedDirectory, 'live.sqlite');
    writeFileSync(join(realDirectory, 'live.sqlite.restore-journal.json'), JSON.stringify({
      version: 1, operation: 'restore', source: 'must-not-be-read', destination: database,
      temporary: join(linkedDirectory, '.live.sqlite.11111111-1111-4111-8111-111111111111.restore'),
      rollback: database + '.pre-restore-11111111-1111-4111-8111-111111111111'
    }));
    const report = inspectDatabaseRestore(database);
    assert.equal(report.journal.status, 'unreadable');
    assert.equal(report.journal.record, null);
    assert.equal(report.journal.error, 'unsafe-database-path');
    assert.equal(report.database.exists, null);
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
test('restore inspect does not treat an unreadable journal path as absent', { skip: process.platform === 'win32' || typeof process.getuid !== 'function' || process.getuid() === 0 }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'raya-cc-restore-inspect-unreadable-'));
  const database = join(directory, 'live.sqlite');
  try {
    chmodSync(directory, 0o000);
    const report = inspectDatabaseRestore(database);
    assert.equal(report.journal.exists, null);
    assert.equal(report.journal.status, 'unreadable');
    assert.equal(report.recovery.state, 'manual-review-invalid-journal');
  } finally {
    chmodSync(directory, 0o700);
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('restore inspect reports an absent journal without creating or changing files', () => {
  const directory = mkdtempSync(join(tmpdir(), 'raya-cc-restore-inspect-absent-'));
  const database = join(directory, 'live.sqlite');
  const before = readdirSync(directory);
  try {
    const report = inspectDatabaseRestore(database);
    assert.equal(report.readOnly, true);
    assert.equal(report.journal.status, 'absent');
    assert.equal(report.recovery.state, 'no-pending-restore');
    assert.equal(report.database.exists, false);
    assert.equal(report.journal.artifactInventoryComplete, true);
    assert.deepEqual(report.journal.orphanedRollbackFiles, []);
    assert.deepEqual(report.journal.orphanedRestoreTemporaryFiles, []);
    assert.deepEqual(readdirSync(directory), before);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('restore inspect inventories rollback and staged artifacts when the journal is absent', () => {
  const directory = mkdtempSync(join(tmpdir(), 'raya-cc-restore-inspect-orphans-'));
  const database = join(directory, 'live.sqlite');
  const token = '11111111-1111-4111-8111-111111111111';
  const rollback = database + '.pre-restore-' + token;
  const temporary = join(directory, '.live.sqlite.' + token + '.restore');
  const journalTemporary = database + '.restore-journal.json.' + token + '.tmp';
  try {
    writeFileSync(rollback, 'rollback-evidence');
    writeFileSync(temporary, 'staged-evidence');
    writeFileSync(journalTemporary, 'journal-intent-evidence');
    const before = readdirSync(directory).sort().map(name => [name, readFileSync(join(directory, name), 'base64')]);
    const report = inspectDatabaseRestore(database);
    const after = readdirSync(directory).sort().map(name => [name, readFileSync(join(directory, name), 'base64')]);
    assert.equal(report.journal.status, 'absent');
    assert.equal(report.journal.artifactInventoryComplete, true);
    assert.equal(report.journal.orphanedRollbackFiles.length, 1);
    assert.equal(report.journal.orphanedRollbackFiles[0].path, rollback);
    assert.equal(report.journal.orphanedRestoreTemporaryFiles.length, 1);
    assert.equal(report.journal.orphanedRestoreTemporaryFiles[0].path, temporary);
    assert.equal(report.journal.orphanedTemporaryFiles.length, 1);
    assert.equal(report.journal.orphanedTemporaryFiles[0], journalTemporary);
    assert.equal(report.recovery.state, 'no-journal-recovery-artifacts-present');
    assert.equal(report.recovery.automaticAction, 'none');
    assert.equal(report.recovery.observations.rollback, true);
    assert.equal(report.recovery.observations.temporary, true);
    assert.equal(report.recovery.observations.journalTemporary, true);
    assert.deepEqual(after, before, 'inspection must preserve every orphaned recovery artifact');
  } finally { rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('restore inspect reports valid journal artifacts and is strictly read-only', () => {
  const directory = mkdtempSync(join(tmpdir(), 'raya-cc-restore-inspect-valid-'));
  const database = join(directory, 'live.sqlite');
  const source = join(directory, 'source.sqlite');
  const temporary = join(directory, '.live.sqlite.00000000-0000-4000-8000-000000000000.restore');
  const rollback = database + '.pre-restore-00000000-0000-4000-8000-000000000000';
  const journalPath = database + '.restore-journal.json';
  const record = { version: 1, operation: 'restore', pid: 1234, startedAt: '2026-11-07T10:00:00.000Z', source, destination: database, temporary, rollback };
  try {
    writeFileSync(source, 'source-bytes');
    writeFileSync(temporary, 'temporary-bytes');
    writeFileSync(rollback, 'rollback-bytes');
    writeFileSync(database + '.runtime.lock', '{"pid":1234}');
    writeFileSync(journalPath, JSON.stringify(record));
    const before = readdirSync(directory).sort().map(name => [name, readFileSync(join(directory, name), 'base64')]);
    const report = inspectDatabaseRestore(database);
    const after = readdirSync(directory).sort().map(name => [name, readFileSync(join(directory, name), 'base64')]);
    assert.equal(report.journal.status, 'valid');
    assert.equal(report.recovery.state, 'blocked-lock-present');
    assert.equal(report.journal.record.pid, 1234);
    assert.equal(report.journal.artifacts.source.exists, true);
    assert.equal(report.journal.artifacts.destination.exists, false);
    assert.equal(report.journal.artifacts.temporary.exists, true);
    assert.equal(report.journal.artifacts.rollback.exists, true);
    assert.equal(report.locks.runtime.exists, true);
    assert.deepEqual(after, before, 'inspection must not change names or file contents');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('restore inspect preserves and flags malformed journal JSON', () => {
  const directory = mkdtempSync(join(tmpdir(), 'raya-cc-restore-inspect-malformed-'));
  const database = join(directory, 'live.sqlite');
  const journal = database + '.restore-journal.json';
  try {
    writeFileSync(journal, '{not-json');
    const report = inspectDatabaseRestore(database);
    assert.equal(report.journal.status, 'malformed');
    assert.equal(report.recovery.state, 'manual-review-invalid-journal');
    assert.equal(readFileSync(journal, 'utf8'), '{not-json');
    assert.equal(report.journal.artifacts, null);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('restore inspect flags unsupported journal versions and destination mismatches', () => {
  const directory = mkdtempSync(join(tmpdir(), 'raya-cc-restore-inspect-invalid-'));
  const database = join(directory, 'live.sqlite');
  const otherDatabase = join(directory, 'other.sqlite');
  const journal = database + '.restore-journal.json';
  const base = { version: 1, operation: 'restore', pid: 42, startedAt: '2026-11-07T10:00:00.000Z', source: join(directory, 'source.sqlite'), destination: database, temporary: join(directory, '.live.sqlite.00000000-0000-4000-8000-000000000000.restore'), rollback: database + '.pre-restore-id' };
  try {
    writeFileSync(journal, JSON.stringify({ ...base, version: 2 }));
    assert.equal(inspectDatabaseRestore(database).journal.status, 'invalid');
    writeFileSync(journal, JSON.stringify({ ...base, destination: otherDatabase, temporary: join(directory, '.other.sqlite.00000000-0000-4000-8000-000000000000.restore'), rollback: otherDatabase + '.pre-restore-00000000-0000-4000-8000-000000000000' }));
    const report = inspectDatabaseRestore(database);
    assert.equal(report.journal.status, 'invalid');
    assert.ok(report.journal.warnings.some(warning => warning.includes('does not match')));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('backup cleanup preserves unexpected contents added to its owned staging directory', () => {
  const worker = new URL('../test-support/maintenance-temp-collision-worker.js', import.meta.url);
  const directory = mkdtempSync(join(tmpdir(), 'raya-cc-backup-unexpected-staging-'));
  const database = join(directory, 'source.sqlite');
  const backup = join(directory, 'backup.sqlite');
  const uuid = '88888888-8888-4888-8888-888888888888';
  const temporaryDirectory = join(directory, '.backup.sqlite.' + uuid + '.tmp');
  const unexpected = join(temporaryDirectory, 'unexpected.bin');
  let db;
  try {
    db = openDatabase(database);
    new ControlCenter(db).createTask({ type: 'backup.unexpected.staging' });
    db.close();
    db = null;
    const result = spawnSync(process.execPath, [
      fileURLToPath(worker), 'backup-unexpected-temp-entry', database, backup, JSON.stringify([uuid])
    ], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const outcome = JSON.parse(result.stdout);
    assert.equal(outcome.ok, true);
    assert.equal(outcome.result.cleanupWarnings.length, 1);
    assert.equal(outcome.result.cleanupWarnings[0].artifact, 'temporary');
    assert.equal(outcome.result.cleanupWarnings[0].path, join(temporaryDirectory, 'snapshot.sqlite'));
    assert.equal(existsSync(backup), true, 'the published backup remains available');
    assert.equal(readFileSync(unexpected, 'utf8'), 'preserve-unexpected-entry');
  } finally {
    if (db) db.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('backup retry cleans staging left after a crash immediately following publication', () => {
  const worker = new URL('../test-support/backup-fault-worker.js', import.meta.url);
  const directory = mkdtempSync(join(tmpdir(), 'raya-cc-backup-publish-crash-'));
  const database = join(directory, 'source.sqlite');
  const backup = join(directory, 'backup.sqlite');
  let db;
  try {
    db = openDatabase(database);
    new ControlCenter(db).createTask({ type: 'backup.publish.crash' });
    db.close();
    db = null;

    const crashed = spawnSync(process.execPath, [
      fileURLToPath(worker), database, backup, 'crash-after-publish', ''
    ], { encoding: 'utf8' });
    assert.equal(crashed.status, 91, crashed.stderr);
    assert.equal(existsSync(backup), true, 'the atomically published backup survives worker termination');

    const stagingNames = readdirSync(directory).filter(name =>
      name.startsWith('.backup.sqlite.') && name.endsWith('.tmp'));
    assert.equal(stagingNames.length, 1, 'the crash leaves one staging directory for the published hard link');
    const stagedSnapshot = join(directory, stagingNames[0], 'snapshot.sqlite');
    assert.equal(existsSync(stagedSnapshot), true);

    db = openDatabase(backup);
    assert.equal(new ControlCenter(db).listTasks().some(task => task.type === 'backup.publish.crash'), true,
      'the published backup remains a readable database');
    db.close();
    db = null;

    assert.throws(() => createDatabaseBackup(database, backup), /already exists/,
      'the retry must still refuse to overwrite the published backup');
    assert.equal(existsSync(stagedSnapshot), false,
      'recognized stale staging hard link is cleaned before the existing-destination refusal');
    assert.equal(existsSync(backup), true, 'cleanup must not remove the published backup');
    db = openDatabase(backup);
    assert.equal(new ControlCenter(db).listTasks().some(task => task.type === 'backup.publish.crash'), true);
  } finally {
    if (db) db.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('restore rollback publication never replaces a colliding rollback artifact', () => {
  const worker = new URL('../test-support/maintenance-temp-collision-worker.js', import.meta.url);
  const directory = mkdtempSync(join(tmpdir(), 'raya-cc-restore-rollback-collision-'));
  const database = join(directory, 'live.sqlite');
  const backupSource = join(directory, 'backup-source.sqlite');
  const backup = join(directory, 'backup.sqlite');
  const rollbackUuid = '99999999-9999-4999-8999-999999999999';
  const rollbackCollision = database + '.pre-restore-' + rollbackUuid;
  let db;
  try {
    db = openDatabase(database);
    new ControlCenter(db).createTask({ type: 'rollback.collision.original' });
    db.close();
    db = null;
    db = openDatabase(backupSource);
    new ControlCenter(db).createTask({ type: 'rollback.collision.replacement' });
    db.close();
    db = null;
    createDatabaseBackup(backupSource, backup);
    const result = spawnSync(process.execPath, [
      fileURLToPath(worker), 'restore-rollback-collision', database, backup,
      JSON.stringify(['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', rollbackUuid, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'])
    ], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).ok, false);
    assert.equal(readFileSync(rollbackCollision, 'utf8'), 'preserve-rollback-collision');
    assert.equal(existsSync(database + '.restore-journal.json'), false);
    assert.deepEqual(readdirSync(directory).filter(name => name.startsWith('.live.sqlite.') && name.endsWith('.restore')), []);
    db = openDatabase(database);
    assert.equal(new ControlCenter(db).listTasks().some(task => task.type === 'rollback.collision.original'), true);
  } finally {
    if (db) db.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('maintenance temp collisions never delete artifacts not created by this operation', () => {
  const worker = new URL('../test-support/maintenance-temp-collision-worker.js', import.meta.url);
  const directory = mkdtempSync(join(tmpdir(), 'raya-cc-maintenance-temp-collision-'));
  const backupSource = join(directory, 'backup-source.sqlite');
  const backupDestination = join(directory, 'backup.sqlite');
  const backupUuid = '11111111-1111-4111-8111-111111111111';
  const backupCollisionDirectory = join(directory, '.backup.sqlite.' + backupUuid + '.tmp');
  const backupCollisionMarker = join(backupCollisionDirectory, 'preserve.txt');
  const restoreSource = join(directory, 'restore-source.sqlite');
  const restoreBackup = join(directory, 'restore-backup.sqlite');
  const journalTarget = join(directory, 'journal-target.sqlite');
  const journalUuid = '22222222-2222-4222-8222-222222222222';
  const journalCollision = journalTarget + '.restore-journal.json.' + journalUuid + '.tmp';
  const stagedTarget = join(directory, 'staged-target.sqlite');
  const stagedUuid = '33333333-3333-4333-8333-333333333333';
  const stagedCollision = join(directory, '.staged-target.sqlite.' + stagedUuid + '.restore');
  let db;
  try {
    db = openDatabase(backupSource);
    new ControlCenter(db).createTask({ type: 'temp.collision.backup.source' });
    db.close();
    db = null;
    mkdirSync(backupCollisionDirectory);
    writeFileSync(backupCollisionMarker, 'do-not-delete');
    let result = spawnSync(process.execPath, [
      fileURLToPath(worker), 'backup', backupSource, backupDestination, JSON.stringify([backupUuid])
    ], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).ok, false);
    assert.equal(readFileSync(backupCollisionMarker, 'utf8'), 'do-not-delete');
    assert.equal(existsSync(backupDestination), false);

    db = openDatabase(restoreSource);
    new ControlCenter(db).createTask({ type: 'temp.collision.restore.snapshot' });
    db.close();
    db = null;
    createDatabaseBackup(restoreSource, restoreBackup);

    db = openDatabase(journalTarget);
    new ControlCenter(db).createTask({ type: 'temp.collision.journal.target' });
    db.close();
    db = null;
    writeFileSync(journalCollision, 'preserve-journal-temp');
    result = spawnSync(process.execPath, [
      fileURLToPath(worker), 'restore', journalTarget, restoreBackup,
      JSON.stringify(['44444444-4444-4444-8444-444444444444', '55555555-5555-4555-8555-555555555555', journalUuid])
    ], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).ok, false);
    assert.equal(readFileSync(journalCollision, 'utf8'), 'preserve-journal-temp');
    assert.equal(existsSync(journalTarget + '.restore-journal.json'), false);
    db = openDatabase(journalTarget);
    assert.equal(new ControlCenter(db).listTasks().some(task => task.type === 'temp.collision.journal.target'), true);
    db.close();
    db = null;

    db = openDatabase(stagedTarget);
    new ControlCenter(db).createTask({ type: 'temp.collision.staged.target' });
    db.close();
    db = null;
    result = spawnSync(process.execPath, [
      fileURLToPath(worker), 'restore-stage-collision', stagedTarget, restoreBackup,
      JSON.stringify([stagedUuid, '66666666-6666-4666-8666-666666666666', '77777777-7777-4777-8777-777777777777'])
    ], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).ok, false);
    assert.equal(readFileSync(stagedCollision, 'utf8'), 'preserve-staged-temp');
    assert.equal(existsSync(stagedTarget + '.restore-journal.json'), false);
    db = openDatabase(stagedTarget);
    assert.equal(new ControlCenter(db).listTasks().some(task => task.type === 'temp.collision.staged.target'), true);
  } finally {
    if (db) db.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('SQLite backup captures committed WAL data and restores a validated database', () => {
  const directory = mkdtempSync(join(tmpdir(), 'raya-cc-backup-'));
  const database = join(directory, 'live.sqlite');
  const backup = join(directory, 'backup.sqlite');
  const restored = join(directory, 'restored.sqlite');
  const staleBackupTemp = join(directory, '.backup.sqlite.00000000-0000-4000-8000-000000000000.tmp');
  const unexpectedBackupTemp = join(directory, '.backup.sqlite.00000000-0000-4000-8000-000000000001.tmp');
  const unexpectedBackupFile = join(directory, '.backup.sqlite.00000000-0000-4000-8000-000000000002.tmp');
  const staleRestoreTemp = join(directory, '.restored.sqlite.00000000-0000-4000-8000-000000000000.restore');
  let db;
  try {
    db = openDatabase(database);
    const center = new ControlCenter(db);
    const task = center.createTask({ type: 'backup.snapshot', payload: { committed: true } });
    mkdirSync(staleBackupTemp);
    writeFileSync(join(staleBackupTemp, 'snapshot.sqlite'), 'stale partial backup');
    mkdirSync(unexpectedBackupTemp);
    writeFileSync(join(unexpectedBackupTemp, 'unexpected.bin'), 'preserve for operator review');
    writeFileSync(unexpectedBackupFile, 'unexpected regular-file artifact');
    const backupResult = createDatabaseBackup(database, backup);
    assert.equal(existsSync(staleBackupTemp), false, 'a stale staging directory with only the known snapshot is cleaned');
    assert.equal(existsSync(join(unexpectedBackupTemp, 'unexpected.bin')), true, 'unexpected staging contents are preserved');
    assert.equal(existsSync(unexpectedBackupFile), true, 'unexpected regular-file artifacts are preserved');
    assert.equal(readFileSync(unexpectedBackupFile, 'utf8'), 'unexpected regular-file artifact');
    assert.equal(backupResult.schemaVersion, LATEST_SCHEMA_VERSION);
    if (process.platform !== 'win32') assert.equal(statSync(backup).mode & 0o777, 0o600, 'published backup must be owner-readable/writable only');
    if (process.platform !== 'win32') chmodSync(backup, 0o644); // Simulate an externally supplied backup with permissive mode.
    writeFileSync(staleRestoreTemp, 'stale partial restore');
    assert.throws(() => restoreDatabaseBackup(backup, restored), /Orphaned Restore temporary files exist/);
    const orphanReport = inspectDatabaseRestore(restored);
    assert.equal(orphanReport.recovery.state, 'no-journal-recovery-artifacts-present');
    assert.equal(orphanReport.journal.orphanedRestoreTemporaryFiles.length, 1);
    assert.equal(existsSync(staleRestoreTemp), true, 'Restore must preserve an orphaned staged file until explicit operator review');
    unlinkSync(staleRestoreTemp); // Exact-path cleanup after reviewing the reported artifact.
    const restoreResult = restoreDatabaseBackup(backup, restored);
    assert.equal(existsSync(staleRestoreTemp), false);
    assert.equal(restoreResult.schemaVersion, LATEST_SCHEMA_VERSION);
    if (process.platform !== 'win32') assert.equal(statSync(restored).mode & 0o777, 0o600, 'restored database must retain private file permissions');
    assert.equal(existsSync(restored + '.restore-journal.json'), false, 'successful Restore removes its completed journal');
    const restoredDb = openDatabase(restored);
    assert.deepEqual(new ControlCenter(restoredDb).getTask(task.id).payload, { committed: true });
    restoredDb.close();
    assert.throws(() => createDatabaseBackup(database, backup), /already exists/);
    assert.throws(() => restoreDatabaseBackup(database, database), /must differ/);
  } finally {
    if (db) db.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('Restore rolls credential revocations back; offline recovery and participant re-provisioning invalidate restored credentials', () => {
  const directory = mkdtempSync(join(tmpdir(), 'raya-restore-credential-rollback-'));
  const database = join(directory, 'live.sqlite');
  const backup = join(directory, 'backup.sqlite');
  const originalOperatorToken = 'restore-credential-original-operator-token-123456';
  let db;
  try {
    db = openDatabase(database);
    bootstrapOperatorToken(db, originalOperatorToken);
    const center = new ControlCenter(db);
    const registered = center.registerParticipant({
      displayName: 'restore rollback test worker',
      kind: 'worker',
      scopes: ['tasks:claim']
    });
    const task = center.createTask({ type: 'restore.credential.rollback' });
    const claim = center.claimTask({ participantId: registered.participant.id, token: registered.token });
    assert.equal(claim.task.id, task.id);
    createDatabaseBackup(database, backup);

    // Revoke and rotate after the snapshot; those later security changes are not in it.
    rotateOperatorToken(db);
    center.revokeParticipant(registered.participant.id);
    assert.equal(center.authenticateParticipant(registered.token), null);
    db.close();
    db = null;

    restoreDatabaseBackup(backup, database);
    db = openDatabase(database);
    assert.equal(bootstrapOperatorToken(db, originalOperatorToken).created, false,
      'the pre-snapshot Operator token becomes valid again after Restore');
    const restoredCenter = new ControlCenter(db);
    assert.ok(restoredCenter.authenticateParticipant(registered.token),
      'the pre-snapshot Participant token becomes valid again after Restore');
    assert.equal(restoredCenter.startTask({
      taskId: task.id,
      participantId: registered.participant.id,
      leaseToken: claim.lease.token
    }).status, 'running', 'the pre-snapshot active Lease token is restored too');
    db.close();
    db = null;

    const recoveredOperatorToken = recoverOperatorToken(database);
    assert.notEqual(recoveredOperatorToken, originalOperatorToken);
    db = openDatabase(database);
    assert.throws(() => bootstrapOperatorToken(db, originalOperatorToken), /does not match/);
    assert.equal(bootstrapOperatorToken(db, recoveredOperatorToken).created, false);

    const postRecoveryCenter = new ControlCenter(db);
    postRecoveryCenter.revokeParticipant(registered.participant.id);
    assert.equal(postRecoveryCenter.authenticateParticipant(registered.token), null);
    assert.equal(postRecoveryCenter.getTask(task.id).status, 'blocked');
    assert.throws(() => postRecoveryCenter.startTask({
      taskId: task.id,
      participantId: registered.participant.id,
      leaseToken: claim.lease.token
    }), /lease|participant/i);
  } finally {
    if (db) db.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
test('restore refuses active WAL sidecars and rejects corrupt snapshots', () => {
  const directory = mkdtempSync(join(tmpdir(), 'raya-cc-restore-'));
  const database = join(directory, 'source.sqlite');
  const backup = join(directory, 'backup.sqlite');
  const target = join(directory, 'target.sqlite');
  const corrupt = join(directory, 'corrupt.sqlite');
  let db;
  try {
    db = openDatabase(database);
    new ControlCenter(db).createTask({ type: 'backup.validation' });
    createDatabaseBackup(database, backup);
    db.close();
    db = null;
    writeFileSync(target + '-wal', '');
    assert.throws(() => restoreDatabaseBackup(backup, target), /WAL sidecars/);
    writeFileSync(corrupt, 'not a database');
    assert.throws(() => restoreDatabaseBackup(corrupt, target), /not a database|integrity_check/);
  } finally {
    if (db) db.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});


test('restore rejects directory paths before moving the live database', () => {
  const directory = mkdtempSync(join(tmpdir(), 'raya-cc-restore-directory-'));
  const database = join(directory, 'live.sqlite');
  const backup = join(directory, 'backup.sqlite');
  let db;
  let checkDb;
  try {
    db = openDatabase(database);
    new ControlCenter(db).createTask({ type: 'restore.directory.guard' });
    createDatabaseBackup(database, backup);
    db.close();
    db = null;
    assert.throws(() => restoreDatabaseBackup(directory, join(directory, 'other.sqlite')), /regular file/);
    assert.throws(() => restoreDatabaseBackup(backup, directory), /regular file/);
    checkDb = openDatabase(database);
    assert.equal(checkDb.prepare('SELECT COUNT(*) AS count FROM tasks').get().count, 1);
    checkDb.close();
    checkDb = null;
  } finally {
    if (checkDb) checkDb.close();
    if (db) db.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});


test('restore rejects symlink and junction parent components', () => {
  const directory = mkdtempSync(join(tmpdir(), 'raya-cc-restore-link-'));
  const realDirectory = join(directory, 'real');
  const linkedDirectory = join(directory, 'linked');
  const backup = join(directory, 'backup.sqlite');
  let db;
  try {
    mkdirSync(realDirectory);
    db = openDatabase(join(realDirectory, 'source.sqlite'));
    new ControlCenter(db).createTask({ type: 'restore.link.guard' });
    createDatabaseBackup(join(realDirectory, 'source.sqlite'), backup);
    db.close();
    db = null;
    symlinkSync(realDirectory, linkedDirectory, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => restoreDatabaseBackup(join(linkedDirectory, 'source.sqlite'), join(directory, 'copy.sqlite')), /symbolic link or junction/);
    assert.throws(() => restoreDatabaseBackup(backup, join(linkedDirectory, 'target.sqlite')), /symbolic link or junction/);
    assert.equal(existsSync(join(realDirectory, 'target.sqlite')), false);
    const nestedRestoreTarget = join(linkedDirectory, 'restore-created-by-mistake', 'target.sqlite');
    assert.throws(() => restoreDatabaseBackup(backup, nestedRestoreTarget), /symbolic link or junction/);
    assert.equal(existsSync(join(realDirectory, 'restore-created-by-mistake')), false,
      'Restore must reject a symlink ancestor before creating nested destination directories');
    const nestedBackupTarget = join(linkedDirectory, 'backup-created-by-mistake', 'backup.sqlite');
    assert.throws(() => createDatabaseBackup(join(realDirectory, 'source.sqlite'), nestedBackupTarget), /symbolic link or junction/);
    assert.equal(existsSync(join(realDirectory, 'backup-created-by-mistake')), false,
      'Backup must reject a symlink ancestor before creating nested destination directories');
  } finally {
    if (db) db.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('restore rolls back the original database when atomic installation fails', () => {
  const directory = mkdtempSync(join(tmpdir(), 'raya-cc-restore-rollback-'));
  const database = join(directory, 'live.sqlite');
  const backup = join(directory, 'backup.sqlite');
  let db;
  try {
    db = openDatabase(database);
    const center = new ControlCenter(db);
    center.createTask({ type: 'restore.original.before-snapshot' });
    createDatabaseBackup(database, backup);
    center.createTask({ type: 'restore.original.after-snapshot' });
    db.close();
    db = null;

    const worker = new URL('../test-support/restore-fault-worker.js', import.meta.url);
    const result = spawnSync(process.execPath, [fileURLToPath(worker), 'rollback-success', backup, database], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const outcome = JSON.parse(result.stdout);
    assert.equal(outcome.ok, false);
    assert.match(outcome.message, /injected-install-failure/);
    assert.equal(existsSync(database), true);

    db = openDatabase(database);
    const count = db.prepare('SELECT COUNT(*) AS count FROM tasks').get().count;
    assert.equal(count, 2, 'both pre-restore committed tasks must survive rollback');
    db.close();
    db = null;
  } finally {
    if (db) db.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('restore inspect reports an unpublished fsynced journal temp after process crash', () => {
  const directory = mkdtempSync(join(tmpdir(), 'raya-cc-restore-journal-temp-crash-'));
  const database = join(directory, 'live.sqlite');
  const backup = join(directory, 'backup.sqlite');
  let db;
  try {
    db = openDatabase(database);
    new ControlCenter(db).createTask({ type: 'restore.journal.temp.original' });
    createDatabaseBackup(database, backup);
    db.close();
    db = null;
    const worker = new URL('../test-support/restore-fault-worker.js', import.meta.url);
    const result = spawnSync(process.execPath, [fileURLToPath(worker), 'crash-before-journal-publish', backup, database], { encoding: 'utf8' });
    assert.equal(result.status, 82, result.stderr);
    assert.equal(existsSync(database), true, 'the live database must not have moved before journal publication');
    assert.equal(existsSync(database + '.restore-journal.json'), false);
    const report = inspectDatabaseRestore(database);
    assert.equal(report.journal.status, 'absent');
    assert.equal(report.journal.orphanedTemporaryFiles.length, 1);
    assert.ok(report.journal.warnings.some(warning => warning.includes('Unpublished Restore journal temporary files')));
    assert.equal(report.recovery.automaticAction, 'none');
    assert.equal(existsSync(report.journal.orphanedTemporaryFiles[0]), true, 'inspection must preserve the unpublished journal');
    assert.equal(existsSync(database + '.runtime.lock'), true);
    assert.equal(inspectDatabaseFileLock(database + '.runtime.lock').active, false);
    assert.equal(existsSync(database + '.maintenance.lock'), true);
    assert.equal(inspectDatabaseFileLock(database + '.maintenance.lock').active, false);
  } finally {
    if (db) db.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('restore crash simulation classifies journal publication and staging boundaries', () => {
  const worker = new URL('../test-support/restore-fault-worker.js', import.meta.url);
  const scenarios = [
    { mode: 'crash-after-journal', status: 77, temporary: false, live: true },
    { mode: 'crash-after-stage', status: 76, temporary: true, live: true },
    { mode: 'crash-before-original-move', status: 75, temporary: true, live: true }
  ];
  for (const scenario of scenarios) {
    const directory = mkdtempSync(join(tmpdir(), 'raya-cc-restore-crash-boundary-'));
    const database = join(directory, 'live.sqlite');
    const backup = join(directory, 'backup.sqlite');
    let db;
    try {
      db = openDatabase(database);
      new ControlCenter(db).createTask({ type: 'restore.crash.boundary.original' });
      createDatabaseBackup(database, backup);
      db.close();
      db = null;

      const result = spawnSync(process.execPath, [fileURLToPath(worker), scenario.mode, backup, database], { encoding: 'utf8' });
      assert.equal(result.status, scenario.status, `${scenario.mode}: ${result.stderr}`);
      const journalPath = database + '.restore-journal.json';
      assert.equal(existsSync(journalPath), true, `${scenario.mode} leaves the published journal`);
      const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
      assert.equal(existsSync(database), scenario.live);
      assert.equal(existsSync(journal.temporary), scenario.temporary);
      assert.equal(existsSync(journal.rollback), false);

      const report = inspectDatabaseRestore(database);
      assert.equal(report.journal.status, 'valid');
      if (scenario.mode === 'crash-after-journal') {
        assert.equal(report.journal.orphanedTemporaryFiles.length, 1,
          'inspection must inventory the journal hard link left by a crash after publication');
        assert.equal(existsSync(report.journal.orphanedTemporaryFiles[0]), true,
          'inspection must preserve the journal temporary hard link');
        assert.ok(report.journal.warnings.some(warning => warning.includes('temporary hard links remain')));
      } else {
        assert.deepEqual(report.journal.orphanedTemporaryFiles, []);
      }
      assert.equal(report.recovery.state, scenario.temporary ? 'live-present-temporary-present-no-rollback' : 'live-present-no-rollback');
      assert.equal(report.recovery.automaticAction, 'none');
      assert.equal(report.recovery.observations.live, scenario.live);
      assert.equal(report.recovery.observations.temporary, scenario.temporary);
      assert.equal(report.recovery.observations.rollback, false);
      assert.equal(existsSync(journalPath), true, 'inspection must not mutate the journal');
    } finally {
      if (db) db.close();
      rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }
});
test('restore refuses to delete orphaned staged files when the journal is absent', () => {
  const directory = mkdtempSync(join(tmpdir(), 'raya-cc-restore-orphan-block-'));
  const database = join(directory, 'live.sqlite');
  const backup = join(directory, 'backup.sqlite');
  const orphan = join(directory, '.live.sqlite.11111111-1111-4111-8111-111111111111.restore');
  let db;
  try {
    db = openDatabase(database);
    new ControlCenter(db).createTask({ type: 'restore.orphan.preserve' });
    createDatabaseBackup(database, backup);
    db.close();
    db = null;
    writeFileSync(orphan, 'preserve-this-staged-artifact');
    const original = readFileSync(database, 'base64');
    assert.throws(() => restoreDatabaseBackup(backup, database), /Orphaned Restore temporary files exist/);
    assert.equal(existsSync(orphan), true, 'a retry must not delete the orphaned staged file');
    assert.equal(readFileSync(orphan, 'utf8'), 'preserve-this-staged-artifact');
    assert.equal(readFileSync(database, 'base64'), original, 'a blocked retry must not replace the live database');
    assert.equal(existsSync(database + '.restore-journal.json'), false, 'a blocked retry must not publish a new journal');
    db = openDatabase(database);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tasks').get().count, 1);
  } finally {
    if (db) db.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('restore crash after no-replace rollback link publication preserves both names and journal', () => {
  const directory = mkdtempSync(join(tmpdir(), 'raya-cc-restore-rollback-link-crash-'));
  const database = join(directory, 'live.sqlite');
  const backup = join(directory, 'backup.sqlite');
  let db;
  try {
    db = openDatabase(database);
    new ControlCenter(db).createTask({ type: 'restore.rollback.link.original' });
    createDatabaseBackup(database, backup);
    db.close();
    db = null;
    const worker = new URL('../test-support/restore-fault-worker.js', import.meta.url);
    const result = spawnSync(process.execPath, [fileURLToPath(worker), 'crash-after-rollback-link', backup, database], { encoding: 'utf8' });
    assert.equal(result.status, 74, result.stderr);
    const journalPath = database + '.restore-journal.json';
    assert.equal(existsSync(journalPath), true);
    const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
    assert.equal(existsSync(database), true, 'the original live path remains until the hard-link move is complete');
    assert.equal(existsSync(journal.rollback), true, 'the no-replace rollback link is already published');
    assert.equal(existsSync(journal.temporary), true);
    assert.equal(readFileSync(database, 'base64'), readFileSync(journal.rollback, 'base64'));
    const report = inspectDatabaseRestore(database);
    assert.equal(report.journal.status, 'valid');
    assert.equal(report.recovery.state, 'live-and-rollback-present-ambiguous');
    assert.equal(report.recovery.automaticAction, 'none');
    db = openDatabase(database);
    assert.equal(new ControlCenter(db).listTasks().some(task => task.type === 'restore.rollback.link.original'), true);
  } finally {
    if (db) db.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('restore can recover the original database after a crash between move and install', () => {
  const directory = mkdtempSync(join(tmpdir(), 'raya-cc-restore-crash-gap-'));
  const database = join(directory, 'live.sqlite');
  const backup = join(directory, 'backup.sqlite');
  let db;
  try {
    db = openDatabase(database);
    const center = new ControlCenter(db);
    center.createTask({ type: 'restore.crash.original.one' });
    createDatabaseBackup(database, backup);
    center.createTask({ type: 'restore.crash.original.two' });
    db.close();
    db = null;

    const worker = new URL('../test-support/restore-fault-worker.js', import.meta.url);
    const result = spawnSync(process.execPath, [fileURLToPath(worker), 'crash-after-original-move', backup, database], { encoding: 'utf8' });
    assert.equal(result.status, 78, result.stderr);
    assert.equal(existsSync(database), false, 'the crash window leaves the live path absent');
    const journalPath = database + '.restore-journal.json';
    assert.equal(existsSync(journalPath), true, 'the crash must leave a recovery journal');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
    assert.equal(journal.version, 1);
    assert.equal(journal.destination, database);
    assert.match(journal.rollback, /\.pre-restore-[0-9a-f-]{36}$/i);
    assert.equal(existsSync(journal.temporary), true, 'the journal identifies the staged snapshot');
    const rollbackName = readdirSync(directory).find(name => name.startsWith('live.sqlite.pre-restore-'));
    assert.ok(rollbackName, 'the original database must remain recoverable');
    const rollback = join(directory, rollbackName);
    db = openDatabase(rollback);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tasks').get().count, 2);
    db.close();
    db = null;

    // The child is confirmed exited; remove only its exact stale lock files before recovery.
    assert.throws(() => restoreDatabaseBackup(backup, database), /interrupted Restore journal/);
    assert.equal(existsSync(journal.temporary), true, 'a blocked retry must preserve the staged snapshot');
    renameSync(rollback, database);
    for (const name of readdirSync(directory)) {
      if (name.startsWith('.live.sqlite.') && name.endsWith('.restore')) unlinkSync(join(directory, name));
    }
    db = openDatabase(database);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tasks').get().count, 2);
    db.close();
    db = null;
    unlinkSync(journalPath); // Simulate the operator closing the reviewed recovery record.
  } finally {
    if (db) db.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('restore keeps both installed snapshot and rollback copy if the process crashes after install', () => {
  const directory = mkdtempSync(join(tmpdir(), 'raya-cc-restore-crash-installed-'));
  const database = join(directory, 'live.sqlite');
  const backup = join(directory, 'backup.sqlite');
  let db;
  try {
    db = openDatabase(database);
    const center = new ControlCenter(db);
    center.createTask({ type: 'restore.crash.installed.one' });
    createDatabaseBackup(database, backup);
    center.createTask({ type: 'restore.crash.installed.two' });
    db.close();
    db = null;

    const worker = new URL('../test-support/restore-fault-worker.js', import.meta.url);
    const result = spawnSync(process.execPath, [fileURLToPath(worker), 'crash-after-install', backup, database], { encoding: 'utf8' });
    assert.equal(result.status, 79, result.stderr);
    assert.equal(existsSync(database), true);
    const journalPath = database + '.restore-journal.json';
    assert.equal(existsSync(journalPath), true, 'the post-install crash must leave a recovery journal');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
    assert.equal(journal.destination, database);
    const rollbackName = readdirSync(directory).find(name => name.startsWith('live.sqlite.pre-restore-'));
    assert.ok(rollbackName, 'the pre-restore database must remain available');
    db = openDatabase(database);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tasks').get().count, 1);
    db.close();
    db = openDatabase(join(directory, rollbackName));
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tasks').get().count, 2);
    db.close();
    db = null;

    assert.throws(() => restoreDatabaseBackup(backup, database), /interrupted Restore journal/);
    assert.equal(existsSync(journal.temporary), true, 'a blocked retry must preserve the staged snapshot');
    for (const name of readdirSync(directory)) {
      if (name.startsWith('.live.sqlite.') && name.endsWith('.restore')) unlinkSync(join(directory, name));
    }
    assert.equal(existsSync(database), true, 'the successfully installed database remains in place');
    unlinkSync(journalPath); // Test cleanup after explicitly inspecting both database copies.
  } finally {
    if (db) db.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
test('restore refuses a backup path replaced after validation but before staging', () => {
  const directory = mkdtempSync(join(tmpdir(), 'raya-cc-restore-source-race-'));
  const database = join(directory, 'live.sqlite');
  const backup = join(directory, 'backup.sqlite');
  const replacement = backup + '.replacement';
  let db;
  let replacementDb;
  try {
    db = openDatabase(database);
    const center = new ControlCenter(db);
    center.createTask({ type: 'restore.source.original.one' });
    createDatabaseBackup(database, backup);
    center.createTask({ type: 'restore.source.original.two' });
    db.close();
    db = null;

    replacementDb = new DatabaseSync(replacement);
    replacementDb.exec('PRAGMA user_version = 1; CREATE TABLE replacement_marker (value TEXT NOT NULL); INSERT INTO replacement_marker VALUES (\'different valid database\');');
    replacementDb.close();
    replacementDb = null;

    const worker = new URL('../test-support/restore-fault-worker.js', import.meta.url);
    const result = spawnSync(process.execPath, [fileURLToPath(worker), 'source-replaced-before-copy', backup, database], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const outcome = JSON.parse(result.stdout);
    assert.equal(outcome.ok, false);
    assert.match(outcome.message, /Restore source changed during staging/);
    assert.equal(existsSync(database + '.restore-journal.json'), false,
      'a pre-install source identity mismatch should close the intent journal after safe cleanup');
    assert.equal(existsSync(backup + '.original'), true, 'the originally validated backup remains preserved');
    assert.equal(existsSync(backup), true, 'the replacement path remains untouched for investigation');
    db = openDatabase(database);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tasks').get().count, 2,
      'the live database must remain unchanged when the selected backup path is replaced');
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'replacement_marker'").get().count, 0);
  } finally {
    if (db) db.close();
    if (replacementDb) replacementDb.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('restore cleanup crash boundaries retain artifacts and classify released SQLite locks', () => {
  const worker = new URL('../test-support/restore-fault-worker.js', import.meta.url);
  const scenarios = [
    { mode: 'crash-after-temp-cleanup', status: 80, journal: true, temporary: false, state: 'live-and-rollback-present-ambiguous' },
    { mode: 'crash-after-journal-cleanup', status: 81, journal: false, temporary: false, state: 'no-journal-recovery-artifacts-present' }
  ];
  for (const scenario of scenarios) {
    const directory = mkdtempSync(join(tmpdir(), 'raya-cc-restore-cleanup-crash-'));
    const database = join(directory, 'live.sqlite');
    const backup = join(directory, 'backup.sqlite');
    let db;
    try {
      db = openDatabase(database);
      const center = new ControlCenter(db);
      center.createTask({ type: 'restore.cleanup.original.one' });
      createDatabaseBackup(database, backup);
      center.createTask({ type: 'restore.cleanup.original.two' });
      db.close();
      db = null;
      const result = spawnSync(process.execPath, [fileURLToPath(worker), scenario.mode, backup, database], { encoding: 'utf8' });
      assert.equal(result.status, scenario.status, scenario.mode + ': ' + result.stderr);
      const journalPath = database + '.restore-journal.json';
      assert.equal(existsSync(journalPath), scenario.journal);
      assert.equal(existsSync(database), true, scenario.mode + ' leaves the newly installed database at the live path; stderr=' + result.stderr + '; stdout=' + result.stdout);
      const rollbackName = readdirSync(directory).find(name => name.startsWith('live.sqlite.pre-restore-'));
      assert.ok(rollbackName, 'the original database remains at the rollback path');
      const rollback = join(directory, rollbackName);
      assert.equal(existsSync(database + '.runtime.lock'), true);
      assert.equal(inspectDatabaseFileLock(database + '.runtime.lock').active, false);
      assert.equal(existsSync(database + '.maintenance.lock'), true);
      assert.equal(inspectDatabaseFileLock(database + '.maintenance.lock').active, false);
      if (scenario.journal) {
        const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
        assert.equal(existsSync(journal.temporary), scenario.temporary);
        assert.equal(existsSync(journal.rollback), true);
      }
      const report = inspectDatabaseRestore(database);
      assert.equal(report.recovery.state, scenario.state);
      if (!scenario.journal) assert.equal(report.journal.orphanedRollbackFiles.length, 1);
      assert.equal(report.recovery.automaticAction, 'none');
      assert.equal(report.recovery.observations.live, true);
      assert.equal(report.recovery.observations.rollback, true);
      assert.equal(report.recovery.observations.runtimeLock, false);
      assert.equal(report.recovery.observations.maintenanceLock, false);
      assert.equal(existsSync(journalPath), scenario.journal, 'inspection must not mutate journal state');
      db = openDatabase(database);
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tasks').get().count, 1);
      db.close();
      db = openDatabase(rollback);
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tasks').get().count, 2);
      db.close();
      db = null;
    } finally {
      if (db) db.close();
      rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }
});
test('restore preserves the original rollback file and reports its path if rollback itself fails', () => {
  const directory = mkdtempSync(join(tmpdir(), 'raya-cc-restore-rollback-failure-'));
  const database = join(directory, 'live.sqlite');
  const backup = join(directory, 'backup.sqlite');
  let db;
  try {
    db = openDatabase(database);
    new ControlCenter(db).createTask({ type: 'restore.original.must-survive' });
    createDatabaseBackup(database, backup);
    db.close();
    db = null;

    const worker = new URL('../test-support/restore-fault-worker.js', import.meta.url);
    const result = spawnSync(process.execPath, [fileURLToPath(worker), 'rollback-failure', backup, database], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const outcome = JSON.parse(result.stdout);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.name, 'AggregateError');
    assert.match(outcome.message, /automatic rollback could not complete/);
    assert.ok(outcome.message.includes('.pre-restore-'));
    const rollbackPath = outcome.message.match(/remains at (.+)$/)?.[1];
    assert.ok(rollbackPath, 'error must expose the preserved rollback path');
    assert.equal(existsSync(rollbackPath), true);
    assert.equal(existsSync(database), false);

    db = openDatabase(rollbackPath);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tasks').get().count, 1);
    db.close();
    db = null;
  } finally {
    if (db) db.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('restore preserves the original and journal when a destination appears during installation', () => {
  const directory = mkdtempSync(join(tmpdir(), 'raya-cc-restore-destination-race-'));
  const database = join(directory, 'live.sqlite');
  const backup = join(directory, 'backup.sqlite');
  let db;
  try {
    db = openDatabase(database);
    new ControlCenter(db).createTask({ type: 'restore.destination.race.original' });
    createDatabaseBackup(database, backup);
    new ControlCenter(db).createTask({ type: 'restore.destination.race.current' });
    db.close();
    db = null;

    const worker = new URL('../test-support/restore-fault-worker.js', import.meta.url);
    const result = spawnSync(process.execPath, [fileURLToPath(worker), 'destination-race', backup, database], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const outcome = JSON.parse(result.stdout);
    assert.equal(outcome.ok, false);
    assert.match(outcome.message, /destination appeared concurrently/);
    assert.ok(outcome.message.includes('.pre-restore-'));
    assert.equal(existsSync(database), true);
    assert.equal(readFileSync(database, 'utf8'), 'concurrent destination', 'Restore must not overwrite a raced-in destination');
    const rollbackPath = outcome.message.match(/original database remains at (.+)$/)?.[1];
    assert.ok(rollbackPath);
    assert.equal(existsSync(rollbackPath), true, 'the pre-restore database remains preserved');
    assert.equal(existsSync(database + '.restore-journal.json'), true, 'the pending operation evidence remains published');
    const report = inspectDatabaseRestore(database);
    assert.equal(report.journal.status, 'valid');
    assert.equal(report.journal.artifacts.rollback.exists, true);
    assert.equal(report.recovery.automaticAction, 'none');
  } finally {
    if (db) db.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('restore reports successful installation when journal cleanup fails', () => {
  const directory = mkdtempSync(join(tmpdir(), 'raya-cc-restore-journal-cleanup-failure-'));
  const database = join(directory, 'live.sqlite');
  const backup = join(directory, 'backup.sqlite');
  let db;
  try {
    db = openDatabase(database);
    new ControlCenter(db).createTask({ type: 'restore.journal.cleanup.original' });
    createDatabaseBackup(database, backup);
    new ControlCenter(db).createTask({ type: 'restore.journal.cleanup.current' });
    db.close();
    db = null;

    const worker = new URL('../test-support/restore-fault-worker.js', import.meta.url);
    const result = spawnSync(process.execPath, [fileURLToPath(worker), 'journal-cleanup-failure', backup, database], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const outcome = JSON.parse(result.stdout);
    assert.equal(outcome.ok, true);
    assert.equal(outcome.result.schemaVersion, LATEST_SCHEMA_VERSION);
    assert.equal(outcome.result.cleanupWarnings.length, 2);
    assert.deepEqual(outcome.result.cleanupWarnings.map(({ artifact, error }) => ({ artifact, error })), [
      { artifact: 'temporary', error: 'EBUSY' },
      { artifact: 'journal', error: 'EIO' }
    ]);
    assert.ok(outcome.result.cleanupWarnings[0].path.includes('.live.sqlite.'));
    assert.ok(outcome.result.cleanupWarnings[0].path.endsWith('.restore'));
    assert.equal(outcome.result.cleanupWarnings[1].path, database + '.restore-journal.json');
    assert.equal(existsSync(database), true, 'the installed database remains live');
    assert.equal(existsSync(database + '.restore-journal.json'), true, 'the failed cleanup preserves the journal');
    assert.equal(existsSync(outcome.result.cleanupWarnings[0].path), true, 'the failed temporary cleanup preserves its staged hard link');
    assert.equal(existsSync(outcome.result.rollbackPath), true, 'the original database remains available as rollback');
    const report = inspectDatabaseRestore(database);
    assert.equal(report.journal.status, 'valid');
    assert.equal(report.journal.artifacts.destination.exists, true);
    assert.equal(report.journal.artifacts.rollback.exists, true);
    assert.equal(report.journal.artifacts.temporary.exists, true);
    assert.equal(report.recovery.automaticAction, 'none');
    db = openDatabase(database);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tasks').get().count, 1);
    db.close();
    db = null;
  } finally {
    if (db) db.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
test('backup is allowed during runtime; restore is locked out until graceful shutdown', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'raya-cc-runtime-maintenance-'));
  const database = join(directory, 'live.sqlite');
  const backup = join(directory, 'active-backup.sqlite');
  const operatorToken = 'runtime-maintenance-operator-token-123456789';
  let runtime;
  let writer;
  let checkDb;
  try {
    runtime = await startControlCenter({ databasePath: database, port: 0, operatorToken });
    assert.equal(existsSync(database + '.runtime.lock'), true);
    assert.equal(inspectDatabaseFileLock(database + '.runtime.lock').active, true);

    writer = openDatabase(database);
    const task = new ControlCenter(writer).createTask({ type: 'maintenance.active.snapshot', payload: { from: 'runtime' } });
    writer.close();
    writer = null;

    const result = createDatabaseBackup(database, backup);
    assert.equal(result.schemaVersion, LATEST_SCHEMA_VERSION);
    assert.equal(inspectDatabaseFileLock(database + '.maintenance.lock').active, false);
    assert.throws(() => restoreDatabaseBackup(backup, database), /runtime lock prevents access/);
    assert.equal(existsSync(database + '.runtime.lock'), true);
    assert.equal(inspectDatabaseFileLock(database + '.runtime.lock').active, true);

    await runtime.shutdown();
    runtime = null;
    assert.equal(inspectDatabaseFileLock(database + '.runtime.lock').active, false);

    const restored = restoreDatabaseBackup(backup, database);
    assert.equal(restored.schemaVersion, LATEST_SCHEMA_VERSION);
    checkDb = openDatabase(database);
    assert.deepEqual(new ControlCenter(checkDb).getTask(task.id).payload, { from: 'runtime' });
    checkDb.close();
    checkDb = null;
    assert.equal(inspectDatabaseFileLock(database + '.runtime.lock').active, false);
    assert.equal(inspectDatabaseFileLock(database + '.maintenance.lock').active, false);
  } finally {
    if (writer) writer.close();
    if (checkDb) checkDb.close();
    if (runtime?.server.listening) await runtime.shutdown();
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('maintenance lock excludes concurrent backup and restore operations', () => {
  const directory = mkdtempSync(join(tmpdir(), 'raya-cc-maintenance-lock-'));
  const database = join(directory, 'live.sqlite');
  const backup = join(directory, 'backup.sqlite');
  let db;
  let release;
  try {
    db = openDatabase(database);
    new ControlCenter(db).createTask({ type: 'maintenance.lock.guard' });
    db.close();
    db = null;
    createDatabaseBackup(database, backup);

    release = acquireDatabaseMaintenanceLock(database);
    assert.throws(() => createDatabaseBackup(database, join(directory, 'second-backup.sqlite')), /maintenance lock prevents access/);
    assert.throws(() => restoreDatabaseBackup(backup, database), /maintenance lock prevents access/);
    assert.equal(inspectDatabaseFileLock(database + '.runtime.lock').active, false);
  } finally {
    release?.();
    if (db) db.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('SQLite runtime lock is exclusive across processes and releases automatically after process death', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'raya-cc-sqlite-lock-process-'));
  const database = join(directory, 'live.sqlite');
  const lockPath = database + '.maintenance.lock';
  let child;
  let release;
  try {
    const worker = new URL('../test-support/runtime-lock-crash-worker.js', import.meta.url);
    child = spawn(process.execPath, [fileURLToPath(worker), 'hold', database], { stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => {
      let output = '';
      child.stdout.on('data', chunk => {
        output += chunk.toString();
        if (output.includes('LOCKED')) resolve();
      });
      child.once('error', reject);
      child.once('exit', code => { if (code !== null) reject(new Error('lock holder exited before acquiring lock: ' + code)); });
    });

    assert.equal(inspectDatabaseFileLock(lockPath).active, true);
    assert.throws(() => acquireDatabaseMaintenanceLock(database), /maintenance lock prevents access/);

    child.kill('SIGKILL');
    await new Promise(resolve => child.once('exit', resolve));
    child = null;
    assert.equal(inspectDatabaseFileLock(lockPath).active, false, 'SQLite must release the OS lock after process death');
    release = acquireDatabaseMaintenanceLock(database);
    assert.equal(inspectDatabaseFileLock(lockPath).active, true);
  } finally {
    release?.();
    if (child) { child.kill('SIGKILL'); await new Promise(resolve => child.once('exit', resolve)); }
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('simultaneous process contenders produce exactly one SQLite lock owner', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'raya-cc-lock-contention-'));
  const database = join(directory, 'live.sqlite');
  const lockPath = database + '.maintenance.lock';
  const children = [];
  try {
    const worker = fileURLToPath(new URL('../test-support/runtime-lock-crash-worker.js', import.meta.url));
    for (let index = 0; index < 8; index++) {
      children.push(spawn(process.execPath, [worker, 'contend', database], { stdio: ['ignore', 'pipe', 'pipe'] }));
    }
    const outcomes = await Promise.all(children.map(child => new Promise((resolve, reject) => {
      let output = '';
      child.stdout.on('data', chunk => {
        output += chunk.toString();
        if (output.includes('\n')) resolve(output.trim());
      });
      child.stderr.on('data', chunk => { output += chunk.toString(); });
      child.once('error', reject);
      child.once('exit', code => {
        if (!output.includes('\n')) {
          if (code === 0 && output.trim() === 'BLOCKED') resolve('BLOCKED');
          else reject(new Error('contender exited before reporting an outcome: ' + code + ' ' + output));
        }
      });
    })));
    assert.equal(outcomes.filter(value => value === 'LOCKED').length, 1, JSON.stringify(outcomes));
    assert.equal(outcomes.filter(value => value === 'BLOCKED').length, 7, JSON.stringify(outcomes));
    assert.equal(inspectDatabaseFileLock(lockPath).active, true);
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
    await Promise.all(children.filter(child => child.exitCode === null).map(child => new Promise(resolve => child.once('exit', resolve))));
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  assert.equal(inspectDatabaseFileLock(lockPath).exists, false);
});
test('restore inspection probes an idle SQLite sidecar without changing its files', () => {
  const directory = mkdtempSync(join(tmpdir(), 'raya-cc-lock-inspect-readonly-'));
  const database = join(directory, 'live.sqlite');
  const lockPath = database + '.maintenance.lock';
  let release;
  try {
    release = acquireDatabaseMaintenanceLock(database);
    release();
    release = null;
    const beforeNames = readdirSync(directory).sort();
    const beforeBytes = readFileSync(lockPath);
    const report = inspectDatabaseRestore(database);
    assert.equal(report.locks.maintenance.exists, true);
    assert.equal(readFileSync(lockPath).length, 0, 'lock sidecar remains an empty rendezvous file');
    assert.equal(report.locks.maintenance.active, false);
    assert.equal(report.recovery.observations.maintenanceLock, false);
    assert.deepEqual(readdirSync(directory).sort(), beforeNames);
    assert.deepEqual(readFileSync(lockPath), beforeBytes);
    assert.equal(existsSync(lockPath + '-journal'), false);
  } finally {
    release?.();
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
test('runtime lock inspection fails closed for symlinked database parent paths', () => {
  const directory = mkdtempSync(join(tmpdir(), 'raya-cc-lock-inspect-link-'));
  const realDirectory = join(directory, 'real');
  const linkedDirectory = join(directory, 'linked');
  const database = join(realDirectory, 'live.sqlite');
  let release;
  try {
    mkdirSync(realDirectory);
    symlinkSync(realDirectory, linkedDirectory, process.platform === 'win32' ? 'junction' : 'dir');
    release = acquireDatabaseMaintenanceLock(database);
    const report = inspectDatabaseRuntimeLocks(join(linkedDirectory, 'live.sqlite'));
    assert.equal(report.maintenance.exists, null);
    assert.equal(report.maintenance.active, null);
    assert.equal(report.maintenance.error, 'unsafe-database-path');
    assert.equal(report.runtime.exists, null);
    const restoreReport = inspectDatabaseRestore(join(linkedDirectory, 'live.sqlite'));
    assert.equal(restoreReport.journal.status, 'unreadable');
    assert.equal(restoreReport.recovery.automaticAction, 'none');
    assert.equal(restoreReport.recovery.automaticAction, 'none');
    assert.equal(existsSync(database + '.maintenance.lock'), true);
  } finally {
    release?.();
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
test('runtime lock rejects a symbolic-link sidecar without following its target', () => {
  const directory = mkdtempSync(join(tmpdir(), 'raya-cc-lock-symlink-'));
  const database = join(directory, 'live.sqlite');
  const lockPath = database + '.maintenance.lock';
  const targetPath = join(directory, 'operator-target');
  try {
    mkdirSync(targetPath);
    symlinkSync(targetPath, lockPath, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => acquireDatabaseMaintenanceLock(database), /zero-byte regular non-symbolic-link/);
    assert.equal(existsSync(targetPath), true);
    assert.equal(inspectDatabaseFileLock(lockPath).kind, 'symbolic-link');
    assert.equal(inspectDatabaseFileLock(lockPath).active, null);
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
test('runtime lock rejects a hard-linked sidecar without modifying either path', () => {
  const directory = mkdtempSync(join(tmpdir(), 'raya-cc-lock-hardlink-'));
  const database = join(directory, 'live.sqlite');
  const lockPath = database + '.maintenance.lock';
  const aliasPath = join(directory, 'attacker-controlled-alias');
  try {
    writeFileSync(aliasPath, Buffer.alloc(0));
    linkSync(aliasPath, lockPath);
    assert.throws(() => acquireDatabaseMaintenanceLock(database), /exactly one hard link/);
    assert.equal(existsSync(aliasPath), true);
    assert.equal(existsSync(lockPath), true);
    assert.equal(readFileSync(aliasPath).length, 0);
    assert.equal(inspectDatabaseFileLock(lockPath).active, null);
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
test('legacy JSON lock artifacts are rejected and preserved for operator review', () => {
  const directory = mkdtempSync(join(tmpdir(), 'raya-cc-legacy-lock-'));
  const database = join(directory, 'live.sqlite');
  const lockPath = database + '.maintenance.lock';
  const legacy = { pid: process.pid, startedAt: new Date().toISOString() };
  try {
    writeFileSync(lockPath, JSON.stringify(legacy) + String.fromCharCode(10), 'utf8');
    assert.throws(() => acquireDatabaseMaintenanceLock(database), error => {
      assert.equal(error.lockPath, lockPath);
      return /not a database|file is not a database|malformed|zero-byte regular/i.test(error.message);
    });
    assert.deepEqual(JSON.parse(readFileSync(lockPath, 'utf8')), legacy, 'legacy lock evidence must not be overwritten');
    const status = inspectDatabaseFileLock(lockPath);
    assert.equal(status.exists, true);
    assert.equal(status.active, null);
    assert.equal(status.kind, 'unrecognized-lock-artifact');
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('runtime lock crash releases the SQLite reservation without deleting its persistent artifact', () => {
  const directory = mkdtempSync(join(tmpdir(), 'raya-cc-lock-crash-'));
  const database = join(directory, 'live.sqlite');
  const lockPath = database + '.maintenance.lock';
  try {
    const worker = new URL('../test-support/runtime-lock-crash-worker.js', import.meta.url);
    const result = spawnSync(process.execPath, [fileURLToPath(worker), 'crash', database], { encoding: 'utf8' });
    assert.notEqual(result.status, 0, 'worker must be killed while holding its transaction');
    assert.equal(existsSync(lockPath), true, 'the stable SQLite lock database remains on disk');
    assert.equal(inspectDatabaseFileLock(lockPath).active, false, 'the dead process no longer owns the SQLite reservation');
    assert.equal(existsSync(lockPath + '-journal'), false, 'journal_mode=OFF prevents a hot rollback journal after process death');
    const release = acquireDatabaseMaintenanceLock(database);
    release();
    assert.equal(inspectDatabaseFileLock(lockPath).active, false);
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
test('backup destination lock serializes backups across processes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'raya-cc-backup-cross-process-'));
  const firstDatabase = join(directory, 'first.sqlite');
  const destination = join(directory, 'shared-backup.sqlite');
  const marker = join(directory, '.shared-backup.sqlite.00000000-0000-4000-8000-000000000000.tmp');
  let first;
  let child;
  try {
    first = openDatabase(firstDatabase);
    new ControlCenter(first).createTask({ type: 'backup.destination.cross-process' });
    first.close();
    first = null;

    const worker = new URL('../test-support/backup-lock-holder.js', import.meta.url);
    child = spawn(process.execPath, [fileURLToPath(worker), destination, marker], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { output += chunk; });
    const [ready] = await once(child.stdout, 'data');
    assert.match(String(ready), /ready/);
    assert.equal(existsSync(marker), true);

    assert.throws(() => createDatabaseBackup(firstDatabase, destination), /maintenance lock prevents access/);
    assert.equal(existsSync(marker), true, 'a competing backup must not clean another process active temp file');
    assert.equal(existsSync(destination), false);

    child.stdin.end('release');
    const [code] = await once(child, 'exit');
    assert.equal(code, 0, output);
    child = null;
    assert.equal(inspectDatabaseFileLock(destination + '.maintenance.lock').active, false);
  } finally {
    if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited.catch(() => {}); }
    if (first) first.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('backup crash releases its SQLite reservation and leaves the orphaned temp for normal cleanup', () => {
  const directory = mkdtempSync(join(tmpdir(), 'raya-cc-backup-crash-recovery-'));
  const database = join(directory, 'source.sqlite');
  const destination = join(directory, 'backup.sqlite');
  const marker = join(directory, '.backup.sqlite.00000000-0000-4000-8000-000000000000.tmp');
  let db;
  try {
    db = openDatabase(database);
    new ControlCenter(db).createTask({ type: 'backup.crash.recovery' });
    db.close();
    db = null;

    const worker = new URL('../test-support/backup-crash-worker.js', import.meta.url);
    const result = spawnSync(process.execPath, [fileURLToPath(worker), destination, marker], { encoding: 'utf8' });
    assert.notEqual(result.status, 0, result.stderr);
    assert.equal(existsSync(destination + '.maintenance.lock'), true, 'persistent lock database remains');
    assert.equal(inspectDatabaseFileLock(destination + '.maintenance.lock').active, false, 'crashed owner no longer holds SQLite reservation');
    assert.equal(existsSync(destination + '.maintenance.lock-journal'), false, 'lock crash must not leave a rollback journal');
    assert.equal(existsSync(marker), true);

    const backup = createDatabaseBackup(database, destination);
    assert.equal(backup.schemaVersion, LATEST_SCHEMA_VERSION);
    assert.equal(existsSync(destination), true);
    assert.equal(existsSync(marker), false, 'normal maintenance cleanup may remove the orphaned temporary after acquiring the lock');
  } finally {
    if (db) db.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});test('backup destination lock serializes backups from different source databases', () => {
  const directory = mkdtempSync(join(tmpdir(), 'raya-cc-backup-destination-lock-'));
  const firstDatabase = join(directory, 'first.sqlite');
  const secondDatabase = join(directory, 'second.sqlite');
  const destination = join(directory, 'shared-backup.sqlite');
  let first;
  let second;
  let release;
  try {
    first = openDatabase(firstDatabase);
    new ControlCenter(first).createTask({ type: 'backup.destination.first' });
    first.close();
    first = null;
    second = openDatabase(secondDatabase);
    new ControlCenter(second).createTask({ type: 'backup.destination.second' });
    second.close();
    second = null;

    // Model another process that owns this exact destination while producing a temp snapshot.
    release = acquireDatabaseMaintenanceLock(destination);
    assert.throws(
      () => createDatabaseBackup(firstDatabase, destination),
      /maintenance lock prevents access/
    );
    assert.equal(existsSync(destination), false);
    assert.equal(
      readdirSync(directory).some(name => name.startsWith('.shared-backup.sqlite.') && name.endsWith('.tmp')),
      false
    );
  } finally {
    release?.();
    first?.close();
    second?.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('backup does not overwrite a destination created after preflight validation', () => {
  const directory = mkdtempSync(join(tmpdir(), 'raya-cc-backup-destination-race-'));
  const database = join(directory, 'source.sqlite');
  const backup = join(directory, 'backup.sqlite');
  let db;
  try {
    db = openDatabase(database);
    new ControlCenter(db).createTask({ type: 'backup.destination.race' });
    db.close();
    db = null;

    const worker = new URL('../test-support/backup-fault-worker.js', import.meta.url);
    const result = spawnSync(process.execPath, [fileURLToPath(worker), database, backup, 'destination-race'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const outcome = JSON.parse(result.stdout);
    assert.equal(outcome.ok, false);
    assert.equal(existsSync(backup), true);
    assert.equal(readFileSync(backup, 'utf8'), 'concurrent destination', 'atomic hard-link publication must not replace the raced-in file');
    assert.deepEqual(readdirSync(directory).filter(name => name.startsWith('.backup.sqlite.') && name.endsWith('.tmp')), []);
    assert.equal(inspectDatabaseFileLock(database + '.maintenance.lock').active, false);
    assert.equal(inspectDatabaseFileLock(backup + '.maintenance.lock').active, false);
  } finally {
    if (db) db.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('backup refuses a source path replaced between preflight and SQLite open', () => {
  const directory = mkdtempSync(join(tmpdir(), 'raya-cc-backup-source-race-'));
  const database = join(directory, 'source.sqlite');
  const backup = join(directory, 'backup.sqlite');
  const replacement = database + '.replacement';
  let db;
  let replacementDb;
  try {
    db = openDatabase(database);
    new ControlCenter(db).createTask({ type: 'backup.source.original' });
    db.close();
    db = null;

    replacementDb = new DatabaseSync(replacement);
    replacementDb.exec("PRAGMA user_version = 1; CREATE TABLE replacement_marker (value TEXT NOT NULL); INSERT INTO replacement_marker VALUES ('different valid database');");
    replacementDb.close();
    replacementDb = null;

    const worker = new URL('../test-support/backup-fault-worker.js', import.meta.url);
    const result = spawnSync(process.execPath, [fileURLToPath(worker), database, backup, 'source-replaced-before-open'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const outcome = JSON.parse(result.stdout);
    assert.equal(outcome.ok, false);
    assert.match(outcome.message, /Backup source changed while opening/);
    assert.equal(existsSync(backup), false, 'a snapshot of the replacement database must not be published');
    assert.equal(existsSync(database + '.original'), true, 'the originally selected source file remains preserved');
    assert.equal(existsSync(database), true, 'the replacement path remains untouched for investigation');
    db = openDatabase(database + '.original');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tasks').get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'replacement_marker'").get().count, 0);
  } finally {
    if (db) db.close();
    if (replacementDb) replacementDb.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('backup remains a transactionally consistent snapshot during a concurrent WAL commit', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'raya-cc-backup-concurrent-wal-'));
  const database = join(directory, 'source.sqlite');
  const backup = join(directory, 'backup.sqlite');
  const marker = join(directory, 'vacuum-started.marker');
  const rowCount = 12000;
  const payload = 'x'.repeat(2048);
  let db;
  let child;
  let snapshot;
  try {
    db = openDatabase(database);
    db.exec('CREATE TABLE backup_probe (id INTEGER PRIMARY KEY, generation INTEGER NOT NULL, payload TEXT NOT NULL)');
    const insert = db.prepare('INSERT INTO backup_probe (generation, payload) VALUES (0, ?)');
    db.exec('BEGIN');
    try {
      for (let index = 0; index < rowCount; index += 1) insert.run(payload);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }

    const worker = new URL('../test-support/backup-fault-worker.js', import.meta.url);
    child = spawn(process.execPath, [fileURLToPath(worker), database, backup, 'concurrent-write', marker], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });

    const deadline = Date.now() + 15000;
    while (!existsSync(marker) && child.exitCode === null && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(existsSync(marker), true, 'backup worker did not reach VACUUM INTO: ' + stderr);
    if (process.platform !== 'win32') assert.equal(Number(readFileSync(marker, 'utf8')), 0o700, 'the temporary directory must be private while VACUUM INTO is running');
    assert.equal(child.exitCode, null, 'VACUUM should still be active when the competing write begins');

    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec('UPDATE backup_probe SET generation = 1');
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }

    const [code] = await once(child, 'exit');
    assert.equal(code, 0, stderr);
    const backupOutcome = JSON.parse(stdout);
    assert.equal(backupOutcome.ok, true);
    assert.deepEqual(backupOutcome.result.cleanupWarnings, []);

    snapshot = new DatabaseSync(backup);
    const integrity = snapshot.prepare('PRAGMA integrity_check').all();
    assert.equal(integrity.length, 1);
    assert.equal(integrity[0].integrity_check, 'ok');
    const generations = snapshot.prepare('SELECT generation, COUNT(*) AS count FROM backup_probe GROUP BY generation ORDER BY generation').all();
    assert.ok(
      (generations.length === 1 && generations[0].generation === 0 && generations[0].count === rowCount)
      || (generations.length === 1 && generations[0].generation === 1 && generations[0].count === rowCount),
      'snapshot must contain one complete transaction generation, got ' + JSON.stringify(generations)
    );
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM backup_probe WHERE generation = 1').get().count, rowCount);
  } finally {
    if (snapshot) snapshot.close();
    if (child && child.exitCode === null) {
      child.kill();
      await once(child, 'exit');
    }
    if (db) db.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('backup reports a retained temporary hard link when cleanup fails after publication', () => {
  const directory = mkdtempSync(join(tmpdir(), 'raya-cc-backup-cleanup-warning-'));
  const database = join(directory, 'source.sqlite');
  const backup = join(directory, 'backup.sqlite');
  let db;
  let retained;
  try {
    db = openDatabase(database);
    new ControlCenter(db).createTask({ type: 'backup.cleanup.warning' });
    db.close();
    db = null;

    const worker = new URL('../test-support/backup-fault-worker.js', import.meta.url);
    const result = spawnSync(process.execPath, [fileURLToPath(worker), database, backup, 'cleanup-failure'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const outcome = JSON.parse(result.stdout);
    assert.equal(outcome.ok, true);
    assert.equal(outcome.result.cleanupWarnings.length, 1);
    const warning = outcome.result.cleanupWarnings[0];
    assert.equal(warning.artifact, 'temporary');
    assert.equal(warning.error, 'EBUSY');
    assert.ok(warning.path.includes('.backup.sqlite.'));
    assert.ok(warning.path.endsWith('snapshot.sqlite'));
    assert.equal(existsSync(backup), true, 'the published backup remains valid');
    assert.equal(existsSync(warning.path), true, 'the failed cleanup leaves a visible hard link');
    retained = new DatabaseSync(warning.path);
    assert.equal(retained.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally {
    if (retained) retained.close();
    if (db) db.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('backup attaches a cleanup warning when VACUUM fails and its partial temp cannot be removed', () => {
  const directory = mkdtempSync(join(tmpdir(), 'raya-cc-backup-failure-cleanup-warning-'));
  const database = join(directory, 'source.sqlite');
  const backup = join(directory, 'backup.sqlite');
  let db;
  try {
    db = openDatabase(database);
    new ControlCenter(db).createTask({ type: 'backup.failure.cleanup.warning' });
    db.close();
    db = null;

    const worker = new URL('../test-support/backup-fault-worker.js', import.meta.url);
    const result = spawnSync(process.execPath, [fileURLToPath(worker), database, backup, 'vacuum-cleanup-failure'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const outcome = JSON.parse(result.stdout);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.message, 'injected-vacuum-failure');
    assert.equal(outcome.cleanupWarnings.length, 1);
    const warning = outcome.cleanupWarnings[0];
    assert.equal(warning.artifact, 'temporary');
    assert.equal(warning.error, 'EBUSY');
    assert.ok(warning.path.includes('.backup.sqlite.'));
    assert.ok(warning.path.endsWith('snapshot.sqlite'));
    assert.equal(existsSync(backup), false);
    assert.equal(existsSync(warning.path), true);
    assert.equal(readFileSync(warning.path, 'utf8'), 'partial snapshot');
    assert.equal(inspectDatabaseFileLock(database + '.maintenance.lock').active, false);
    assert.equal(inspectDatabaseFileLock(backup + '.maintenance.lock').active, false);
  } finally {
    if (db) db.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
test('backup removes a partial temporary snapshot when VACUUM INTO fails', () => {
  const directory = mkdtempSync(join(tmpdir(), 'raya-cc-backup-failure-'));
  const database = join(directory, 'live.sqlite');
  const backup = join(directory, 'backup.sqlite');
  let db;
  try {
    db = openDatabase(database);
    new ControlCenter(db).createTask({ type: 'backup.failure.cleanup' });
    db.close();
    db = null;

    const worker = new URL('../test-support/backup-fault-worker.js', import.meta.url);
    const result = spawnSync(process.execPath, [fileURLToPath(worker), database, backup], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const outcome = JSON.parse(result.stdout);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.message, 'injected-vacuum-failure');
    assert.equal(existsSync(backup), false);
    assert.deepEqual(
      (readdirSync(directory)).filter(name => name.startsWith('.backup.sqlite.') && name.endsWith('.tmp')),
      []
    );
  } finally {
    if (db) db.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
test('backup refuses publication when the completed snapshot cannot be fsynced', () => {
  const directory = mkdtempSync(join(tmpdir(), 'raya-cc-backup-fsync-failure-'));
  const database = join(directory, 'source.sqlite');
  const backup = join(directory, 'backup.sqlite');
  let db;
  try {
    db = openDatabase(database);
    new ControlCenter(db).createTask({ type: 'backup.fsync.failure' });
    db.close();
    db = null;

    const worker = new URL('../test-support/backup-fault-worker.js', import.meta.url);
    const result = spawnSync(process.execPath, [fileURLToPath(worker), database, backup, 'sync-failure'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const outcome = JSON.parse(result.stdout);
    assert.equal(outcome.ok, false);
    assert.match(outcome.message, /injected-backup-fsync-failure/);
    assert.equal(existsSync(backup), false, 'an unflushed snapshot must not be published');
    assert.deepEqual(readdirSync(directory).filter(name => name.startsWith('.backup.sqlite.') && name.endsWith('.tmp')), []);
    assert.deepEqual(readdirSync(directory).filter(name => name.startsWith('.backup.sqlite.') && name.endsWith('.tmp')), []);
    assert.equal(inspectDatabaseFileLock(database + '.maintenance.lock').active, false);
    assert.equal(inspectDatabaseFileLock(backup + '.maintenance.lock').active, false);
  } finally {
    if (db) db.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('restore keeps the original live database when the staged copy cannot be fsynced', () => {
  const directory = mkdtempSync(join(tmpdir(), 'raya-cc-restore-fsync-failure-'));
  const database = join(directory, 'live.sqlite');
  const source = join(directory, 'source.sqlite');
  const backup = join(directory, 'backup.sqlite');
  let db;
  try {
    db = openDatabase(database);
    new ControlCenter(db).createTask({ type: 'restore.original' });
    db.close();
    db = null;

    db = openDatabase(source);
    new ControlCenter(db).createTask({ type: 'restore.replacement' });
    db.close();
    db = null;
    createDatabaseBackup(source, backup);

    const worker = new URL('../test-support/restore-fault-worker.js', import.meta.url);
    const result = spawnSync(process.execPath, [fileURLToPath(worker), 'sync-failure', backup, database], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const outcome = JSON.parse(result.stdout);
    assert.equal(outcome.ok, false);
    assert.match(outcome.message, /injected-restore-fsync-failure/);
    assert.equal(existsSync(database), true);
    assert.equal(existsSync(database + '.restore-journal.json'), false);
    assert.deepEqual(readdirSync(directory).filter(name => name.startsWith('.live.sqlite.') && name.endsWith('.restore')), []);
    assert.equal(inspectDatabaseFileLock(database + '.runtime.lock').active, false);
    assert.equal(inspectDatabaseFileLock(database + '.maintenance.lock').active, false);

    db = openDatabase(database);
    assert.equal(db.prepare('SELECT type FROM tasks').get().type, 'restore.original');
  } finally {
    if (db) db.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('restore handles directory fsync failures at journal, rollback, install, and journal-cleanup boundaries', { skip: process.platform === 'win32' }, () => {
  const scenarios = [
    // The first two directory syncs publish the Restore journal and remove its temporary file.
    { failureAt: 1, ok: false, task: 'restore.original', journal: true, rollback: false, warning: null },
    { failureAt: 3, ok: false, task: 'restore.original', journal: false, rollback: false, warning: null },
    { failureAt: 4, ok: false, task: 'restore.replacement', journal: true, rollback: true, warning: null },
    { failureAt: 6, ok: true, task: 'restore.replacement', journal: false, rollback: true, warning: 'journal' }
  ];
  const worker = new URL('../test-support/restore-fault-worker.js', import.meta.url);
  for (const scenario of scenarios) {
    const directory = mkdtempSync(join(tmpdir(), 'raya-cc-restore-directory-fsync-'));
    const database = join(directory, 'live.sqlite');
    const source = join(directory, 'source.sqlite');
    const backup = join(directory, 'backup.sqlite');
    let db;
    try {
      db = openDatabase(database);
      new ControlCenter(db).createTask({ type: 'restore.original' });
      db.close();
      db = null;
      db = openDatabase(source);
      new ControlCenter(db).createTask({ type: 'restore.replacement' });
      db.close();
      db = null;
      createDatabaseBackup(source, backup);

      const result = spawnSync(process.execPath, [fileURLToPath(worker), 'directory-sync-failure-' + scenario.failureAt, backup, database], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      const outcome = JSON.parse(result.stdout);
      assert.equal(outcome.ok, scenario.ok, 'failure boundary ' + scenario.failureAt + ': ' + outcome.message);
      if (!scenario.ok) assert.match(outcome.message, new RegExp('injected-directory-fsync-failure-' + scenario.failureAt));
      assert.equal(existsSync(database + '.restore-journal.json'), scenario.journal, 'journal state at boundary ' + scenario.failureAt);
      const rollbackFiles = readdirSync(directory).filter(name => name.startsWith('live.sqlite.pre-restore-'));
      assert.equal(rollbackFiles.length, scenario.rollback ? 1 : 0, 'rollback evidence at boundary ' + scenario.failureAt);
      assert.equal(inspectDatabaseFileLock(database + '.runtime.lock').active, false);
      assert.equal(inspectDatabaseFileLock(database + '.maintenance.lock').active, false);

      db = openDatabase(database);
      assert.equal(db.prepare('SELECT type FROM tasks').get().type, scenario.task);
      db.close();
      db = null;
      if (scenario.warning) assert.deepEqual(outcome.result.cleanupWarnings.map(item => item.artifact), [scenario.warning]);
    } finally {
      if (db) db.close();
      rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }
});
