import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createNetServer, createConnection } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { openDatabase } from '../src/db.js';
import { ControlCenter } from '../src/control-center.js';
import { bootstrapOperatorToken } from '../src/operator-auth.js';
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
    return { status: response.status, body, allow: response.headers.get('allow') };
  };
  try {
    await run({ db, request, operator, operatorToken, server });
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    db.close();
  }
}

test('HTTP task creation safely replays identical idempotency keys after an ambiguous response', async () => {
  await createHarness(async ({ request, operator }) => {
    const body = JSON.stringify({ type: 'contract.idempotent', payload: { operation: 'safe-create' }, priority: 2, idempotencyKey: 'http-create-replay-1' });
    const first = await request('/tasks', { method: 'POST', headers: operator, body });
    assert.equal(first.status, 201);
    assert.equal(first.body.idempotentReplay, false);
    const replay = await request('/tasks', { method: 'POST', headers: operator, body });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.idempotentReplay, true);
    assert.equal(replay.body.task.id, first.body.task.id);
    const conflict = await request('/tasks', {
      method: 'POST', headers: operator,
      body: JSON.stringify({ type: 'contract.idempotent', payload: { operation: 'different' }, priority: 2, idempotencyKey: 'http-create-replay-1' })
    });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error.code, 'conflict');
  });
});

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
    assert.deepEqual(Object.keys(heartbeat.body).sort(), ['expiresAt', 'taskId']);
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
    const repeatedRequest = await request('/tasks/' + taskId + '/cancel-request', { method: 'POST', headers: operator, body: '{}' });
    assert.equal(repeatedRequest.status, 200);
    assert.equal(repeatedRequest.body.task.status, 'cancellation_requested');

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
    assert.equal(eventTypes.filter(type => type === 'task.cancellation_requested').length, 1);
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
    const repeatedRevocation = await request('/participants/' + participantId + '/revoke', {
      method: 'POST', headers: operator, body: '{}'
    });
    assert.equal(repeatedRevocation.status, 200);
    assert.equal(repeatedRevocation.body.participant.status, 'revoked');
    const participantEvents = await request('/events?entityType=participant&entityId=' + participantId, { headers: operator });
    assert.equal(participantEvents.body.events.filter(event => event.eventType === 'participant.revoked').length, 1);

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

