import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db.js';
import { ControlCenter } from '../src/control-center.js';
import { createDatabaseBackup, restoreDatabaseBackup } from '../src/database-maintenance.js';

test('SQLite backup captures committed WAL data and restores a validated database', () => {
  const directory = mkdtempSync(join(tmpdir(), 'raya-cc-backup-'));
  const database = join(directory, 'live.sqlite');
  const backup = join(directory, 'backup.sqlite');
  const restored = join(directory, 'restored.sqlite');
  let db;
  try {
    db = openDatabase(database);
    const center = new ControlCenter(db);
    const task = center.createTask({ type: 'backup.snapshot', payload: { committed: true } });
    const backupResult = createDatabaseBackup(database, backup);
    assert.equal(backupResult.schemaVersion, 5);
    const restoreResult = restoreDatabaseBackup(backup, restored);
    assert.equal(restoreResult.schemaVersion, 5);
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
