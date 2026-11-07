import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { openDatabase } from '../src/db.js';
import { startControlCenter } from '../src/server-runtime.js';

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
    assert.equal(reopened.prepare('PRAGMA user_version').get().user_version, 5);
    reopened.close();
  } finally {
    if (runtime?.server.listening) await runtime.shutdown();
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
