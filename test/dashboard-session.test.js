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
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function createDashboard() {
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
  const connect = token => {
    elements.get('operator-token').value = token.padEnd(40, 'x');
    const submit = elements.get('auth-form').listeners.get('submit');
    const connecting = submit({ preventDefault() {} });
    return connecting;
  };
  return { elements, pending, connect, disconnect: () => elements.get('disconnect').listeners.get('click')() };
}

function responseFor(path, suffix) {
  const body = path.includes('/tasks?') ? { tasks: [{ id: `${suffix}-task`, type: 'test', status: 'queued' }] }
    : path.includes('/participants?') ? { participants: [{ displayName: `${suffix} participant` }] }
      : path.includes('/events?') ? { events: [{ eventType: `${suffix} event` }] }
        : { routing: { activeClaimParticipants: suffix === 'new' ? 2 : 99, unmatchedQueuedTasks: suffix === 'new' ? 3 : 99 } };
  return { ok: true, json: async () => body };
}

test('dashboard ignores successful responses from an in-flight refresh after Disconnect', async () => {
  const { elements, pending, connect, disconnect } = await createDashboard();
  const connecting = connect('operator-test-token-');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending.length, 4, 'refresh should issue four parallel requests');
  assert.ok(pending.every(item => item.options.signal instanceof AbortSignal));

  disconnect();
  assert.equal(elements.get('auth-status').textContent, 'Disconnected');
  assert.equal(elements.get('tasks-body').children[0].children[0].textContent, 'Connect to load tasks.');
  assert.equal(elements.get('metric-queued').textContent, '—');
  assert.ok(pending.every(item => item.options.signal.aborted), 'Disconnect should abort every request');

  for (const item of pending) item.resolve(responseFor(item.path, 'late'));
  await connecting;

  assert.equal(elements.get('auth-status').textContent, 'Disconnected');
  assert.equal(elements.get('tasks-body').children[0].children[0].textContent, 'Connect to load tasks.');
  assert.equal(elements.get('participants-body').children[0].children[0].textContent, 'Connect to load participants.');
  assert.equal(elements.get('events-body').children[0].children[0].textContent, 'Connect to load events.');
  assert.equal(elements.get('metric-participants').textContent, '—');
  assert.equal(elements.get('metric-unmatched').textContent, '—');
  assert.equal(elements.get('refresh').disabled, true);
});

test('dashboard ignores late request errors after Disconnect', async () => {
  const { elements, pending, connect, disconnect } = await createDashboard();
  const connecting = connect('operator-test-token-');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending.length, 4);
  disconnect();

  for (const item of pending) item.reject(new Error('late_network_failure'));
  await connecting;

  assert.equal(elements.get('auth-status').textContent, 'Disconnected');
  assert.equal(elements.get('error').textContent, '');
  assert.equal(elements.get('tasks-body').children[0].children[0].textContent, 'Connect to load tasks.');
  assert.equal(elements.get('refresh').disabled, true);
});

test('a previous session cannot overwrite a newer session refresh', async () => {
  const { elements, pending, connect } = await createDashboard();
  const firstConnecting = connect('first-operator-token-');
  await new Promise(resolve => setImmediate(resolve));
  const firstSessionRequests = pending.slice(0, 4);
  assert.equal(firstSessionRequests.length, 4);

  const secondConnecting = connect('second-operator-token-');
  await new Promise(resolve => setImmediate(resolve));
  const secondSessionRequests = pending.slice(4, 8);
  assert.equal(secondSessionRequests.length, 4);
  assert.ok(firstSessionRequests.every(item => item.options.signal.aborted), 'new session should abort prior requests');

  for (const item of firstSessionRequests) item.resolve(responseFor(item.path, 'stale'));
  await firstConnecting;
  assert.equal(elements.get('auth-status').textContent, 'Connecting…');
  assert.equal(elements.get('tasks-body').children.length, 0, 'stale response must not render rows');

  for (const item of secondSessionRequests) item.resolve(responseFor(item.path, 'new'));
  await secondConnecting;

  assert.match(elements.get('auth-status').textContent, /^Connected · data refreshed/);
  assert.equal(elements.get('tasks-body').children[0].children[0].textContent, 'new-task');
  assert.equal(elements.get('participants-body').children[0].children[0].textContent, 'new participant');
  assert.equal(elements.get('metric-participants').textContent, '2');
  assert.equal(elements.get('metric-unmatched').textContent, '3');
});
