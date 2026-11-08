import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

class Element {
  constructor() { this.value = ''; this.textContent = ''; this.disabled = false; this.children = []; this.listeners = new Map(); }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  append(child) { this.children.push(child); }
  replaceChildren(...children) { this.children = children; }
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('dashboard ignores responses from an in-flight refresh after Disconnect', async () => {
  const source = await readFile(new URL('../dashboard/dashboard.js', import.meta.url), 'utf8');
  const ids = [
    'health-dot','health-label','task-status','task-type','participant-status','participant-kind',
    'event-entity','event-id','error','refresh','tasks-body','participants-body','events-body',
    'metric-active','metric-queued','metric-blocked','metric-participants','metric-unmatched',
    'auth-status','operator-token','auth-form','disconnect'
  ];
  const elements = new Map(ids.map(id => [id, new Element()]));
  const pending = [];
  const fetch = (path, options = {}) => {
    if (path === '/control/v1/health') return Promise.resolve({ ok: true, json: async () => ({ status: 'ok' }) });
    const wait = deferred();
    pending.push({ path, options, ...wait });
    return wait.promise;
  };
  const context = {
    document: { getElementById: id => elements.get(id) || null, createElement: () => new Element() },
    fetch,
    AbortController,
    URLSearchParams,
    setInterval: () => 0,
    Date
  };
  vm.runInNewContext(source, context, { filename: 'dashboard.js' });

  elements.get('operator-token').value = 'operator-test-token-'.padEnd(40, 'x');
  const submit = elements.get('auth-form').listeners.get('submit');
  const connecting = submit({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending.length, 4, 'refresh should issue four parallel requests');
  assert.ok(pending.every(item => item.options.signal instanceof AbortSignal));

  elements.get('disconnect').listeners.get('click')();
  assert.equal(elements.get('auth-status').textContent, 'Disconnected');
  assert.equal(elements.get('tasks-body').children[0].children[0].textContent, 'Connect to load tasks.');
  assert.equal(elements.get('metric-queued').textContent, '—');
  assert.ok(pending.every(item => item.options.signal.aborted), 'Disconnect should abort every request');

  for (const item of pending) {
    const body = item.path.includes('/tasks?') ? { tasks: [{ id: 'late-task', type: 'late', status: 'queued' }] }
      : item.path.includes('/participants?') ? { participants: [{ displayName: 'late participant' }] }
        : item.path.includes('/events?') ? { events: [{ eventType: 'late event' }] }
          : { routing: { activeClaimParticipants: 99, unmatchedQueuedTasks: 99 } };
    item.resolve({ ok: true, json: async () => body });
  }
  await connecting;

  assert.equal(elements.get('auth-status').textContent, 'Disconnected');
  assert.equal(elements.get('tasks-body').children[0].children[0].textContent, 'Connect to load tasks.');
  assert.equal(elements.get('participants-body').children[0].children[0].textContent, 'Connect to load participants.');
  assert.equal(elements.get('events-body').children[0].children[0].textContent, 'Connect to load events.');
  assert.equal(elements.get('metric-participants').textContent, '—');
  assert.equal(elements.get('metric-unmatched').textContent, '—');
  assert.equal(elements.get('refresh').disabled, true);
});
