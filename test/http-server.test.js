import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { spawn } from 'node:child_process';
import { openDatabase } from '../src/db.js';
import { bootstrapOperatorToken, rotateOperatorToken } from '../src/operator-auth.js';
import { createControlServer } from '../src/http-server.js';

const jsonHeaders = { 'content-type': 'application/json' };

test('operator token is bootstrapped once, verified on restart, and rotatable', () => {
  const invalidDb = openDatabase(':memory:');
  assert.throws(() => bootstrapOperatorToken(invalidDb, 'invalid+token/'.padEnd(40, 'x')), /letters, digits, underscore, or hyphen/);
  assert.throws(() => bootstrapOperatorToken(invalidDb, 'x'.repeat(32) + String.fromCharCode(10)), /letters, digits, underscore, or hyphen/);
  assert.throws(() => bootstrapOperatorToken(invalidDb, 'x'.repeat(1025)), /letters, digits, underscore, or hyphen/);
  assert.throws(() => bootstrapOperatorToken(invalidDb, 'x'.repeat(32) + '\\n'), /letters, digits, underscore, or hyphen/);
  assert.equal(invalidDb.prepare('SELECT value FROM settings').get(), undefined);
  invalidDb.close();
  const db = openDatabase(':memory:');
  const first = bootstrapOperatorToken(db);
  assert.equal(first.created, true);
  assert.equal(first.token.length >= 32, true);
  assert.match(first.token, /^[A-Za-z0-9_-]+$/);
  assert.throws(() => bootstrapOperatorToken(db, 'invalid+token/'.padEnd(40, 'x')), /letters, digits, underscore, or hyphen/);
  const second = bootstrapOperatorToken(db, first.token);
  assert.equal(second.created, false);
  assert.equal(second.token, first.token);
  assert.throws(() => bootstrapOperatorToken(db, 'x'.repeat(40)), /does not match/);
  const rotated = rotateOperatorToken(db);
  assert.notEqual(rotated, first.token);
  assert.equal(bootstrapOperatorToken(db, rotated).created, false);
  db.close();
});

