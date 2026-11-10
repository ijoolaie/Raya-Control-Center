import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db.js';
import { ControlCenter } from '../src/control-center.js';
import { createControlServer } from '../src/http-server.js';

const workerPath = fileURLToPath(new URL('../examples/reference-worker/worker.mjs', import.meta.url));

async function harness(run) {
  const db = openDatabase(':memory:');
  const center = new ControlCenter(db, { leaseDurationMs: 3000 });
  const operatorToken = 'reference-worker-operator-token-'.repeat(2);
  const server = createControlServer({ db, operatorToken });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port + '/control/v1';
  const operatorHeaders = { authorization: 'Bearer ' + operatorToken, 'content-type': 'application/json' };
  const register = async () => {
    const response = await fetch(base + '/participants/register', {
      method: 'POST', headers: operatorHeaders,
      body: JSON.stringify({ displayName: 'reference-worker-test', kind: 'worker', scopes: ['tasks:claim'] })
    });
    assert.equal(response.status, 201);
    return response.json();
  };
  const createTask = async (type, payload = {}) => {
    const response = await fetch(base + '/tasks', {
      method: 'POST', headers: operatorHeaders, body: JSON.stringify({ type, payload })
    });
    assert.equal(response.status, 201);
    return (await response.json()).task;
  };
  const getTask = id => center.getTask(id);
  const startWorker = (token, extra = {}) => {
    const child = spawn(process.execPath, [workerPath], {
      env: {
        ...process.env,
        RAYA_CC_URL: base,
        RAYA_CC_PARTICIPANT_TOKEN: token,
        RAYA_CC_POLL_MS: '100',
        RAYA_CC_LEASE_MS: '3000',
        RAYA_CC_MAX_TASKS: '1',
        ...extra
      },
      stdio: ['ignore', 'ignore', 'pipe']
    });
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    return { child, get stderr() { return stderr; } };
  };
  try {
    await run({ db, center, base, register, createTask, getTask, startWorker, server });
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    db.close();
  }
}

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for worker state');
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error('worker did not stop')), 3000))]);
}

test('real worker process executes allowlisted echo and completes task without Operator credentials', async () => {
  await harness(async ({ register, createTask, getTask, startWorker }) => {
    const participant = await register();
    const task = await createTask('demo.echo', { value: 'safe-data' });
    const worker = startWorker(participant.token);
    try {
      await waitFor(() => getTask(task.id).status === 'succeeded');
      assert.equal(getTask(task.id).progress.percent, 100);
      assert.equal(getTask(task.id).status, 'succeeded');
    } finally { await stop(worker.child); }
  });
});

test('real worker process cooperatively acknowledges cancellation during a delay task', async () => {
  await harness(async ({ register, createTask, getTask, startWorker, base }) => {
    const participant = await register();
    const task = await createTask('demo.delay', { durationMs: 4000 });
    const worker = startWorker(participant.token);
    try {
      await waitFor(() => getTask(task.id).status === 'running');
      const response = await fetch(base + '/tasks/' + task.id + '/cancel-request', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + 'reference-worker-operator-token-'.repeat(2), 'content-type': 'application/json' },
        body: '{}'
      });
      assert.equal(response.status, 200);
      await waitFor(() => getTask(task.id).status === 'cancelled');
    } finally { await stop(worker.child); }
  });
});


test('worker renews a lease while a bounded delay task runs to completion', async () => {
  await harness(async ({ register, createTask, getTask, startWorker }) => {
    const participant = await register();
    const task = await createTask('demo.delay', { durationMs: 3500 });
    const worker = startWorker(participant.token);
    try {
      await waitFor(() => getTask(task.id).status === 'succeeded', 7000);
      assert.equal(getTask(task.id).status, 'succeeded');
    } finally { await stop(worker.child); }
  });
});

test('worker refuses unknown task types and marks them failed without executing payload', async () => {
  await harness(async ({ register, createTask, getTask, startWorker }) => {
    const participant = await register();
    const task = await createTask('arbitrary.shell', { command: 'this must never run' });
    const worker = startWorker(participant.token);
    try {
      await waitFor(() => getTask(task.id).status === 'failed');
      assert.equal(getTask(task.id).status, 'failed');
    } finally { await stop(worker.child); }
  });
});

test('worker exits cleanly on SIGTERM while waiting for work', async () => {
  await harness(async ({ register, startWorker }) => {
    const participant = await register();
    const worker = startWorker(participant.token);
    await waitFor(() => worker.child.pid);
    await stop(worker.child);
    assert.ok(worker.child.exitCode === 0 || worker.child.signalCode !== null);
  });
});

test('worker safely abandons a task after its lease expires and reconciliation blocks it', async () => {
  await harness(async ({ register, createTask, getTask, startWorker, db, center }) => {
    const participant = await register();
    const task = await createTask('demo.delay', { durationMs: 5000 });
    const worker = startWorker(participant.token);
    try {
      await waitFor(() => getTask(task.id).status === 'running');
      db.prepare("UPDATE leases SET expires_at = '2000-01-01T00:00:00.000Z' WHERE task_id = ? AND status = 'active'").run(task.id);
      assert.deepEqual(center.reconcileExpiredLeases(), [task.id]);
      await waitFor(() => getTask(task.id).status === 'blocked');
      await waitFor(() => worker.child.exitCode !== null || worker.child.signalCode !== null);
      assert.equal(getTask(task.id).status, 'blocked');
      assert.equal(getTask(task.id).result, null, 'expired worker must not store a task result');
      const events = center.listEvents({ entityType: 'task', entityId: task.id, limit: 20 });
      assert.equal(events.some(event => event.eventType === 'task.succeeded'), false);
      assert.equal(events.some(event => event.eventType === 'task.failed'), false);
      assert.equal(events.filter(event => event.eventType === 'task.lease_expired_blocked').length, 1);
    } finally { await stop(worker.child); }
  });
});

test('worker waits safely on an empty queue and later claims newly queued work', async () => {
  await harness(async ({ register, createTask, getTask, startWorker }) => {
    const participant = await register();
    const worker = startWorker(participant.token, { RAYA_CC_MAX_TASKS: '1' });
    try {
      await new Promise(resolve => setTimeout(resolve, 250));
      const task = await createTask('demo.echo', { value: 'arrived-later' });
      await waitFor(() => getTask(task.id).status === 'succeeded');
      assert.equal(getTask(task.id).status, 'succeeded');
    } finally { await stop(worker.child); }
  });
});