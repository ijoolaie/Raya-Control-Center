import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const migrations = [
  {
    version: 1,
    sql: `
      CREATE TABLE participants (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 1 AND 120),
        kind TEXT NOT NULL CHECK(kind IN ('worker', 'adapter', 'operator_client')),
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'disabled', 'revoked')),
        scopes_json TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_seen_at TEXT
      );

      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK(length(type) BETWEEN 1 AND 160),
        status TEXT NOT NULL CHECK(status IN ('queued','claimed','running','waiting_approval','blocked','cancellation_requested','succeeded','failed','cancelled')),
        payload_json TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 0,
        created_by TEXT,
        assigned_participant_id TEXT REFERENCES participants(id),
        lease_id TEXT,
        idempotency_key TEXT UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      );

      CREATE TABLE leases (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        participant_id TEXT NOT NULL REFERENCES participants(id),
        token_hash TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK(status IN ('active','released','expired','revoked')),
        issued_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        renewed_at TEXT,
        released_at TEXT
      );

      CREATE UNIQUE INDEX one_active_lease_per_task
        ON leases(task_id) WHERE status = 'active';
      CREATE INDEX tasks_queue_order ON tasks(status, priority DESC, created_at ASC);
      CREATE INDEX leases_expiry ON leases(status, expires_at);
      CREATE INDEX participants_status ON participants(status);

      CREATE TABLE events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        occurred_at TEXT NOT NULL,
        actor_participant_id TEXT REFERENCES participants(id),
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        data_json TEXT NOT NULL,
        correlation_id TEXT
      );
      CREATE INDEX events_entity ON events(entity_type, entity_id, sequence);
    `
  },
  {
    version: 2,
    sql: "CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END; CREATE TRIGGER events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;"
  },
  {
    version: 3,
    sql: "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);"
  }
];

export function openDatabase(filename = '.data/control-center.sqlite') {
  const path = filename === ':memory:' ? filename : resolve(filename);
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  migrate(db);
  return db;
}

export function migrate(db) {
  const current = db.prepare('PRAGMA user_version').get().user_version;
  for (const migration of migrations) {
    if (migration.version <= current) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(migration.sql);
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}
