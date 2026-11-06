import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { createControlServer } from '../src/http-server.js';

async function createHarness(run) {
  const db = openDatabase(':memory:');
  const operatorToken = 'operator-contract-secret-'.repeat(2);
  const server = createControlServer({ db, operatorToken });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port + '/control/v1';
  const operator = { authorization: 'Bearer ' + operatorToken, 'content-type': 'application/json' };
  const request = async (path, { token, leaseToken, ...options } = {}) => {
    const headers = { ...(options.headers || {}), ...(token ? { authorization: 'Bearer ' + token } : {}), ...(leaseToken ? { 'x-lease-token': leaseToken } : {}) };
    if (options.body !== undefined) headers['content-type'] ||= 'application/json';
    const response = await fetch(base + path, { ...options, headers });
    const text = await response.text();
    let body;
    try { body = text ? JSON.parse(text) : null; } catch { throw new Error('API returned non-JSON response'); }
    return { status: response.status, body };
  };
  try {
    await run({ db, request, operator, operatorToken });
  } finally {
    await new Promise(resolve => server.close(resolve));
    db.close();
  }
}

test('independent HTTP client completes a task using the documented participant and lease contract', async () => {
  await createHarness(async ({ request, operator }) => {
    const registration = await request('/participants/register', {
      method: 'POST', headers: operator,
      body: JSON.stringify({ displayName: 'contract-client', kind: 'worker', scopes: ['tasks:claim'] })
    });
    assert.equal(registration.status, 201);
    const participantToken = registration.body.token;
    const participantId = registration.body.participant.id;

    const created = await request('/tasks', {
      method: 'POST', headers: operator,
      body: JSON.stringify({ type: 'contract.execute', payload: { input: 'sample' }, priority: 7, idempotencyKey: 'contract-success-1' })
    });
    assert.equal(created.status, 201);
    const taskId = created.body.task.id;
    assert.equal(created.body.task.status, 'queued');

    const claimed = await request('/tasks/claim', { method: 'POST', token: participantToken, body: '{}' });
    assert.equal(claimed.status, 200);
    assert.equal(claimed.body.claim.task.id, taskId);
    assert.equal(claimed.body.claim.task.status, 'claimed');
    const leaseToken = claimed.body.claim.lease.token;
    assert.ok(leaseToken);

    const started = await request('/tasks/' + taskId + '/start', { method: 'POST', token: participantToken, leaseToken, body: '{}' });
    assert.equal(started.status, 200);
    assert.equal(started.body.task.status, 'running');

    const progress = await request('/tasks/' + taskId + '/progress', {
      method: 'POST', token: participantToken, leaseToken,
      body: JSON.stringify({ percent: 45, message: 'Processing input', details: { phase: 'transform' } })
    });
    assert.equal(progress.status, 200);
    assert.deepEqual(progress.body.task.progress.percent, 45);
    assert.deepEqual(progress.body.task.progress.details, { phase: 'transform' });

    const heartbeat = await request('/tasks/' + taskId + '/heartbeat', {
      method: 'POST', token: participantToken, leaseToken, body: JSON.stringify({ leaseDurationMs: 60000 })
    });
    assert.equal(heartbeat.status, 200);
    assert.equal(heartbeat.body.taskId, taskId);
    assert.ok(heartbeat.body.expiresAt);

    const completed = await request('/tasks/' + taskId + '/complete', {
      method: 'POST', token: participantToken, leaseToken,
      body: JSON.stringify({ result: { output: 'done', count: 1 } })
    });
    assert.equal(completed.status, 200);
    assert.equal(completed.body.task.status, 'succeeded');

    const staleLease = await request('/tasks/' + taskId + '/heartbeat', {
      method: 'POST', token: participantToken, leaseToken, body: '{}'
    });
    assert.equal(staleLease.status, 409);
    assert.equal(staleLease.body.error.code, 'lease_mismatch');

    const events = await request('/events?entityType=task&entityId=' + taskId, { headers: operator });
    assert.equal(events.status, 200);
    const eventTypes = events.body.events.map(event => event.eventType);
    for (const expected of ['task.queued', 'task.claimed', 'task.started', 'task.progress_updated', 'task.succeeded']) {
      assert.ok(eventTypes.includes(expected), 'missing audit event: ' + expected);
    }
    assert.ok(events.body.events.every(event => !JSON.stringify(event).includes(leaseToken)));
    assert.equal(events.body.events[0].entityId, taskId);
    assert.equal(participantId, claimed.body.claim.task.assignedParticipantId);
  });
});

