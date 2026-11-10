import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { openDatabase } from '../src/db.js';
import { ControlCenter } from '../src/control-center.js';
import { startControlCenter } from '../src/server-runtime.js';
import { inspectDatabaseFileLock } from '../src/database-runtime-lock.js';

test('runtime exposes a newly generated Operator token once and never returns an existing token', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'raya-runtime-token-exposure-'));
  const databasePath = join(directory, 'runtime.sqlite');
  let runtime;
  try {
    runtime = await startControlCenter({ databasePath, port: 0 });
    assert.equal(runtime.operatorTokenCreated, true);
    const initialToken = runtime.operatorToken;
    assert.match(initialToken, /^[A-Za-z0-9_-]{32,1024}$/);
    assert.equal(runtime.operatorToken, undefined, 'the bootstrap token must be consumed after one read');
    await runtime.shutdown();
    runtime = undefined;

    runtime = await startControlCenter({ databasePath, port: 0, operatorToken: initialToken });
    assert.equal(runtime.operatorTokenCreated, false);
    assert.equal(runtime.operatorToken, undefined, 'an existing Operator token is not returned by the runtime');
  } finally {
    if (runtime?.server.listening) await runtime.shutdown();
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
test('offline Operator token recovery is excluded while the server is running and works after shutdown', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'raya-token-recovery-'));
  const databasePath = join(directory, 'recovery.sqlite');
  const originalToken = 'original-offline-recovery-test-token-123456';
  let runtime;
  try {
    runtime = await startControlCenter({ databasePath, port: 0, operatorToken: originalToken });
    const lockPath = databasePath + '.runtime.lock';
    assert.equal(inspectDatabaseFileLock(lockPath).active, true);

    const blocked = spawnSync(process.execPath, ['src/rotate-operator-token.js', databasePath], { cwd: process.cwd(), encoding: 'utf8' });
    assert.equal(blocked.status, 2);
    assert.match(blocked.stderr, /runtime lock prevents access/);
    assert.equal(blocked.stdout.includes(originalToken), false);

    await runtime.shutdown();
    runtime = undefined;
    assert.equal(inspectDatabaseFileLock(lockPath).active, false);

    const recovered = spawnSync(process.execPath, ['src/rotate-operator-token.js', databasePath], { cwd: process.cwd(), encoding: 'utf8' });
    assert.equal(recovered.status, 0, recovered.stderr);
    const token = recovered.stdout.match(/[A-Za-z0-9_-]{40,}/)?.[0] || '';
    assert.equal(token.length >= 32, true);
    assert.notEqual(token, originalToken);

    await assert.rejects(startControlCenter({ databasePath, port: 0, operatorToken: originalToken }), /does not match/);
    runtime = await startControlCenter({ databasePath, port: 0, operatorToken: token });
    assert.equal(runtime.server.listening, true);
  } finally {
    if (runtime?.server.listening) await runtime.shutdown();
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('server runtime drains HTTP and closes SQLite on graceful shutdown', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'raya-server-shutdown-'));
  const databasePath = join(directory, 'server.sqlite');
  const operatorToken = 'server-runtime-test-operator-token-'.repeat(2);
  let runtime;
  try {
    runtime = await startControlCenter({ databasePath, port: 0, operatorToken });
    assert.equal(runtime.server.listening, true);
    assert.equal(runtime.server.address().address, '127.0.0.1');

    const response = await new Promise((resolve, reject) => {
      request({
        host: '127.0.0.1',
        port: runtime.server.address().port,
        path: '/control/v1/health',
        headers: { Host: '127.0.0.1' }
      }, res => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => resolve({ statusCode: res.statusCode, body }));
      }).on('error', reject).end();
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.body, /\"status\":\"ok\"/);

    const firstShutdown = runtime.shutdown();
    const secondShutdown = runtime.shutdown();
    assert.equal(firstShutdown, secondShutdown, 'shutdown must be idempotent');
    await firstShutdown;
    assert.equal(runtime.server.listening, false);

    const reopened = openDatabase(databasePath);
    assert.equal(reopened.prepare('PRAGMA user_version').get().user_version, 6);
    reopened.close();
  } finally {
    if (runtime?.server.listening) await runtime.shutdown();
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('startup reconciliation blocks persisted expired leases for every in-flight task state', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'raya-startup-lease-recovery-'));
  const databasePath = join(directory, 'recovery.sqlite');
  const operatorToken = 'startup-recovery-test-operator-token-'.repeat(2);
  let runtime;
  let inspectionDb;
  try {
    const seedDb = openDatabase(databasePath);
    const center = new ControlCenter(seedDb);
    const worker = center.registerParticipant({ displayName: 'crash-recovery-worker', scopes: ['tasks:claim'] });
    const cases = [];

    for (const previousStatus of ['claimed', 'running', 'cancellation_requested']) {
      const task = center.createTask({ type: 'recovery.' + previousStatus });
      const claim = center.claimTask({ participantId: worker.participant.id, token: worker.token });
      assert.equal(claim.task.id, task.id);
      if (previousStatus !== 'claimed') {
        center.startTask({ taskId: task.id, participantId: worker.participant.id, leaseToken: claim.lease.token });
      }
      if (previousStatus === 'cancellation_requested') center.requestCancellation(task.id);
      seedDb.prepare("UPDATE leases SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(claim.lease.id);
      cases.push({ taskId: task.id, leaseId: claim.lease.id, previousStatus });
    }
    seedDb.close();

    runtime = await startControlCenter({ databasePath, port: 0, operatorToken });
    inspectionDb = openDatabase(databasePath);
    const recovered = new ControlCenter(inspectionDb);

    for (const item of cases) {
      const task = recovered.getTask(item.taskId);
      assert.equal(task.status, 'blocked', item.previousStatus + ' task must be blocked during startup');
      assert.equal(task.leaseId, null);
      assert.equal(task.assignedParticipantId, null);
      assert.equal(inspectionDb.prepare('SELECT status FROM leases WHERE id = ?').get(item.leaseId).status, 'expired');
      const events = recovered.listEvents({ entityType: 'task', entityId: item.taskId, limit: 10 });
      const recoveryEvents = events.filter(event => event.eventType === 'task.lease_expired_blocked');
      assert.equal(recoveryEvents.length, 1, 'startup recovery must append exactly one audit event');
      assert.equal(recoveryEvents[0].data.previousStatus, item.previousStatus);
      assert.equal(recoveryEvents[0].data.leaseId, item.leaseId);
    }
  } finally {
    inspectionDb?.close();
    if (runtime?.server.listening) await runtime.shutdown();
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('server process crash releases its runtime lock and startup recovers its active task lease', { timeout: 15000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'raya-server-process-crash-'));
  const databasePath = join(directory, 'crash.sqlite');
  const operatorToken = 'server-process-crash-recovery-token-'.repeat(2);
  let child;
  let runtime;
  let inspectionDb;
  try {
    const workerPath = fileURLToPath(new URL('../test-support/server-crash-recovery-worker.js', import.meta.url));
    child = spawn(process.execPath, [workerPath, databasePath, operatorToken], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });

    const ready = await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('crash worker did not become ready: ' + stderr)), 8000);
      const onData = () => {
        const line = stdout.split(String.fromCharCode(10)).find(value => value.startsWith('{'));
        if (!line) return;
        clearTimeout(deadline);
        child.stdout.off('data', onData);
        try { resolve(JSON.parse(line)); } catch (error) { reject(error); }
      };
      child.stdout.on('data', onData);
      child.once('error', error => { clearTimeout(deadline); reject(error); });
      child.once('exit', (code, signal) => {
        clearTimeout(deadline);
        reject(new Error('crash worker exited before readiness (' + code + ', ' + signal + '): ' + stderr));
      });
    });

    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    const [exitCode, signal] = await exited;
    assert.ok(signal !== null || exitCode !== 0, 'server process must terminate uncleanly');
    child = undefined;
    assert.equal(inspectDatabaseFileLock(databasePath + '.runtime.lock').active, false);

    inspectionDb = openDatabase(databasePath);
    inspectionDb.prepare("UPDATE leases SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(ready.leaseId);
    inspectionDb.close();
    inspectionDb = undefined;

    runtime = await startControlCenter({ databasePath, port: 0, operatorToken });
    inspectionDb = openDatabase(databasePath);
    const recovered = new ControlCenter(inspectionDb);
    const task = recovered.getTask(ready.taskId);
    assert.equal(task.status, 'blocked');
    assert.equal(task.leaseId, null);
    assert.equal(inspectionDb.prepare('SELECT status FROM leases WHERE id = ?').get(ready.leaseId).status, 'expired');
    const events = recovered.listEvents({ entityType: 'task', entityId: ready.taskId, limit: 10 });
    const recoveryEvents = events.filter(event => event.eventType === 'task.lease_expired_blocked');
    assert.equal(recoveryEvents.length, 1);
    assert.equal(recoveryEvents[0].data.previousStatus, 'running');
    assert.equal(recoveryEvents[0].data.leaseId, ready.leaseId);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await once(child, 'exit');
    }
    inspectionDb?.close();
    if (runtime?.server.listening) await runtime.shutdown();
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('startup listener failure closes SQLite and releases the runtime lock', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'raya-listener-failure-'));
  const occupiedDatabase = join(directory, 'occupied.sqlite');
  const failedDatabase = join(directory, 'failed.sqlite');
  const operatorToken = 'listener-failure-test-operator-token-'.repeat(2);
  let occupiedRuntime;
  try {
    occupiedRuntime = await startControlCenter({ databasePath: occupiedDatabase, port: 0, operatorToken });
    const occupiedPort = occupiedRuntime.server.address().port;

    await assert.rejects(
      startControlCenter({ databasePath: failedDatabase, port: occupiedPort, operatorToken }),
      error => error?.code === 'EADDRINUSE'
    );

    assert.equal(inspectDatabaseFileLock(failedDatabase + '.runtime.lock').active, false, 'failed startup must release its runtime lock');
    const reopened = openDatabase(failedDatabase);
    assert.equal(reopened.prepare('PRAGMA user_version').get().user_version, 6);
    reopened.close();
    assert.equal(occupiedRuntime.server.listening, true, 'the existing listener must remain available');
  } finally {
    if (occupiedRuntime?.server.listening) await occupiedRuntime.shutdown();
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