test('in-flight Operator request is re-authorized after token rotation', async () => {
  const db = openDatabase(':memory:');
  const originalToken = 'operator-inflight-rotation-token-123456';
  const server = createControlServer({ db, operatorToken: originalToken });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port + '/control/v1';
  const body = JSON.stringify({ type: 'rotation.race.task' });
  let pending;
  let inFlightRequest;
  try {
    pending = new Promise((resolve, reject) => {
      inFlightRequest = httpRequest(base + '/tasks', {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + originalToken,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body)
        }
      }, response => {
        let responseBody = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { responseBody += chunk; });
        response.on('end', () => resolve({ status: response.statusCode, body: responseBody }));
      });
      inFlightRequest.on('error', reject);
      inFlightRequest.write(body.slice(0, 8));
    });

    const rotated = await fetch(base + '/operator/rotate-token', {
      method: 'POST', headers: { authorization: 'Bearer ' + originalToken }
    });
    assert.equal(rotated.status, 200);
    inFlightRequest.end(body.slice(8));
    const result = await pending;
    assert.equal(result.status, 401, 'a request whose body completes after rotation must not retain stale authorization');
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE type = 'rotation.race.task'").get().count, 0);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    db.close();
  }
});
test('operator token rotation is immediate and invalidates the previous token', async () => {
  const db = openDatabase(':memory:');
  const originalToken = 'operator-rotation-original-token-123456';
  assert.throws(() => createControlServer({ db, operatorToken: 'invalid+token/'.padEnd(40, 'x') }), /URL-safe/);
  assert.throws(() => createControlServer({ db, operatorToken: 'x'.repeat(32) + String.fromCharCode(10) }), /URL-safe/);
  assert.throws(() => createControlServer({ db, operatorToken: 'x'.repeat(1025) }), /URL-safe/);
  assert.throws(() => createControlServer({ db, operatorToken: 'x'.repeat(32) + '\\n' }), /URL-safe/);
  const server = createControlServer({ db, operatorToken: originalToken });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port + '/control/v1';
  const call = (token, path, options = {}) => fetch(base + path, {
    ...options, headers: { authorization: 'Bearer ' + token, ...(options.headers || {}) }
  });
  try {
    const unauthenticated = await fetch(base + '/operator/rotate-token', { method: 'POST' });
    assert.equal(unauthenticated.status, 401);

    const rotated = await call(originalToken, '/operator/rotate-token', { method: 'POST' });
    assert.equal(rotated.status, 200);
    const result = await rotated.json();
    assert.equal(result.rotated, true);
    assert.equal(typeof result.token, 'string');
    assert.notEqual(result.token, originalToken);

    assert.equal((await call(originalToken, '/tasks')).status, 401);
    assert.equal((await call(result.token, '/tasks')).status, 200);

    const concurrentRotations = await Promise.all([
      call(result.token, '/operator/rotate-token', { method: 'POST' }),
      call(result.token, '/operator/rotate-token', { method: 'POST' })
    ]);
    assert.deepEqual(concurrentRotations.map(response => response.status).sort(), [200, 401],
      'only one concurrent rotation using the same current token may succeed');
    const winningResponse = concurrentRotations.find(response => response.status === 200);
    const winningResult = await winningResponse.json();
    assert.equal(winningResult.rotated, true);
    assert.equal((await call(result.token, '/tasks')).status, 401,
      'the token used by the competing requests is invalidated');
    assert.equal((await call(winningResult.token, '/tasks')).status, 200,
      'the single winning replacement token remains valid');
    db.close();
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    try { db.close(); } catch {}
  }
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
    const progress = await fetch(base + '/tasks/' + created.task.id + '/progress', { method: 'POST', headers: leaseHeaders, body: JSON.stringify({ percent: 50, message: 'Halfway' }) });
    assert.equal(progress.status, 200);
    assert.equal((await progress.json()).task.progress.percent, 50);

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
    server.closeAllConnections();
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
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    db.close();
  }
});

test('CLI rejects remote and malformed API overrides before sending operator credentials', async () => {
  const token = 'cli-secret-never-forward-this-token';
  const invalidUrls = [
    'https://attacker.example/control/v1',
    'http://attacker.example/control/v1',
    'http://attacker.example@localhost/control/v1',
    'http://127.0.0.1.evil/control/v1',
    'http://127.0.0.1/other',
    'http://127.0.0.1/control/v1?redirect=1'
  ];
  for (const url of invalidUrls) {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['src/cli.js', 'task', 'list'], {
        cwd: process.cwd(),
        env: { ...process.env, RAYA_CC_URL: url, RAYA_CC_OPERATOR_TOKEN: token },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
      child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
      child.once('error', reject);
      child.once('close', code => resolve({ code, stdout, stderr }));
    });
    assert.notEqual(result.code, 0, url);
    assert.match(result.stderr, /RAYA_CC_URL must/);
    assert.equal(result.stderr.includes(token), false);
  }
});

test('CLI redacts the operator token if an API error echoes it', async () => {
  const token = 'cli-token-must-never-appear-in-error-output';
  const fake = createHttpServer((req, res) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'internal_error', message: 'upstream echoed ' + req.headers.authorization } }));
  });
  await new Promise(resolve => fake.listen(0, '127.0.0.1', resolve));
  try {
    const base = 'http://127.0.0.1:' + fake.address().port + '/control/v1';
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['src/cli.js', 'task', 'list'], {
        cwd: process.cwd(), env: { ...process.env, RAYA_CC_URL: base, RAYA_CC_OPERATOR_TOKEN: token },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let stdout = ''; let stderr = '';
      child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
      child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
      child.once('error', reject);
      child.once('close', code => resolve({ code, stdout, stderr }));
    });
    assert.notEqual(result.code, 0);
    assert.equal((result.stdout + result.stderr).includes(token), false);
    assert.match(result.stderr, /\[REDACTED\]/);
  } finally {
    fake.closeAllConnections();
    await new Promise(resolve => fake.close(resolve));
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
    assert.equal(response.headers.get('connection'), 'close');
  } finally {
    server.closeAllConnections();
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
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    db.close();
  }
});

