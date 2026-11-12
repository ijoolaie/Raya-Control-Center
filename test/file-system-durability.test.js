import test from 'node:test';
import assert from 'node:assert/strict';
import { syncDirectory } from '../src/file-system-durability.js';

test('directory sync is explicitly unsupported on Windows Node runtimes', () => {
  let calls = 0;
  const result = syncDirectory('C:\\data', {
    platform: 'win32',
    open() { calls++; throw new Error('must-not-open'); },
    fsync() { calls++; },
    close() { calls++; }
  });
  assert.equal(result.supported, false);
  assert.match(result.reason, /Windows directory-handle flush/);
  assert.equal(calls, 0);
});

test('directory sync flushes and closes a POSIX directory descriptor', () => {
  const calls = [];
  const result = syncDirectory('/var/lib/raya', {
    platform: 'linux',
    open(path, flags) { calls.push(['open', path, flags]); return 42; },
    fsync(fd) { calls.push(['fsync', fd]); },
    close(fd) { calls.push(['close', fd]); }
  });
  assert.deepEqual(result, { supported: true });
  assert.deepEqual(calls, [['open', '/var/lib/raya', 'r'], ['fsync', 42], ['close', 42]]);
});

test('directory sync propagates flush failures and still closes the descriptor', () => {
  const calls = [];
  assert.throws(() => syncDirectory('/var/lib/raya', {
    platform: 'linux',
    open() { return 7; },
    fsync(fd) { calls.push(['fsync', fd]); throw Object.assign(new Error('injected-dir-fsync'), { code: 'EIO' }); },
    close(fd) { calls.push(['close', fd]); }
  }), /injected-dir-fsync/);
  assert.deepEqual(calls, [['fsync', 7], ['close', 7]]);
});import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('real POSIX directory fsync works on the current filesystem', { skip: process.platform === 'win32' }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'raya-directory-fsync-'));
  try {
    assert.deepEqual(syncDirectory(directory), { supported: true });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
