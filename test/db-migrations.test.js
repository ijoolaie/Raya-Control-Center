import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../src/db.js';

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