test('serves the read-only dashboard and static assets with restrictive security headers', async () => {
  const db = openDatabase(':memory:');
  const server = createControlServer({ db, operatorToken: 'dashboard-test-operator-token-'.repeat(2) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const page = await fetch(base + '/');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(page.headers.get('x-frame-options'), 'DENY');
    const pageText = await page.text();
    assert.match(pageText, /Read-only operational overview/);
    assert.match(pageText, /Required capabilities/);
    assert.match(pageText, /Capabilities/);
    assert.match(pageText, /id="metric-unmatched"/);
    assert.match(pageText, /Active claim-capable participants/);

    const script = await fetch(base + '/dashboard.js');
    assert.equal(script.status, 200);
    assert.match(script.headers.get('content-type'), /javascript/);
    const scriptText = await script.text();
    assert.match(scriptText, /let operatorToken =/);
    assert.doesNotMatch(scriptText, /localStorage|sessionStorage/);
    assert.match(scriptText, /textContent/);
    assert.match(scriptText, /routing\/summary/);
    assert.match(scriptText, /metric-unmatched/);
    assert.doesNotMatch(scriptText, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/);
    assert.doesNotMatch(scriptText, /console\.(?:log|error|warn)/);
    assert.doesNotMatch(scriptText, /task\.(?:payload|result)/);

    const stylesheet = await fetch(base + '/dashboard.css');
    assert.equal(stylesheet.status, 200);
    assert.match(stylesheet.headers.get('content-type'), /text\/css/);

    const deniedMethod = await fetch(base + '/', { method: 'POST' });
    assert.equal(deniedMethod.status, 405);
    const query = await fetch(base + '/dashboard.js?x=1');
    assert.equal(query.status, 400);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    db.close();
  }
});


test('HTTP Operator capability management and capability-aware task claims', async () => {
  const db = openDatabase(':memory:');
  const operatorToken = 'operator-capability-routing-test-token-123456';
  const server = createControlServer({ db, operatorToken });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port + '/control/v1';
  const operator = { authorization: 'Bearer ' + operatorToken, 'content-type': 'application/json' };
  const request = (path, options = {}) => fetch(base + path, options);
  try {
    const summaryDenied = await request('/routing/summary');
    assert.equal(summaryDenied.status, 401);
    const initialSummary = await request('/routing/summary', { headers: operator });
    assert.equal(initialSummary.status, 200);
    assert.deepEqual((await initialSummary.json()).routing, { queuedTasks: 0, unmatchedQueuedTasks: 0, activeClaimParticipants: 0 });
    const registration = await request('/participants/register', { method: 'POST', headers: operator,
      body: JSON.stringify({ displayName: 'capability-http-worker', scopes: ['tasks:claim'], capabilities: ['worker:python'] }) });
    assert.equal(registration.status, 201);
    const registered = await registration.json();
    assert.deepEqual(registered.participant.capabilities, ['worker:python']);
    const participantList = await request('/participants', { headers: operator });
    assert.deepEqual((await participantList.json()).participants[0].capabilities, ['worker:python']);
    const taskResponse = await request('/tasks', { method: 'POST', headers: operator,
      body: JSON.stringify({ type: 'http.capability.task', requiredCapabilities: ['worker:python'] }) });
    assert.equal(taskResponse.status, 201);
    const task = (await taskResponse.json()).task;
    assert.deepEqual(task.requiredCapabilities, ['worker:python']);
    const queuedSummary = await request('/routing/summary', { headers: operator });
    assert.deepEqual((await queuedSummary.json()).routing, { queuedTasks: 1, unmatchedQueuedTasks: 0, activeClaimParticipants: 1 });
    const claim = await request('/tasks/claim', { method: 'POST', headers: { authorization: 'Bearer ' + registered.token, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(claim.status, 200);
    const claimed = (await claim.json()).claim;
    assert.equal(claimed.task.id, task.id);
    const leaseBefore = db.prepare('SELECT id, status, expires_at FROM leases WHERE id = ?').get(claimed.lease.id);
    const capabilityUpdateDenied = await request('/participants/' + registered.participant.id + '/capabilities', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ capabilities: ['worker:admin'] }) });
    assert.equal(capabilityUpdateDenied.status, 401, 'Only the Operator may change Participant capabilities');
    assert.deepEqual(JSON.parse(db.prepare('SELECT capabilities_json FROM participants WHERE id = ?').get(registered.participant.id).capabilities_json), ['worker:python']);
    const updated = await request('/participants/' + registered.participant.id + '/capabilities', { method: 'POST', headers: operator,
      body: JSON.stringify({ capabilities: ['worker:node'] }) });
    assert.equal(updated.status, 200);
    assert.deepEqual((await updated.json()).participant.capabilities, ['worker:node']);
    assert.deepEqual(db.prepare('SELECT id, status, expires_at FROM leases WHERE id = ?').get(claimed.lease.id), leaseBefore);
    const audit = db.prepare("SELECT event_type FROM events WHERE entity_id = ? AND event_type = 'participant.capabilities_updated'").get(registered.participant.id);
    assert.equal(audit.event_type, 'participant.capabilities_updated');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    db.close();
  }
});

test('in-flight participant lease action is rejected when participant is revoked during body upload', async () => {
  const db = openDatabase(':memory:');
  const operatorToken = 'operator-participant-race-token-123456';
  const server = createControlServer({ db, operatorToken });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port + '/control/v1';
  const operatorHeaders = { ...jsonHeaders, authorization: 'Bearer ' + operatorToken };
  let inFlightRequest;
  try {
    const registeredResponse = await fetch(base + '/participants/register', {
      method: 'POST', headers: operatorHeaders,
      body: JSON.stringify({ displayName: 'participant-race', scopes: ['tasks:claim'] })
    });
    assert.equal(registeredResponse.status, 201);
    const registered = await registeredResponse.json();

    const createdResponse = await fetch(base + '/tasks', {
      method: 'POST', headers: operatorHeaders,
      body: JSON.stringify({ type: 'participant.revocation.race' })
    });
    assert.equal(createdResponse.status, 201);
    const taskId = (await createdResponse.json()).task.id;

    const claimResponse = await fetch(base + '/tasks/claim', {
      method: 'POST',
      headers: { ...jsonHeaders, authorization: 'Bearer ' + registered.token },
      body: '{}'
    });
    assert.equal(claimResponse.status, 200);
    const leaseToken = (await claimResponse.json()).claim.lease.token;
    const started = await fetch(base + '/tasks/' + taskId + '/start', {
      method: 'POST',
      headers: { ...jsonHeaders, authorization: 'Bearer ' + registered.token, 'x-lease-token': leaseToken },
      body: '{}'
    });
    assert.equal(started.status, 200);

    const lastSeenBeforeRace = db.prepare('SELECT last_seen_at FROM participants WHERE id = ?').get(registered.participant.id).last_seen_at;
    await new Promise(resolve => setTimeout(resolve, 10));
    const body = JSON.stringify({ result: { marker: 'must-not-commit-after-revocation' } });
    const pending = new Promise((resolve, reject) => {
      inFlightRequest = httpRequest(base + '/tasks/' + taskId + '/complete', {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + registered.token,
          'x-lease-token': leaseToken,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body)
        }
      }, response => {
        let responseBody = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { responseBody += chunk; });
        response.on('end', () => resolve({ status: response.statusCode, body: responseBody }));
      });
      inFlightRequest.on('error', reject);
      inFlightRequest.write(body.slice(0, 8));
    });

    const authDeadline = Date.now() + 2000;
    while (Date.now() < authDeadline) {
      const lastSeen = db.prepare('SELECT last_seen_at FROM participants WHERE id = ?').get(registered.participant.id).last_seen_at;
      if (lastSeen !== lastSeenBeforeRace) break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.notEqual(db.prepare('SELECT last_seen_at FROM participants WHERE id = ?').get(registered.participant.id).last_seen_at, lastSeenBeforeRace, 'request must pass initial participant authentication before revocation');

    const revoked = await fetch(base + '/participants/' + registered.participant.id + '/revoke', {
      method: 'POST', headers: operatorHeaders, body: '{}'
    });
    assert.equal(revoked.status, 200);
    inFlightRequest.end(body.slice(8));

    const result = await pending;
    assert.equal(result.status, 409, 'lease must be revalidated after the delayed request body is read');
    const task = db.prepare('SELECT status, result_json FROM tasks WHERE id = ?').get(taskId);
    assert.equal(task.status, 'blocked');
    assert.equal(task.result_json, null);
  } finally {
    inFlightRequest?.destroy();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    db.close();
  }
});

