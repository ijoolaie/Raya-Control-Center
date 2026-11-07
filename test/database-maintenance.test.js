import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db.js';
import { ControlCenter } from '../src/control-center.js';
import { createDatabaseBackup, restoreDatabaseBackup } from '../src/database-maintenance.js';
import { startControlCenter } from '../src/server-runtime.js';
import { acquireDatabaseMaintenanceLock } from '../src/database-runtime-lock.js';

test('SQLite backup captures committed WAL data and restores a validated database', () => {
  const directory = mkdtempSync(join(tmpdir(), 'raya-cc-backup-'));
  const database = join(directory, 'live.sqlite');
  const backup = join(directory, 'backup.sqlite');
  const restored = join(directory, 'restored.sqlite');
  const staleBackupTemp = join(directory, '.backup.sqlite.00000000-0000-4000-8000-000000000000.tmp');
  const staleRestoreTemp = join(directory, '.restored.sqlite.00000000-0000-4000-8000-000000000000.restore');
  let db;
  try {
    db = openDatabase(database);
    const center = new ControlCenter(db);
    const task = center.createTask({ type: 'backup.snapshot', payload: { committed: true } });
    writeFileSync(staleBackupTemp, 'stale partial backup');
    const backupResult = createDatabaseBackup(database, backup);
    assert.equal(existsSync(staleBackupTemp), false);
    assert.equal(backupResult.schemaVersion, 5);
    writeFileSync(staleRestoreTemp, 'stale partial restore');
    const restoreResult = restoreDatabaseBackup(backup, restored);
    assert.equal(existsSync(staleRestoreTemp), false);
    assert.equal(restoreResult.schemaVersion, 5);
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
    unlinkSync(database + '.maintenance.lock');
    unlinkSync(database + '.runtime.lock');
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

    unlinkSync(database + '.maintenance.lock');
    unlinkSync(database + '.runtime.lock');
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

    writer = openDatabase(database);
    const task = new ControlCenter(writer).createTask({ type: 'maintenance.active.snapshot', payload: { from: 'runtime' } });
    writer.close();
    writer = null;

    const result = createDatabaseBackup(database, backup);
    assert.equal(result.schemaVersion, 5);
    assert.equal(existsSync(database + '.maintenance.lock'), false);
    assert.throws(() => restoreDatabaseBackup(backup, database), /Database is already locked by process/);
    assert.equal(existsSync(database + '.runtime.lock'), true);

    await runtime.shutdown();
    runtime = null;
    assert.equal(existsSync(database + '.runtime.lock'), false);

    const restored = restoreDatabaseBackup(backup, database);
    assert.equal(restored.schemaVersion, 5);
    checkDb = openDatabase(database);
    assert.deepEqual(new ControlCenter(checkDb).getTask(task.id).payload, { from: 'runtime' });
    checkDb.close();
    checkDb = null;
    assert.equal(existsSync(database + '.runtime.lock'), false);
    assert.equal(existsSync(database + '.maintenance.lock'), false);
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
    assert.throws(() => createDatabaseBackup(database, join(directory, 'second-backup.sqlite')), /maintenance lock is already held/);
    assert.throws(() => restoreDatabaseBackup(backup, database), /maintenance lock is already held/);
    assert.equal(existsSync(database + '.runtime.lock'), false);
  } finally {
    release?.();
    if (db) db.close();
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

    assert.throws(() => createDatabaseBackup(firstDatabase, destination), /maintenance lock is already held/);
    assert.equal(existsSync(marker), true, 'a competing backup must not clean another process active temp file');
    assert.equal(existsSync(destination), false);

    child.stdin.end('release');
    const [code] = await once(child, 'exit');
    assert.equal(code, 0, output);
    child = null;
    assert.equal(existsSync(destination + '.maintenance.lock'), false);
  } finally {
    if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited.catch(() => {}); }
    if (first) first.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('backup crash leaves a stale lock and temp that require verified recovery', () => {
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
    assert.equal(result.status, 77, result.stderr);
    assert.equal(existsSync(destination + '.maintenance.lock'), true);
    assert.equal(existsSync(marker), true);
    assert.throws(() => createDatabaseBackup(database, destination), /maintenance lock is already held/);

    // The child has exited; only now remove its stale lock and let cleanup remove the orphaned temp.
    unlinkSync(destination + '.maintenance.lock');
    const backup = createDatabaseBackup(database, destination);
    assert.equal(backup.schemaVersion, 5);
    assert.equal(existsSync(destination), true);
    assert.equal(existsSync(marker), false);
  } finally {
    if (db) db.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
test('backup destination lock serializes backups from different source databases', () => {
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
      /maintenance lock is already held/
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
