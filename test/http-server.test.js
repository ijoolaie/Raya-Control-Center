import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { spawn } from 'node:child_process';
import { openDatabase } from '../src/db.js';
import { bootstrapOperatorToken, rotateOperatorToken } from '../src/operator-auth.js';
import { createControlServer } from '../src/http-server.js';

const jsonHeaders = { 'content-type': 'application/json' };

test('operator token is bootstrapped once, verified on restart, and rotatable', () => {
  const db = openDatabase(':memory:');
  const first = bootstrapOperatorToken(db);
  assert.equal(first.created, true);
  assert.equal(first.token.length >= 32, true);
  const second = bootstrapOperatorToken(db, first.token);
  assert.equal(second.created, false);
  assert.equal(second.token, first.token);
  assert.throws(() => bootstrapOperatorToken(db, 'x'.repeat(40)), /does not match/);
  const rotated = rotateOperatorToken(db);
  assert.notEqual(rotated, first.token);
  assert.equal(bootstrapOperatorToken(db, rotated).created, false);
  db.close();
});

test('HTTP API separates operator and participant credentials and enforces lease token', async () => {
  const db = openDatabase(':memory:');
  const operatorToken = 'operator-secret-token-'.repeat(2);
  const server = createControlServer({ db, operatorToken });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const base = 'http://127.0.0.1:' + address.port + '/control/v1';
  const operatorHeaders = { ...jsonHeaders, authorization: 'Bearer ' + operatorToken };

  try {
    const health = await fetch(base + '/health');
    assert.equal(health.status, 200);
    const badHost = await new Promise((resolve, reject) => {
      const request = httpRequest({
        hostname: '127.0.0.1', port: address.port, path: '/control/v1/health',
        headers: { host: 'attacker.example' }
      }, response => {
        response.resume();
        response.on('end', () => resolve(response.statusCode));
      });
      request.on('error', reject);
      request.end();
    });
    assert.equal(badHost, 421);

    const denied = await fetch(base + '/events');
    assert.equal(denied.status, 401);

    const registeredResponse = await fetch(base + '/participants/register', {
      method: 'POST',
      headers: operatorHeaders,
      body: JSON.stringify({ displayName: 'api-worker', scopes: ['tasks:claim'] })
    });
    assert.equal(registeredResponse.status, 201);
    const registered = await registeredResponse.json();

    const createdResponse = await fetch(base + '/tasks', {
      method: 'POST',
      headers: operatorHeaders,
      body: JSON.stringify({ type: 'api.test', payload: { value: 1 } })
    });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json();

    const participantHeaders = {
      ...jsonHeaders,
      authorization: 'Bearer ' + registered.token
    };
    const claimResponse = await fetch(base + '/tasks/claim', {
      method: 'POST',
      headers: participantHeaders,
      body: '{}'
    });
    assert.equal(claimResponse.status, 200);
    const claim = (await claimResponse.json()).claim;
    assert.equal(claim.task.id, created.task.id);

    const noLease = await fetch(base + '/tasks/' + created.task.id + '/start', {
      method: 'POST',
      headers: participantHeaders,
      body: '{}'
    });
    assert.equal(noLease.status, 409);

    const leaseHeaders = { ...participantHeaders, 'x-lease-token': claim.lease.token };
    const started = await fetch(base + '/tasks/' + created.task.id + '/start', {
      method: 'POST', headers: leaseHeaders, body: '{}'
    });
    assert.equal(started.status, 200);

    const completed = await fetch(base + '/tasks/' + created.task.id + '/complete', {
      method: 'POST', headers: leaseHeaders, body: JSON.stringify({ result: { ok: true } })
    });
    assert.equal(completed.status, 200);

    const taskResponse = await fetch(base + '/tasks/' + created.task.id, {
      headers: { authorization: 'Bearer ' + operatorToken }
    });
    assert.equal((await taskResponse.json()).task.status, 'succeeded');

    const revoked = await fetch(base + '/participants/' + registered.participant.id + '/revoke', {
      method: 'POST', headers: operatorHeaders, body: '{}'
    });
    assert.equal(revoked.status, 200);
    const afterRevocation = await fetch(base + '/tasks/claim', {
      method: 'POST', headers: participantHeaders, body: '{}'
    });
    assert.equal(afterRevocation.status, 401);

    const reconcile = await fetch(base + '/maintenance/reconcile-expired-leases', {
      method: 'POST', headers: operatorHeaders, body: '{}'
    });
    assert.equal(reconcile.status, 200);
    assert.deepEqual((await reconcile.json()).blockedTaskIds, []);
  } finally {
    await new Promise(resolve => server.close(resolve));
    db.close();
  }
});