test('in-flight task claim is rejected when participant is revoked during body upload', async () => {
  const db = openDatabase(':memory:');
  const operatorToken = 'operator-claim-race-token-123456';
  const server = createControlServer({ db, operatorToken });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port + '/control/v1';
  const operatorHeaders = { ...jsonHeaders, authorization: 'Bearer ' + operatorToken };
  let inFlightRequest;
  try {
    const registeredResponse = await fetch(base + '/participants/register', {
      method: 'POST', headers: operatorHeaders,
      body: JSON.stringify({ displayName: 'claim-race', scopes: ['tasks:claim'] })
    });
    assert.equal(registeredResponse.status, 201);
    const registered = await registeredResponse.json();

    const createdResponse = await fetch(base + '/tasks', {
      method: 'POST', headers: operatorHeaders,
      body: JSON.stringify({ type: 'participant.claim.race' })
    });
    assert.equal(createdResponse.status, 201);
    const taskId = (await createdResponse.json()).task.id;
    const lastSeenBeforeRace = db.prepare('SELECT last_seen_at FROM participants WHERE id = ?').get(registered.participant.id).last_seen_at;
    await new Promise(resolve => setTimeout(resolve, 10));
    const body = '{}';

    const pending = new Promise((resolve, reject) => {
      inFlightRequest = httpRequest(base + '/tasks/claim', {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + registered.token,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body)
        }
      }, response => {
        let responseBody = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { responseBody += chunk; });
        response.on('end', () => resolve({ status: response.statusCode, body: responseBody }));
      });
      inFlightRequest.on('error', reject);
      inFlightRequest.write(body.slice(0, 1));
    });

    const authDeadline = Date.now() + 2000;
    while (Date.now() < authDeadline) {
      const lastSeen = db.prepare('SELECT last_seen_at FROM participants WHERE id = ?').get(registered.participant.id).last_seen_at;
      if (lastSeen !== lastSeenBeforeRace) break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.notEqual(db.prepare('SELECT last_seen_at FROM participants WHERE id = ?').get(registered.participant.id).last_seen_at, lastSeenBeforeRace,
      'claim request must pass initial participant authentication before revocation');

    const revoked = await fetch(base + '/participants/' + registered.participant.id + '/revoke', {
      method: 'POST', headers: operatorHeaders, body: '{}'
    });
    assert.equal(revoked.status, 200);
    inFlightRequest.end(body.slice(1));

    const result = await pending;
    assert.equal(result.status, 401, 'claim must re-check participant status after body upload');
    const task = db.prepare('SELECT status, assigned_participant_id, lease_id FROM tasks WHERE id = ?').get(taskId);
    assert.equal(task.status, 'queued');
    assert.equal(task.assigned_participant_id, null);
    assert.equal(task.lease_id, null);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM leases WHERE task_id = ?').get(taskId).count, 0);
  } finally {
    inFlightRequest?.destroy();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    db.close();
  }
});

