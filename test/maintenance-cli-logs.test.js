import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/db.js';
import { bootstrapOperatorToken } from '../src/operator-auth.js';

async function runCli(script, args, databasePath) {
  const child = spawn(process.execPath, [script, ...args], {
    cwd: process.cwd(),
    env: { ...process.env, RAYA_CC_DATABASE: databasePath },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const [[code]] = await Promise.all([once(child, 'exit'), once(child.stderr, 'end')]);
  return { code, stdout, stderr, records: stderr.split(/\r?\n/).filter(line => line.startsWith('{')).map(line => JSON.parse(line)) };
}

test('maintenance CLIs emit bounded structured outcomes separately from command output and credentials', { timeout: 20000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'raya-maintenance-log-cli-'));
  const source = join(directory, 'source.sqlite');
  const backup = join(directory, 'backup.sqlite');
  const target = join(directory, 'target.sqlite');
  const originalOperatorToken = 'maintenance-cli-log-test-operator-token-123456';
  try {
    let db = openDatabase(source);
    bootstrapOperatorToken(db, originalOperatorToken);
    db.close();
    db = openDatabase(target);
    db.close();

    const backupRun = await runCli('src/db-backup.js', [backup], source);
    assert.equal(backupRun.code, 0, backupRun.stderr);
    assert.ok(JSON.parse(backupRun.stdout).path);
    assert.ok(backupRun.records.some(record => record.eventName === 'database.backup_completed'));
    assert.ok(backupRun.records.every(record => !JSON.stringify(record).includes(originalOperatorToken)));

    const failedBackupRun = await runCli('src/db-backup.js', [backup], source);
    assert.equal(failedBackupRun.code, 1);
    assert.ok(failedBackupRun.records.some(record => record.eventName === 'database.backup_failed'));
    assert.ok(failedBackupRun.records.every(record => !JSON.stringify(record).includes(backup)));

    const restoreRun = await runCli('src/db-restore.js', [backup], target);
    assert.equal(restoreRun.code, 0, restoreRun.stderr);
    assert.ok(JSON.parse(restoreRun.stdout).rollbackPath);
    assert.ok(restoreRun.records.some(record => record.eventName === 'database.restore_completed'));

    const failedRestoreRun = await runCli('src/db-restore.js', [join(directory, 'missing.sqlite')], target);
    assert.equal(failedRestoreRun.code, 1);
    assert.ok(failedRestoreRun.records.some(record => record.eventName === 'database.restore_failed' && record.errorCode === 'operation-failed'));

    const inspectRun = await runCli('src/db-restore-inspect.js', [], target);
    assert.equal(inspectRun.code, 0, inspectRun.stderr);
    assert.ok(inspectRun.records.some(record => record.eventName === 'database.restore_inspection_completed'));
    assert.ok(inspectRun.records.every(record => !JSON.stringify(record).includes(target)));

    const tokenRun = await runCli('src/rotate-operator-token.js', [], target);
    assert.equal(tokenRun.code, 0, tokenRun.stderr);
    const replacementToken = tokenRun.stdout.trim().split(/\r?\n/).at(-1);
    assert.match(replacementToken, /^[A-Za-z0-9_-]{32,1024}$/);
    assert.ok(tokenRun.records.some(record => record.eventName === 'operator.token_recovery_completed'));
    assert.ok(tokenRun.records.every(record => !JSON.stringify(record).includes(replacementToken)));
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
