import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/db.js';
import { startControlCenter } from '../src/server-runtime.js';
import { inspectDatabaseFileLock } from '../src/database-runtime-lock.js';

test('shutdown releases SQLite and runtime lock when the listener was already stopped', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'raya-shutdown-listener-stopped-'));
  const databasePath = join(directory, 'server.sqlite');
  const operatorToken = 'shutdown-listener-stopped-test-token-'.repeat(2);
  let runtime;
  try {
    runtime = await startControlCenter({ databasePath, port: 0, operatorToken });
    const lockPath = databasePath + '.runtime.lock';
    assert.equal(inspectDatabaseFileLock(lockPath).active, true);

    await new Promise((resolve, reject) => {
      runtime.server.close(error => error ? reject(error) : resolve());
    });
    assert.equal(runtime.server.listening, false);

    const failedShutdown = runtime.shutdown();
    assert.equal(runtime.shutdown(), failedShutdown, 'a failed shutdown must remain idempotent');
    await assert.rejects(failedShutdown, error => error?.code === 'ERR_SERVER_NOT_RUNNING');
    assert.equal(inspectDatabaseFileLock(lockPath).active, false, 'shutdown error must not strand the runtime lock');

    const reopened = openDatabase(databasePath);
    assert.equal(reopened.prepare('PRAGMA user_version').get().user_version, 5);
    reopened.close();
  } finally {
    if (runtime?.server.listening) await runtime.shutdown();
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