test('independent HTTP client observes cooperative cancellation and acknowledges it with its active lease', async () => {
  await createHarness(async ({ request, operator }) => {
    const registration = await request('/participants/register', {
      method: 'POST', headers: operator,
      body: JSON.stringify({ displayName: 'cancel-client', scopes: ['tasks:claim'] })
    });
    const participantToken = registration.body.token;
    const created = await request('/tasks', {
      method: 'POST', headers: operator,
      body: JSON.stringify({ type: 'contract.cancel', payload: { operation: 'long-running' } })
    });
    const taskId = created.body.task.id;
    const claimed = await request('/tasks/claim', { method: 'POST', token: participantToken, body: '{}' });
    const leaseToken = claimed.body.claim.lease.token;
    const started = await request('/tasks/' + taskId + '/start', { method: 'POST', token: participantToken, leaseToken, body: '{}' });
    assert.equal(started.body.task.status, 'running');

    const requested = await request('/tasks/' + taskId + '/cancel-request', { method: 'POST', headers: operator, body: '{}' });
    assert.equal(requested.status, 200);
    assert.equal(requested.body.task.status, 'cancellation_requested');

    const cancellationStatus = await request('/tasks/' + taskId + '/lease-status', { token: participantToken, leaseToken });
    assert.equal(cancellationStatus.status, 200);
    assert.equal(cancellationStatus.body.status.status, 'cancellation_requested');
    assert.equal(cancellationStatus.body.status.cancellationRequested, true);
    assert.equal(Object.hasOwn(cancellationStatus.body.status, 'payload'), false);

    const foreignParticipant = await request('/participants/register', { method: 'POST', headers: operator, body: JSON.stringify({ displayName: 'foreign-client', scopes: ['tasks:claim'] }) });
    const foreignRead = await request('/tasks/' + taskId + '/lease-status', { token: foreignParticipant.body.token, leaseToken });
    assert.equal(foreignRead.status, 409);
    assert.equal(foreignRead.body.error.code, 'lease_mismatch');

    const acknowledged = await request('/tasks/' + taskId + '/cancel-ack', {
      method: 'POST', token: participantToken, leaseToken, body: '{}'
    });
    assert.equal(acknowledged.status, 200);
    assert.equal(acknowledged.body.task.status, 'cancelled');

    const finalRead = await request('/tasks/' + taskId, { headers: operator });
    assert.equal(finalRead.body.task.status, 'cancelled');
    const events = await request('/events?entityType=task&entityId=' + taskId, { headers: operator });
    const eventTypes = events.body.events.map(event => event.eventType);
    assert.ok(eventTypes.includes('task.cancellation_requested'));
    assert.ok(eventTypes.includes('task.cancelled'));
  });
});

test('revoking a participant invalidates its token and blocks its leased task', async () => {
  await createHarness(async ({ request, operator }) => {
    const registration = await request('/participants/register', {
      method: 'POST', headers: operator,
      body: JSON.stringify({ displayName: 'revoked-client', scopes: ['tasks:claim'] })
    });
    const participantToken = registration.body.token;
    const participantId = registration.body.participant.id;
    const created = await request('/tasks', {
      method: 'POST', headers: operator, body: JSON.stringify({ type: 'contract.revoke' })
    });
    const taskId = created.body.task.id;
    const claim = await request('/tasks/claim', { method: 'POST', token: participantToken, body: '{}' });
    const leaseToken = claim.body.claim.lease.token;
    const started = await request('/tasks/' + taskId + '/start', { method: 'POST', token: participantToken, leaseToken, body: '{}' });
    assert.equal(started.body.task.status, 'running');

    const revoked = await request('/participants/' + participantId + '/revoke', { method: 'POST', headers: operator, body: '{}' });
    assert.equal(revoked.status, 200);
    assert.equal(revoked.body.participant.status, 'revoked');

    const staleParticipant = await request('/tasks/claim', { method: 'POST', token: participantToken, body: '{}' });
    assert.equal(staleParticipant.status, 401);
    const staleLease = await request('/tasks/' + taskId + '/heartbeat', {
      method: 'POST', token: participantToken, leaseToken, body: '{}'
    });
    assert.equal(staleLease.status, 401);

    const read = await request('/tasks/' + taskId, { headers: operator });
    assert.equal(read.body.task.status, 'blocked');
    assert.equal(read.body.task.leaseId, null);
  });
});
