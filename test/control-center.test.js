import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { openDatabase } from '../src/db.js';
import { ControlCenter, ControlCenterError } from '../src/control-center.js';

function fixture(options) {
  const db = openDatabase(':memory:');
  const center = new ControlCenter(db, options);
  const registered = center.registerParticipant({ displayName: 'worker-1', scopes: ['tasks:claim'] });
  return { db, center, participant: registered.participant, token: registered.token };
}

test('migrates a clean database and preserves task state across database reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'raya-cc-'));
  const filename = join(dir, 'state.sqlite');
  try {
    let db = openDatabase(filename);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2);
    const task = new ControlCenter(db).createTask({ type: 'persist.check', payload: { durable: true } });
    db.close();
    db = openDatabase(filename);
    assert.equal(new ControlCenter(db).getTask(task.id).payload.durable, true);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('participant credentials are returned once and authentication is revocable', () => {
  const { db, center, participant, token } = fixture();
  assert.equal(center.authenticateParticipant(token).id, participant.id);
  assert.equal(center.authenticateParticipant('wrong-token'), null);
  center.revokeParticipant(participant.id);
  assert.equal(center.authenticateParticipant(token), null);
  db.close();
});

test('claim is exclusive and task lifecycle is lease-bound', () => {
  const { db, center, participant, token } = fixture();
  const task = center.createTask({ type: 'demo.work', payload: { safe: true } });
  assert.throws(() => center.claimTask({ participantId: participant.id }), error => error.code === 'authentication_required');
  const claim = center.claimTask({ participantId: participant.id, token });
  assert.equal(claim.task.id, task.id);
  assert.equal(center.claimTask({ participantId: participant.id, token }), null);
  assert.throws(() => center.startTask({ taskId: task.id, participantId: participant.id, leaseToken: 'bad' }), error => error instanceof ControlCenterError && error.code === 'lease_mismatch');
  center.startTask({ taskId: task.id, participantId: participant.id, leaseToken: claim.lease.token });
  assert.equal(center.completeTask({ taskId: task.id, participantId: participant.id, leaseToken: claim.lease.token, result: { ok: true } }).status, 'succeeded');
  assert.equal(center.listEvents({ entityType: 'task', entityId: task.id }).length, 4);
  db.close();
});

test('a participant without claim scope cannot claim tasks', () => {
  const db = openDatabase(':memory:'); const center = new ControlCenter(db);
  const registered = center.registerParticipant({ displayName: 'limited' }); const p = registered.participant;
  center.createTask({ type: 'demo.work' });
  assert.throws(() => center.claimTask({ participantId: p.id, token: registered.token }), error => error instanceof ControlCenterError && error.code === 'insufficient_scope');
  db.close();
});

test('cancellation is cooperative and queued work cancels immediately', () => {
  const { db, center, participant, token } = fixture();
  const queued = center.createTask({ type: 'demo.queued' });
  assert.equal(center.requestCancellation(queued.id).status, 'cancelled');
  const task = center.createTask({ type: 'demo.running' });
  const claim = center.claimTask({ participantId: participant.id, token });
  center.startTask({ taskId: task.id, participantId: participant.id, leaseToken: claim.lease.token });
  assert.equal(center.requestCancellation(task.id).status, 'cancellation_requested');
  assert.equal(center.acknowledgeCancellation({ taskId: task.id, participantId: participant.id, leaseToken: claim.lease.token }).status, 'cancelled');
  db.close();
});

test('expired leases cannot mutate task state', () => {
  const { db, center, participant, token } = fixture({ leaseDurationMs: 1000 });
  const task = center.createTask({ type: 'demo.expiry' });
  const claim = center.claimTask({ participantId: participant.id, token });
  db.prepare("UPDATE leases SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(claim.lease.id);
  assert.throws(() => center.completeTask({ taskId: task.id, participantId: participant.id, leaseToken: claim.lease.token }), error => error.code === 'lease_mismatch');
  db.close();
});




test('two independent SQLite connections cannot claim the same task', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'raya-race-'));
  const filename = join(dir, 'race.sqlite');
  let db = openDatabase(filename);
  const center = new ControlCenter(db);
  const registered = center.registerParticipant({ displayName: 'race-worker', scopes: ['tasks:claim'] });
  const task = center.createTask({ type: 'demo.concurrent' });
  db.close();

  const runWorker = () => new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../test-support/claim-worker.js', import.meta.url), {
      workerData: { filename, participantId: registered.participant.id, token: registered.token }
    });
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', code => { if (code !== 0) reject(new Error('claim worker exited ' + code)); });
  });

  try {
    const claims = await Promise.all([runWorker(), runWorker()]);
    assert.equal(claims.filter(Boolean).length, 1);
    assert.equal(claims.filter(Boolean)[0].taskId, task.id);
    db = openDatabase(filename);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM leases WHERE task_id = ? AND status = 'active'").get(task.id).count, 1);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
    db = null;
  } finally {
    if (db) db.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('participant and task writes roll back when their audit event cannot be recorded', () => {
  const db = openDatabase(':memory:');
  const center = new ControlCenter(db);
  db.exec("CREATE TRIGGER reject_event_insert BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'event rejected'); END");
  assert.throws(() => center.registerParticipant({ displayName: 'atomic-worker' }), /event rejected/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM participants').get().count, 0);
  assert.throws(() => center.createTask({ type: 'demo.atomic' }), /event rejected/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tasks').get().count, 0);
  db.close();
});

test('heartbeat validates lease duration and extends an active lease', () => {
  const { db, center, participant, token } = fixture();
  const task = center.createTask({ type: 'demo.heartbeat' });
  const claim = center.claimTask({ participantId: participant.id, token });
  assert.throws(() => center.heartbeatLease({ taskId: task.id, participantId: participant.id, leaseToken: claim.lease.token, leaseDurationMs: 0 }), error => error.code === 'validation_error');
  const renewed = center.heartbeatLease({ taskId: task.id, participantId: participant.id, leaseToken: claim.lease.token, leaseDurationMs: 60000 });
  assert.ok(Date.parse(renewed.expiresAt) > Date.parse(claim.lease.expiresAt));
  db.close();
});

test('event history rejects updates and deletes', () => {
  const { db, center } = fixture();
  const event = center.listEvents({ limit: 1 })[0];
  assert.throws(() => db.prepare('UPDATE events SET event_type = ? WHERE id = ?').run('tampered', event.id), /append-only/);
  assert.throws(() => db.prepare('DELETE FROM events WHERE id = ?').run(event.id), /append-only/);
  db.close();
});

test('expired leases reconcile to blocked without automatic retry', () => {
  const { db, center, participant, token } = fixture();
  const task = center.createTask({ type: 'demo.reconcile' });
  const claim = center.claimTask({ participantId: participant.id, token });
  center.startTask({ taskId: task.id, participantId: participant.id, leaseToken: claim.lease.token });
  db.prepare("UPDATE leases SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(claim.lease.id);
  assert.deepEqual(center.reconcileExpiredLeases(), [task.id]);
  assert.equal(center.getTask(task.id).status, 'blocked');
  assert.equal(db.prepare('SELECT status FROM leases WHERE id = ?').get(claim.lease.id).status, 'expired');
  assert.equal(center.claimTask({ participantId: participant.id, token }), null);
  assert.equal(center.listEvents({ entityId: task.id, limit: 10 })[0].eventType, 'task.lease_expired_blocked');
  db.close();
});

test('revoking a participant also revokes its active lease', () => {
  const { db, center, participant, token } = fixture();
  const task = center.createTask({ type: 'demo.revoke' });
  const claim = center.claimTask({ participantId: participant.id, token });
  center.revokeParticipant(participant.id);
  assert.equal(db.prepare('SELECT status FROM leases WHERE id = ?').get(claim.lease.id).status, 'revoked');
  assert.equal(center.getTask(task.id).status, 'claimed');
  db.close();
});
