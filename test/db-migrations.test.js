import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate, openDatabase } from '../src/db.js';

test('migration rejects a database schema newer than this build without changing it', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA user_version = 7');
    assert.throws(
      () => migrate(db),
      /Unsupported database schema version 7; this build supports versions 0\.\.6/
    );
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 7);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get().count,
      0,
      'a rejected future database must not be partially migrated'
    );
  } finally {
    db.close();
  }
});

test('migration rejects a negative schema version without changing it', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA user_version = -1');
    assert.throws(() => migrate(db), /Unsupported database schema version -1/);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, -1);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get().count,
      0
    );
  } finally {
    db.close();
  }
});

test('migration still initializes a new database through the latest supported version', () => {
  const db = new DatabaseSync(':memory:');
  try {
    migrate(db);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 6);
    assert.ok(db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'participants'").get());
    assert.ok(db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'tasks'").get());
  } finally {
    db.close();
  }
});


test('a failed migration rolls back its schema changes and does not advance user_version', () => {
  const db = new DatabaseSync(':memory:');
  try {
    // Establish the migration-1 schema, then simulate a partially conflicting
    // version-1 database so the second DDL statement in migration 2 fails.
    migrate(db);
    db.exec(`
      DROP TABLE settings;
      DROP TRIGGER events_no_update;
      DROP TRIGGER events_no_delete;
      PRAGMA user_version = 1;
      CREATE TRIGGER events_no_delete
      BEFORE DELETE ON events
      BEGIN SELECT RAISE(ABORT, 'pre-existing trigger'); END;
    `);

    assert.throws(() => migrate(db), /trigger events_no_delete already exists/i);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'trigger' AND name = 'events_no_update'").get().count,
      0,
      'the first trigger in the failed migration must be rolled back'
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'trigger' AND name = 'events_no_delete'").get().count,
      1,
      'the pre-existing conflicting trigger must remain intact'
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = 'settings'").get().count,
      0,
      'later migrations must not run after a failed migration'
    );
  } finally {
    db.close();
  }
});


test('openDatabase rejects a future schema before changing its journal mode', () => {
  const directory = mkdtempSync(join(tmpdir(), 'raya-db-future-version-'));
  const filename = join(directory, 'future.sqlite');
  try {
    const future = new DatabaseSync(filename);
    future.exec('PRAGMA journal_mode = DELETE; PRAGMA user_version = 7;');
    future.close();

    assert.throws(
      () => openDatabase(filename),
      /Unsupported database schema version 7; this build supports versions 0\.\.6/
    );

    const verify = new DatabaseSync(filename);
    try {
      assert.equal(verify.prepare('PRAGMA user_version').get().user_version, 7);
      assert.equal(verify.prepare('PRAGMA journal_mode').get().journal_mode, 'delete');
    } finally {
      verify.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
