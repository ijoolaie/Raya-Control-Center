import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * Application-level protocol model only.
 * This in-memory adapter intentionally does NOT model OS handles, fsync,
 * rename/link atomicity, SQLite, process death, or filesystem durability.
 */
class FakeRestoreAdapter {
  constructor({ destination = 'original-db', backup = 'backup-db' } = {}) {
    this.files = new Map([['destination', destination], ['backup', backup]]);
    this.trace = [];
  }

  exists(name) { return this.files.has(name); }
  read(name) { return this.files.get(name); }
  createExclusive(name, value) {
    if (this.exists(name)) throw new Error(`already-exists:${name}`);
    this.files.set(name, value);
  }
  linkNoReplace(source, target) {
    if (!this.exists(source)) throw new Error(`missing-source:${source}`);
    if (this.exists(target)) throw new Error(`already-exists:${target}`);
    this.files.set(target, this.read(source));
  }
  unlink(name) {
    if (!this.files.delete(name)) throw new Error(`missing-entry:${name}`);
  }
  record(boundary) { this.trace.push(boundary); }
}

const boundaries = [
  'journal-temp-created',
  'intent-published',
  'stage-created',
  'stage-validated-and-flushed',
  'rollback-published',
  'original-name-removed',
  'new-live-published',
  'stage-name-removed',
  'journal-removed'
];

function runModel(adapter, crashAt = null) {
  const step = (name, action) => {
    action();
    adapter.record(name);
    if (crashAt === name) throw Object.assign(new Error('injected-crash'), { boundary: name });
  };

  step('journal-temp-created', () => adapter.createExclusive('journal-temp', 'intent'));
  step('intent-published', () => {
    adapter.linkNoReplace('journal-temp', 'journal');
    adapter.unlink('journal-temp');
  });
  step('stage-created', () => adapter.createExclusive('stage', adapter.read('backup')));
  step('stage-validated-and-flushed', () => {
    assert.equal(adapter.read('stage'), adapter.read('backup'));
  });
  step('rollback-published', () => adapter.linkNoReplace('destination', 'rollback'));
  step('original-name-removed', () => adapter.unlink('destination'));
  step('new-live-published', () => adapter.linkNoReplace('stage', 'destination'));
  step('stage-name-removed', () => adapter.unlink('stage'));
  step('journal-removed', () => adapter.unlink('journal'));
  return { status: 'success', rollback: 'rollback' };
}

function assertOriginalPreserved(adapter) {
  assert.ok(
    (adapter.exists('destination') && adapter.read('destination') === 'original-db')
      || (adapter.exists('rollback') && adapter.read('rollback') === 'original-db'),
    'original database bytes must remain reachable at every crash boundary'
  );
}

test('fake-adapter crash matrix preserves original bytes at every Restore boundary', () => {
  for (const boundary of boundaries) {
    const adapter = new FakeRestoreAdapter();
    assert.throws(() => runModel(adapter, boundary), error =>
      error.message === 'injected-crash' && error.boundary === boundary
    );
    assertOriginalPreserved(adapter);
    assert.equal(adapter.read('backup'), 'backup-db', 'source backup is immutable');
    if (!['journal-temp-created', 'journal-removed'].includes(boundary)) {
      assert.ok(adapter.exists('journal'), 'published intent remains until final cleanup');
    }
    if (boundary === 'journal-temp-created') {
      assert.ok(adapter.exists('journal-temp'), 'unpublished intent temp remains as evidence');
    }
    if (['rollback-published', 'original-name-removed', 'new-live-published', 'stage-name-removed', 'journal-removed'].includes(boundary)) {
      assert.ok(adapter.exists('rollback'), 'rollback evidence is retained after publication');
    }
    if (boundary === 'new-live-published' || boundary === 'stage-name-removed' || boundary === 'journal-removed') {
      assert.equal(adapter.read('destination'), 'backup-db');
    }
  }
});

test('fake adapter refuses to overwrite a destination that appears during publication', () => {
  const adapter = new FakeRestoreAdapter();
  adapter.createExclusive('stage', 'backup-db');
  adapter.unlink('destination');
  adapter.createExclusive('destination', 'concurrent-writer-db');
  assert.throws(() => adapter.linkNoReplace('stage', 'destination'), /already-exists/);
  assert.equal(adapter.read('destination'), 'concurrent-writer-db');
  assert.equal(adapter.read('stage'), 'backup-db');
});

test('fake adapter refuses to overwrite a pre-existing journal or rollback artifact', () => {
  const adapter = new FakeRestoreAdapter();
  adapter.createExclusive('journal', 'operator-evidence');
  assert.throws(() => adapter.linkNoReplace('backup', 'journal'), /already-exists/);
  assert.equal(adapter.read('journal'), 'operator-evidence');

  adapter.createExclusive('rollback', 'prior-evidence');
  assert.throws(() => adapter.linkNoReplace('destination', 'rollback'), /already-exists/);
  assert.equal(adapter.read('rollback'), 'prior-evidence');
});
