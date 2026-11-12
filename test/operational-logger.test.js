import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOperationalLogger, safeOperationalErrorCode } from '../src/operational-logger.js';

test('operational logger emits the versioned allowlisted envelope and typed fields', () => {
  const lines = [];
  const logger = createOperationalLogger({
    write: line => lines.push(line),
    now: () => new Date('2026-11-12T10:00:00.000Z'),
    instanceId: 'process-instance-test'
  });
  assert.equal(logger.emit('server.started', { port: 4317 }), true);
  const record = JSON.parse(lines[0]);
  assert.deepEqual(record, {
    schemaVersion: 1, eventName: 'server.started',
    timestamp: '2026-11-12T10:00:00.000Z', severity: 'info',
    processInstanceId: 'process-instance-test',
    eventId: record.eventId, port: 4317
  });
  assert.match(record.eventId, /^[0-9a-f-]{36}$/i);
  assert.ok(lines[0].endsWith('\n'));
});

test('operational logger rejects unknown events, fields, invalid types, and out-of-range values', () => {
  const lines = [];
  const logger = createOperationalLogger({ write: line => lines.push(line) });
  assert.equal(logger.emit('request.body', { body: 'sentinel' }), false);
  assert.equal(logger.emit('server.started', { port: 4317, token: 'secret-sentinel' }), false);
  assert.equal(logger.emit('server.started', { port: '4317' }), false);
  assert.equal(logger.emit('lease.reconciliation_completed', { blockedTaskCount: -1 }), false);
  assert.equal(logger.emit('lease.reconciliation_completed', { blockedTaskCount: 1000001 }), false);
  assert.equal(logger.emit('server.shutdown_failed', { errorCode: 'secret-sentinel-token' }), false);
  assert.equal(lines.length, 0);
});

test('operational logger does not emit credential, payload, URL, or exception sentinels', () => {
  const lines = [];
  const logger = createOperationalLogger({ write: line => lines.push(line) });
  for (const sentinel of [
    'operator-token-sentinel', 'participant-token-sentinel', 'lease-token-sentinel',
    'task-payload-sentinel', 'task-result-sentinel', 'Authorization: Bearer auth-header-sentinel', 'https://user:password@example.test/',
    'exception-message-sentinel'
  ]) {
    assert.equal(logger.emit('server.shutdown_failed', { errorCode: sentinel }), false);
  }
  assert.equal(lines.length, 0);
  assert.equal(lines.join('').includes('sentinel'), false);
});

test('operational logger isolates sink failures from application control flow', () => {
  const lines = [];
  const logger = createOperationalLogger({ write: () => { throw new Error('sink-secret-sentinel'); } });
  assert.equal(logger.emit('server.shutdown_completed'), false);
  assert.equal(safeOperationalErrorCode({ code: 'EADDRINUSE', message: 'do-not-log' }), 'EADDRINUSE');
  assert.equal(safeOperationalErrorCode({ code: 'UNTRUSTED', message: 'do-not-log' }), 'operation-failed');
  const brokenClock = createOperationalLogger({ write: () => {}, now: () => { throw new Error('clock-sentinel'); } });
  assert.equal(brokenClock.emit('server.shutdown_completed'), false);
  const oversized = createOperationalLogger({ write: line => lines.push(line), instanceId: 'x'.repeat(3000) });
  assert.equal(oversized.emit('server.shutdown_completed'), false);
  assert.equal(lines.length, 0);
});

test('operational logger bounds event volume per process and per event name', () => {
  const lines = [];
  const logger = createOperationalLogger({ write: line => lines.push(line) });
  for (let index = 0; index < 100; index++) assert.equal(logger.emit('server.shutdown_completed'), true);
  assert.equal(logger.emit('server.shutdown_completed'), false);
  assert.equal(lines.length, 100);
});

test('child process emits lifecycle events without including the bootstrap token in event records', { timeout: 15000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'raya-operational-log-process-'));
  const databasePath = join(directory, 'server.sqlite');
  const script = [
    "import { startControlCenter } from './src/server-runtime.js';",
    "const runtime = await startControlCenter({ databasePath: process.env.RAYA_CC_DATABASE, port: 0 });",
    "process.stdout.write(runtime.operatorToken + '\\n');",
    "await runtime.shutdown();"
  ].join(' ');
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(),
    env: { ...process.env, RAYA_CC_DATABASE: databasePath, RAYA_CC_PORT: undefined, RAYA_CC_OPERATOR_TOKEN: undefined },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  try {
    const [[code]] = await Promise.all([once(child, 'exit'), once(child.stderr, 'end')]);
    assert.equal(code, 0, stderr);
    const token = stdout.trim();
    assert.match(token, /^[A-Za-z0-9_-]{32,1024}$/);
    const records = stderr.split(/\r?\n/).filter(line => line.startsWith('{')).map(line => JSON.parse(line));
    assert.ok(records.some(record => record.eventName === 'lease.reconciliation_completed'));
    assert.ok(records.some(record => record.eventName === 'server.started'));
    assert.ok(records.some(record => record.eventName === 'server.shutdown_started'));
    assert.ok(records.some(record => record.eventName === 'server.shutdown_completed'));
    assert.ok(records.every(record => !JSON.stringify(record).includes(token)));
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await once(child, 'exit');
    }
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
