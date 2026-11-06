import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
    const task = new ControlCenter(db).createTask({ type: 'persist.check', payload: { durable: true } });
    db.close();
    db = openDatabase(filename);
    assert.equal(new ControlCenter(db).getTask(task.id).payload.durable, true);
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
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
  const { db, center, participant } = fixture();
  const task = center.createTask({ type: 'demo.work', payload: { safe: true } });
  const claim = center.claimTask({ participantId: participant.id });
  assert.equal(claim.task.id, task.id);
  assert.equal(center.claimTask({ participantId: participant.id }), null);
  assert.throws(() => center.startTask({ taskId: task.id, participantId: participant.id, leaseToken: 'bad' }), error => error instanceof ControlCenterError && error.code === 'lease_mismatch');
  center.startTask({ taskId: task.id, participantId: participant.id, leaseToken: claim.lease.token });
  assert.equal(center.completeTask({ taskId: task.id, participantId: participant.id, leaseToken: claim.lease.token, result: { ok: true } }).status, 'succeeded');
  assert.equal(center.listEvents({ entityType: 'task', entityId: task.id }).length, 4);
  db.close();
});

test('a participant without claim scope cannot claim tasks', () => {
  const db = openDatabase(':memory:'); const center = new ControlCenter(db);
  const p = center.registerParticipant({ displayName: 'limited' }).participant;
  center.createTask({ type: 'demo.work' });
  assert.throws(() => center.claimTask({ participantId: p.id }), error => error instanceof ControlCenterError && error.code === 'insufficient_scope');
  db.close();
});

test('cancellation is cooperative and queued work cancels immediately', () => {
  const { db, center, participant } = fixture();
  const queued = center.createTask({ type: 'demo.queued' });
  assert.equal(center.requestCancellation(queued.id).status, 'cancelled');
  const task = center.createTask({ type: 'demo.running' });
  const claim = center.claimTask({ participantId: participant.id });
  center.startTask({ taskId: task.id, participantId: participant.id, leaseToken: claim.lease.token });
  assert.equal(center.requestCancellation(task.id).status, 'cancellation_requested');
  assert.equal(center.acknowledgeCancellation({ taskId: task.id, participantId: participant.id, leaseToken: claim.lease.token }).status, 'cancelled');
  db.close();
});

test('expired leases cannot mutate task state', () => {
  const { db, center, participant } = fixture({ leaseDurationMs: 1000 });
  const task = center.createTask({ type: 'demo.expiry' });
  const claim = center.claimTask({ participantId: participant.id });
  db.prepare("UPDATE leases SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(claim.lease.id);
  assert.throws(() => center.completeTask({ taskId: task.id, participantId: participant.id, leaseToken: claim.lease.token }), error => error.code === 'lease_mismatch');
  db.close();
});

test('revoking a participant also revokes its active lease', () => {
  const { db, center, participant } = fixture();
  const task = center.createTask({ type: 'demo.revoke' });
  const claim = center.claimTask({ participantId: participant.id });
  center.revokeParticipant(participant.id);
  assert.equal(db.prepare('SELECT status FROM leases WHERE id = ?').get(claim.lease.id).status, 'revoked');
  assert.equal(center.getTask(task.id).status, 'claimed');
  db.close();
});
