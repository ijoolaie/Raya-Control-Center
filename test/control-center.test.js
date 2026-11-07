import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { openDatabase, migrate } from '../src/db.js';
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
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 5);
    const task = new ControlCenter(db).createTask({ type: 'persist.check', payload: { durable: true } });
    db.close();
    db = openDatabase(filename);
    assert.equal(new ControlCenter(db).getTask(task.id).payload.durable, true);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});


test('schema migration upgrades an existing version 3 database to version 5', () => {
  const db = openDatabase(':memory:');
  db.exec('ALTER TABLE tasks DROP COLUMN result_json; ALTER TABLE tasks DROP COLUMN progress_json; PRAGMA user_version = 3');
  migrate(db);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 5);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'settings'").get().count, 1);
  db.close();
});

test('participant credentials are returned once and authentication is revocable', () => {
  const { db, center, participant, token } = fixture();
  assert.equal(center.authenticateParticipant(token).id, participant.id);
  assert.equal(center.authenticateParticipant('wrong-token'), null);
  center.revokeParticipant(participant.id);
  assert.equal(center.authenticateParticipant(token), null);
  db.close();
});

test('task creation is idempotent for an identical key and rejects key reuse with different input', () => {
  const { db, center } = fixture();
  const request = { type: 'demo.idempotent', payload: { value: 1, label: 'same' }, priority: 4, idempotencyKey: 'create-once-1' };
  const first = center.createTask(request);
  assert.equal(first.idempotentReplay, false);
  const eventCount = center.listEvents({ entityType: 'task', entityId: first.id }).length;
  const replay = center.createTask({ ...request, payload: { label: 'same', value: 1 } });
  assert.equal(replay.id, first.id);
  assert.equal(replay.idempotentReplay, true);
  assert.equal(center.listTasks({ type: 'demo.idempotent' }).length, 1);
  assert.equal(center.listEvents({ entityType: 'task', entityId: first.id }).length, eventCount);
  assert.throws(() => center.createTask({ ...request, payload: { value: 2 } }),
    error => error.code === 'conflict');
  assert.throws(() => center.createTask({ ...request, priority: 5 }),
    error => error.code === 'conflict');
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
  const completed = center.completeTask({ taskId: task.id, participantId: participant.id, leaseToken: claim.lease.token, result: { ok: true, privateValue: 'result-secret-marker' } });
  assert.equal(completed.status, 'succeeded');
  assert.deepEqual(completed.result, { ok: true, privateValue: 'result-secret-marker' });
  assert.ok(!JSON.stringify(center.listEvents({ entityType: 'task', entityId: task.id })).includes('result-secret-marker'));
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
  const queuedEventCount = center.listEvents({ entityType: 'task', entityId: queued.id }).length;
  assert.equal(center.requestCancellation(queued.id).status, 'cancelled');
  assert.equal(center.listEvents({ entityType: 'task', entityId: queued.id }).length, queuedEventCount);
  const task = center.createTask({ type: 'demo.running' });
  const claim = center.claimTask({ participantId: participant.id, token });
  center.startTask({ taskId: task.id, participantId: participant.id, leaseToken: claim.lease.token });
  assert.equal(center.requestCancellation(task.id).status, 'cancellation_requested');
  const requestedEventCount = center.listEvents({ entityType: 'task', entityId: task.id }).length;
  assert.equal(center.requestCancellation(task.id).status, 'cancellation_requested');
  assert.equal(center.listEvents({ entityType: 'task', entityId: task.id }).length, requestedEventCount);
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





test('WAL recovery rolls back an uncommitted transaction after forced process termination', { timeout: 15000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'raya-crash-'));
  const filename = join(dir, 'crash.sqlite');
  let db = openDatabase(filename);
  const task = new ControlCenter(db).createTask({ type: 'demo.crash-recovery' });
  db.close();
  db = null;
  let child;
  try {
    const workerPath = new URL('../test-support/crash-worker.js', import.meta.url);
    child = spawn(process.execPath, [fileURLToPath(workerPath), filename, task.id], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    await new Promise((resolve, reject) => {
      const onData = () => {
        if (stdout.includes('TRANSACTION_OPEN')) {
          child.stdout.off('data', onData);
          resolve();
        }
      };
      child.stdout.on('data', onData);
      child.once('error', reject);
      child.once('exit', (code, signal) => reject(new Error('Crash worker exited before opening transaction (' + code + ', ' + signal + '): ' + stderr)));
    });
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    const [code, signal] = await exited;
    assert.ok(signal !== null || code !== 0, 'child must be terminated without a clean exit');
    child = null;
    db = openDatabase(filename);
    assert.equal(new ControlCenter(db).getTask(task.id).status, 'queued');
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
    db = null;
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await once(child, 'exit');
    }
    if (db) db.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
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


test('task payloads and completion metadata are bounded JSON objects', () => {
  const { db, center, participant, token } = fixture();
  assert.throws(() => center.createTask({ type: 'demo.bad-payload', payload: 'not-an-object' }),
    error => error.code === 'validation_error');
  const task = center.createTask({ type: 'demo.result-bounds' });
  const claim = center.claimTask({ participantId: participant.id, token });
  assert.throws(() => center.completeTask({
    taskId: task.id, participantId: participant.id, leaseToken: claim.lease.token,
    result: { diagnostic: 'x'.repeat(17_000) }
  }), error => error.code === 'validation_error');
  assert.throws(() => center.failTask({
    taskId: task.id, participantId: participant.id, leaseToken: claim.lease.token, reason: { secret: true }
  }), error => error.code === 'validation_error');
  assert.equal(center.getTask(task.id).status, 'claimed');
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

test('task progress is lease-bound, independent from heartbeat, and audited', () => {
  const { db, center, participant, token } = fixture();
  const task = center.createTask({ type: 'demo.progress' });
  const claim = center.claimTask({ participantId: participant.id, token });
  assert.throws(() => center.updateTaskProgress({ taskId: task.id, participantId: participant.id, leaseToken: claim.lease.token, percent: 10 }), error => error.code === 'invalid_transition');
  center.startTask({ taskId: task.id, participantId: participant.id, leaseToken: claim.lease.token });
  const updated = center.updateTaskProgress({ taskId: task.id, participantId: participant.id, leaseToken: claim.lease.token, percent: 35, message: 'Downloading', details: { completed: 7, total: 20 } });
  assert.equal(updated.progress.percent, 35);
  assert.equal(updated.progress.message, 'Downloading');
  const progressEvent = center.listEvents({ entityType: 'task', entityId: task.id })[0];
  assert.equal(progressEvent.eventType, 'task.progress_updated');
  assert.ok(!JSON.stringify(progressEvent).includes('Downloading'));
  assert.ok(!JSON.stringify(progressEvent).includes('completed'));
  assert.throws(() => center.updateTaskProgress({ taskId: task.id, participantId: participant.id, leaseToken: 'invalid', percent: 40 }), error => error.code === 'lease_mismatch');
  assert.throws(() => center.updateTaskProgress({ taskId: task.id, participantId: participant.id, leaseToken: claim.lease.token, percent: 101 }), error => error.code === 'validation_error');
  db.close();
});
test('failure reasons are not persisted in audit events', () => {
  const { db, center, participant, token } = fixture();
  const task = center.createTask({ type: 'demo.failure-redaction' });
  const claim = center.claimTask({ participantId: participant.id, token });
  center.startTask({ taskId: task.id, participantId: participant.id, leaseToken: claim.lease.token });
  center.failTask({ taskId: task.id, participantId: participant.id, leaseToken: claim.lease.token, reason: 'failure-secret-marker' });
  assert.ok(!JSON.stringify(center.listEvents({ entityType: 'task', entityId: task.id })).includes('failure-secret-marker'));
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
  const participantEventCount = center.listEvents({ entityType: 'participant', entityId: participant.id }).filter(event => event.eventType === 'participant.revoked').length;
  assert.equal(participantEventCount, 1);
  assert.equal(center.revokeParticipant(participant.id).status, 'revoked');
  assert.equal(center.listEvents({ entityType: 'participant', entityId: participant.id }).filter(event => event.eventType === 'participant.revoked').length, 1);
  assert.throws(() => center.revokeParticipant('missing-participant'), error => error.code === 'not_found');
  assert.equal(db.prepare('SELECT status FROM leases WHERE id = ?').get(claim.lease.id).status, 'revoked');
  assert.equal(center.getTask(task.id).status, 'blocked');
  assert.equal(center.getTask(task.id).leaseId, null);
  assert.equal(center.getTask(task.id).assignedParticipantId, null);
  assert.equal(center.listEvents({ entityId: task.id, limit: 1 })[0].eventType, 'task.participant_revoked_blocked');
  assert.throws(() => center.completeTask({ taskId: task.id, participantId: participant.id, leaseToken: claim.lease.token }), error => error.code === 'lease_mismatch');
  db.close();
});


test('participant and task listing applies validated filters and bounded pagination', () => {
  const { db, center, participant } = fixture();
  const first = center.createTask({ type: 'list.alpha', payload: { index: 1 } });
  center.createTask({ type: 'list.beta', payload: { index: 2 } });
  center.createTask({ type: 'list.alpha', payload: { index: 3 } });
  assert.equal(center.listParticipants().length, 1);
  assert.equal(center.listParticipants({ status: 'active', kind: 'worker' })[0].id, participant.id);
  assert.equal(center.listTasks({ type: 'list.alpha' }).length, 2);
  const firstPage = center.listTasks({ type: 'list.alpha', limit: 1 });
  assert.equal(firstPage.length, 1);
  const secondPage = center.listTasks({ type: 'list.alpha', limit: 1, offset: 1 });
  assert.equal(secondPage.length, 1);
  assert.notEqual(secondPage[0].id, firstPage[0].id);
  assert.equal(secondPage[0].type, 'list.alpha');
  assert.equal(center.listTasks({ status: 'queued' }).length, 3);
  assert.throws(() => center.listTasks({ status: 'invalid' }), error => error.code === 'validation_error');
  assert.throws(() => center.listParticipants({ limit: 101 }), error => error.code === 'validation_error');
  db.close();
});