test('CLI can register participants and create/read tasks through the local API', async () => {
  const db = openDatabase(':memory:');
  const operatorToken = 'cli-operator-token-'.repeat(3);
  const server = createControlServer({ db, operatorToken });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port + '/control/v1';

  const runCli = args => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['src/cli.js', ...args], {
      cwd: process.cwd(),
      env: { ...process.env, RAYA_CC_URL: base, RAYA_CC_OPERATOR_TOKEN: operatorToken }
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
  });

  try {
    const health = await runCli(['health']);
    assert.equal(health.code, 0);
    assert.match(health.stdout, /"status": "ok"/);

    const registered = await runCli(['participant', 'register', '--name', 'cli-worker', '--scope', 'tasks:claim']);
    assert.equal(registered.code, 0, registered.stderr);
    const participant = JSON.parse(registered.stdout);
    assert.equal(participant.participant.displayName, 'cli-worker');
    assert.equal(typeof participant.token, 'string');

    const created = await runCli(['task', 'create', '--type', 'cli.integration', '--payload', '{"source":"cli"}']);
    assert.equal(created.code, 0, created.stderr);
    const task = JSON.parse(created.stdout).task;

    const fetched = await runCli(['task', 'get', task.id]);
    assert.equal(fetched.code, 0, fetched.stderr);
    assert.equal(JSON.parse(fetched.stdout).task.payload.source, 'cli');

    const events = await runCli(['events', '--entity-type', 'task', '--limit', '10']);
    assert.equal(events.code, 0, events.stderr);
    assert.ok(JSON.parse(events.stdout).events.length >= 1);

    const listedParticipants = await runCli(['participant', 'list', '--status', 'active']);
    assert.equal(listedParticipants.code, 0, listedParticipants.stderr);
    assert.ok(JSON.parse(listedParticipants.stdout).participants.length >= 1);

    const listedTasks = await runCli(['task', 'list', '--type', 'cli.integration']);
    assert.equal(listedTasks.code, 0, listedTasks.stderr);
    assert.equal(JSON.parse(listedTasks.stdout).tasks[0].type, 'cli.integration');
  } finally {
    await new Promise(resolve => server.close(resolve));
    db.close();
  }
});

test('HTTP API rejects request bodies larger than 16 KiB', async () => {
  const db = openDatabase(':memory:');
  const operatorToken = 'operator-secret-token-'.repeat(2);
  const server = createControlServer({ db, operatorToken });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port + '/control/v1';
  try {
    const response = await fetch(base + '/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + operatorToken },
      body: JSON.stringify({ type: 'oversize.test', payload: 'x'.repeat(17_000) })
    });
    assert.equal(response.status, 413);
  } finally {
    await new Promise(resolve => server.close(error => error ? reject(error) : resolve()));
    db.close();
  }
});


test('operator list endpoints filter and paginate participants and tasks', async () => {
  const db = openDatabase(':memory:');
  const operatorToken = 'list-operator-token-'.repeat(3);
  const server = createControlServer({ db, operatorToken });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port + '/control/v1';
  const headers = { authorization: 'Bearer ' + operatorToken, 'content-type': 'application/json' };
  const call = async (path, options = {}) => fetch(base + path, { headers, ...options });
  try {
    const registered = await call('/participants/register', { method: 'POST', body: JSON.stringify({ displayName: 'list-worker', scopes: ['tasks:claim'] }) });
    assert.equal(registered.status, 201);
    await call('/tasks', { method: 'POST', body: JSON.stringify({ type: 'list.alpha' }) });
    await call('/tasks', { method: 'POST', body: JSON.stringify({ type: 'list.beta' }) });
    const participants = await call('/participants?status=active&kind=worker&limit=10');
    assert.equal(participants.status, 200);
    assert.equal((await participants.json()).page.count, 1);
    const tasks = await call('/tasks?type=list.alpha&limit=1&offset=0');
    assert.equal(tasks.status, 200);
    const taskData = await tasks.json();
    assert.equal(taskData.tasks.length, 1);
    assert.equal(taskData.tasks[0].type, 'list.alpha');
    const invalid = await call('/tasks?status=not-a-state');
    assert.equal(invalid.status, 400);
    const unauthenticated = await fetch(base + '/tasks');
    assert.equal(unauthenticated.status, 401);
  } finally {
    await new Promise(resolve => server.close(resolve));
    db.close();
  }
});