test('in-flight lease action is rejected when lease expires during body upload', async () => {
  const db = openDatabase(':memory:');
  const operatorToken = 'operator-expiry-race-token-123456';
  const server = createControlServer({ db, operatorToken });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port + '/control/v1';
  const operatorHeaders = { ...jsonHeaders, authorization: 'Bearer ' + operatorToken };
  let inFlightRequest;
  try {
    const registration = await fetch(base + '/participants/register', {
      method: 'POST', headers: operatorHeaders,
      body: JSON.stringify({ displayName: 'lease-expiry-race', scopes: ['tasks:claim'] })
    });
    assert.equal(registration.status, 201);
    const participant = await registration.json();
    const createdResponse = await fetch(base + '/tasks', {
      method: 'POST', headers: operatorHeaders, body: JSON.stringify({ type: 'lease.expiry.race' })
    });
    assert.equal(createdResponse.status, 201);
    const taskId = (await createdResponse.json()).task.id;
    const claimResponse = await fetch(base + '/tasks/claim', {
      method: 'POST', headers: { ...jsonHeaders, authorization: 'Bearer ' + participant.token }, body: '{}'
    });
    assert.equal(claimResponse.status, 200);
    const claim = (await claimResponse.json()).claim;
    const leaseHeaders = { ...jsonHeaders, authorization: 'Bearer ' + participant.token, 'x-lease-token': claim.lease.token };
    const started = await fetch(base + '/tasks/' + taskId + '/start', { method: 'POST', headers: leaseHeaders, body: '{}' });
    assert.equal(started.status, 200);

    const lastSeenBeforeRace = db.prepare('SELECT last_seen_at FROM participants WHERE id = ?').get(participant.participant.id).last_seen_at;
    await new Promise(resolve => setTimeout(resolve, 10));
    const body = JSON.stringify({ result: { marker: 'must-not-commit-after-expiry' } });
    const pending = new Promise((resolve, reject) => {
      inFlightRequest = httpRequest(base + '/tasks/' + taskId + '/complete', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + participant.token, 'x-lease-token': claim.lease.token,
          'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }
      }, response => {
        let responseBody = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { responseBody += chunk; });
        response.on('end', () => resolve({ status: response.statusCode, body: responseBody }));
      });
      inFlightRequest.on('error', reject);
      inFlightRequest.write(body.slice(0, 8));
    });

    const authDeadline = Date.now() + 2000;
    while (Date.now() < authDeadline) {
      const lastSeen = db.prepare('SELECT last_seen_at FROM participants WHERE id = ?').get(participant.participant.id).last_seen_at;
      if (lastSeen !== lastSeenBeforeRace) break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.notEqual(db.prepare('SELECT last_seen_at FROM participants WHERE id = ?').get(participant.participant.id).last_seen_at,
      lastSeenBeforeRace, 'request must pass initial participant authentication before lease expiry');

    db.prepare('UPDATE leases SET expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), claim.lease.id);
    inFlightRequest.end(body.slice(8));
    const result = await pending;
    assert.equal(result.status, 409, 'expired lease must be rejected after delayed request body is read');
    const task = db.prepare('SELECT status, result_json FROM tasks WHERE id = ?').get(taskId);
    assert.equal(task.status, 'running');
    assert.equal(task.result_json, null);
  } finally {
    inFlightRequest?.destroy();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    db.close();
  }
});