test('server startup reconciles expired leases before accepting requests', { timeout: 15000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'raya-startup-recovery-'));
  const filename = join(directory, 'startup.sqlite');
  let db;
  let child;
  let portServer;
  try {
    db = openDatabase(filename);
    const center = new ControlCenter(db);
    const registered = center.registerParticipant({ displayName: 'startup-recovery-worker', scopes: ['tasks:claim'] });
    const task = center.createTask({ type: 'contract.startup-recovery' });
    const claim = center.claimTask({ participantId: registered.participant.id, token: registered.token });
    center.startTask({ taskId: task.id, participantId: registered.participant.id, leaseToken: claim.lease.token });
    db.prepare("UPDATE leases SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(claim.lease.id);
    const operatorToken = bootstrapOperatorToken(db).token;
    db.close();
    db = null;

    portServer = createNetServer();
    await new Promise((resolve, reject) => {
      portServer.once('error', reject);
      portServer.listen(0, '127.0.0.1', resolve);
    });
    const port = portServer.address().port;
    await new Promise((resolve, reject) => portServer.close(error => error ? reject(error) : resolve()));
    portServer = null;

    child = spawn(process.execPath, ['src/server.js'], {
      cwd: process.cwd(),
      env: { ...process.env, RAYA_CC_DATABASE: filename, RAYA_CC_PORT: String(port), RAYA_CC_OPERATOR_TOKEN: operatorToken },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    await new Promise((resolve, reject) => {
      const onData = chunk => {
        if ((stdout += '') && stdout.includes('Raya Control Center listening on')) {
          child.stdout.off('data', onData);
          resolve();
        }
      };
      child.stdout.on('data', onData);
      child.once('error', reject);
      child.once('exit', code => reject(new Error('Server exited before listening (' + code + '): ' + stderr)));
    });

    const response = await fetch('http://127.0.0.1:' + port + '/control/v1/tasks/' + task.id, {
      headers: { authorization: 'Bearer ' + operatorToken }
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.task.status, 'blocked');
    assert.equal(result.task.leaseId, null);
    assert.match(stderr, /Blocked 1 task\(s\) after expired leases/);
  } finally {
    if (db) db.close();
    if (portServer?.listening) await new Promise(resolve => portServer.close(resolve));
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await once(child, 'exit');
    }
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
test('HTTP query parsing rejects unknown, duplicate, empty, and non-canonical parameters', async () => {
  await createHarness(async ({ request, operator }) => {
    const cases = [
      ['/tasks?unexpected=1', 400],
      ['/tasks?status=queued&status=running', 400],
      ['/tasks?limit=', 400],
      ['/tasks?limit=1e2', 400],
      ['/health?debug=true', 400],
      ['/events?entityId=', 400],
      ['/tasks/%ZZ', 400],
      ['/tasks/%E0%A4%A', 400],
      ['/tasks?limit=1&offset=0', 200]
    ];
    for (const [path, expectedStatus] of cases) {
      const response = await request(path, { headers: operator });
      assert.equal(response.status, expectedStatus, path);
      if (expectedStatus === 400) {
        assert.equal(response.body.error.code, 'validation_error', path);
      }
    }
  });
});

test('concurrent HTTP claims grant a task to exactly one participant', async () => {
  await createHarness(async ({ request, operator }) => {
    const registrations = await Promise.all([
      request('/participants/register', { method: 'POST', headers: operator, body: JSON.stringify({ displayName: 'race-worker-a', scopes: ['tasks:claim'] }) }),
      request('/participants/register', { method: 'POST', headers: operator, body: JSON.stringify({ displayName: 'race-worker-b', scopes: ['tasks:claim'] }) })
    ]);
    for (const response of registrations) assert.equal(response.status, 201);
    const created = await request('/tasks', {
      method: 'POST', headers: operator,
      body: JSON.stringify({ type: 'contract.concurrent-claim', payload: { work: 'single-owner' } })
    });
    assert.equal(created.status, 201);
    const taskId = created.body.task.id;

    const claims = await Promise.all(registrations.map(registration =>
      request('/tasks/claim', { method: 'POST', token: registration.body.token, body: '{}' })
    ));
    for (const response of claims) assert.equal(response.status, 200);
    const winners = claims.filter(response => response.body.claim?.task?.id === taskId);
    const empty = claims.filter(response => response.body.claim === null);
    assert.equal(winners.length, 1);
    assert.equal(empty.length, 1);

    const task = await request('/tasks/' + taskId, { headers: operator });
    assert.equal(task.status, 200);
    assert.equal(task.body.task.status, 'claimed');
    assert.equal(task.body.task.assignedParticipantId, winners[0].body.claim.task.assignedParticipantId);
    const events = await request('/events?entityType=task&entityId=' + taskId, { headers: operator });
    assert.equal(events.body.events.filter(event => event.eventType === 'task.claimed').length, 1);
  });
});

test('concurrent HTTP task creation with one idempotency key creates one task and one audit event', async () => {
  await createHarness(async ({ request, operator }) => {
    const body = JSON.stringify({
      type: 'contract.concurrent-idempotency',
      payload: { operation: 'one-creation' },
      priority: 3,
      idempotencyKey: 'concurrent-http-create-unique'
    });
    const responses = await Promise.all([
      request('/tasks', { method: 'POST', headers: operator, body }),
      request('/tasks', { method: 'POST', headers: operator, body })
    ]);
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 201]);
    assert.equal(responses[0].body.task.id, responses[1].body.task.id);
    assert.equal(responses.filter(response => response.body.idempotentReplay === false).length, 1);
    assert.equal(responses.filter(response => response.body.idempotentReplay === true).length, 1);
    const events = await request('/events?entityType=task&entityId=' + responses[0].body.task.id, { headers: operator });
    assert.equal(events.body.events.filter(event => event.eventType === 'task.queued').length, 1);
  });
});

test('HTTP rejects non-loopback Host headers with a safe 421 response', async () => {
  await createHarness(async ({ server }) => {
    const raw = await new Promise((resolve, reject) => {
      const socket = createConnection(server.address().port, '127.0.0.1');
      let response = '';
      socket.setEncoding('utf8');
      socket.on('connect', () => socket.write('GET /control/v1/health HTTP/1.1\r\nHost: attacker.example\r\nConnection: close\r\n\r\n'));
      socket.on('data', chunk => { response += chunk; });
      socket.on('end', () => resolve(response));
      socket.on('error', reject);
    });
    assert.match(raw, /^HTTP\/1\.1 421/);
    const body = JSON.parse(raw.slice(raw.indexOf('\r\n\r\n') + 4));
    assert.deepEqual(body.error, {
      code: 'misdirected_request',
      message: 'Only loopback Host headers are accepted'
    });
    assert.equal(raw.includes('attacker.example', raw.indexOf('\r\n\r\n')), false);
  });
});
test('HTTP routes distinguish unsupported methods from unknown paths', async () => {
  await createHarness(async ({ request, operator }) => {
    const cases = [
      ['/health', 'POST', 'GET'],
      ['/participants/register', 'GET', 'POST'],
      ['/tasks', 'PUT', 'GET, POST'],
      ['/tasks/claim', 'GET', 'POST'],
      ['/tasks/example-id', 'POST', 'GET'],
      ['/tasks/example-id/heartbeat', 'GET', 'POST']
    ];
    for (const [path, method, allow] of cases) {
      const response = await request(path, { method, headers: operator });
      assert.equal(response.status, 405, method + ' ' + path);
      assert.deepEqual(response.body.error, {
        code: 'method_not_allowed',
        message: 'Method not allowed'
      });
      assert.equal(response.allow, allow, method + ' ' + path);
    }

    const missing = await request('/not-a-route', { method: 'PUT', headers: operator });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'not_found');
    assert.equal(missing.allow, null);
  });
});
test('HTTP rejects malformed UTF-8 JSON bodies instead of replacing invalid bytes', async () => {
  await createHarness(async ({ server, operatorToken }) => {
    const body = Buffer.concat([
      Buffer.from('{"type":"invalid.utf8","payload":"'),
      Buffer.from([0xff]),
      Buffer.from('"}')
    ]);
    const raw = await new Promise((resolve, reject) => {
      const socket = createConnection(server.address().port, '127.0.0.1');
      let response = '';
      socket.setEncoding('utf8');
      socket.on('connect', () => {
        socket.write(Buffer.concat([
          Buffer.from('POST /control/v1/tasks HTTP/1.1\r\nHost: 127.0.0.1\r\n'),
          Buffer.from('Authorization: Bearer ' + operatorToken + '\r\nContent-Type: application/json\r\n'),
          Buffer.from('Content-Length: ' + body.length + '\r\nConnection: close\r\n\r\n'),
          body
        ]));
      });
      socket.on('data', chunk => { response += chunk; });
      socket.on('end', () => resolve(response));
      socket.on('error', reject);
    });
    assert.match(raw, /^HTTP\/1\.1 400/);
    const responseBody = JSON.parse(raw.slice(raw.indexOf('\r\n\r\n') + 4));
    assert.equal(responseBody.error.code, 'validation_error');
    assert.equal(responseBody.error.message, 'Request body must contain valid JSON');
  });
});

test('Node HTTP parser rejects conflicting Content-Length and Transfer-Encoding framing', async () => {
  await createHarness(async ({ server }) => {
    const raw = await new Promise((resolve, reject) => {
      const socket = createConnection(server.address().port, '127.0.0.1');
      let response = '';
      socket.setEncoding('utf8');
      socket.on('connect', () => socket.write(
        'POST /control/v1/tasks HTTP/1.1\r\n' +
        'Host: 127.0.0.1\r\n' +
        'Content-Type: application/json\r\n' +
        'Content-Length: 2\r\n' +
        'Transfer-Encoding: chunked\r\n' +
        'Connection: close\r\n\r\n{}'
      ));
      socket.on('data', chunk => { response += chunk; });
      socket.on('end', () => resolve(response));
      socket.on('error', reject);
    });
    assert.match(raw, /^HTTP\/1\.1 400/);
    assert.equal(raw.includes('"task"'), false);
  });
});

test('HTTP parser enforces the configured header-size limit with 431', async () => {
  await createHarness(async ({ server }) => {
    const raw = await new Promise((resolve, reject) => {
      const socket = createConnection(server.address().port, '127.0.0.1');
      let response = '';
      socket.setEncoding('utf8');
      socket.on('connect', () => socket.write(
        'GET /control/v1/health HTTP/1.1\r\n' +
        'Host: 127.0.0.1\r\n' +
        'X-Oversized: ' + 'x'.repeat(9 * 1024) + '\r\n\r\n'
      ));
      socket.on('data', chunk => { response += chunk; });
      socket.on('end', () => resolve(response));
      socket.on('error', reject);
    });
    assert.match(raw, /^HTTP\/1\.1 431/);
  });
});

test('client disconnect during an incomplete request body does not take down the server', async () => {
  await createHarness(async ({ server }) => {
    await new Promise((resolve, reject) => {
      const socket = createConnection(server.address().port, '127.0.0.1');
      socket.once('connect', () => {
        socket.write(
          'POST /control/v1/tasks HTTP/1.1\r\n' +
          'Host: 127.0.0.1\r\n' +
          'Content-Type: application/json\r\n' +
          'Content-Length: 100\r\n\r\n' +
          '{"type":"incomplete'
        );
        socket.destroy();
        resolve();
      });
      socket.once('error', error => {
        if (error.code !== 'ECONNRESET') reject(error);
      });
    });
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/control/v1/health');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok', api: 'control/v1' });
  });
});

test('HTTP server applies explicit header, request, keep-alive, and socket request limits', async () => {
  await createHarness(async ({ server }) => {
    assert.equal(server.headersTimeout, 10_000);
    assert.equal(server.requestTimeout, 30_000);
    assert.equal(server.connectionsCheckingInterval, 1_000);
    assert.equal(server.keepAliveTimeout, 5_000);
    assert.equal(server.maxRequestsPerSocket, 100);
  });
});
