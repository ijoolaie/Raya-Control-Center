import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    assert.equal(backupResult.schemaVersion, 4);
    const restoreResult = restoreDatabaseBackup(backup, restored);
    assert.equal(restoreResult.schemaVersion, 4);
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
