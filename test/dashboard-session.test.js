import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

class Element {
  constructor() { this.value = ''; this.textContent = ''; this.disabled = false; this.checked = false; this.hidden = false; this.type = ''; this.className = ''; this.children = []; this.listeners = new Map(); }
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
    'auth-status','operator-token','auth-form','disconnect','task-inspector','close-inspector','inspector-summary','inspector-events','recovery-panel','recovery-block-event','recovery-reason','confirm-worker-stopped','confirm-side-effects','requeue-task','recovery-status','inspector-error',
    'participant-inspector','participant-summary','close-participant-inspector','participant-detail-status','participant-detail-kind','participant-detail-scopes','participant-detail-capabilities','participant-detail-created','participant-detail-updated','participant-detail-last-seen','participant-events','participant-inspector-error',
    'participant-capability-editor','participant-capability-input','participant-capability-added','participant-capability-removed','participant-capability-confirm','participant-capability-save','participant-capability-status'
  ];
  const elements = new Map(ids.map(id => [id, new Element()]));
  const pending = [];
  const confirmMessages = [];
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
    confirm: message => { confirmMessages.push(message); return true },
    Date
  };
  vm.runInNewContext(source, context, { filename: 'dashboard.js' });
  const submitToken = token => {
    elements.get('operator-token').value = token;
    const submit = elements.get('auth-form').listeners.get('submit');
    return submit({ preventDefault() {} });
  };
  const connect = token => submitToken(token.padEnd(40, 'x'));
  return { elements, pending, confirmMessages, connect, submitToken, disconnect: () => elements.get('disconnect').listeners.get('click')() };
}

function responseFor(path, suffix) {
  const body = (path.includes('/tasks?') || path.includes('/tasks/summary?')) ? { tasks: [{ id: `${suffix}-task`, type: 'test', status: 'queued' }] }
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
  assert.equal(elements.get('metric-queued').textContent, String.fromCharCode(0x2014));
  assert.ok(pending.every(item => item.options.signal.aborted), 'Disconnect should abort every request');

  for (const item of pending) item.resolve(responseFor(item.path, 'late'));
  await connecting;

  assert.equal(elements.get('auth-status').textContent, 'Disconnected');
  assert.equal(elements.get('tasks-body').children[0].children[0].textContent, 'Connect to load tasks.');
  assert.equal(elements.get('participants-body').children[0].children[0].textContent, 'Connect to load participants.');
  assert.equal(elements.get('events-body').children[0].children[0].textContent, 'Connect to load events.');
  assert.equal(elements.get('metric-participants').textContent, String.fromCharCode(0x2014));
  assert.equal(elements.get('metric-unmatched').textContent, String.fromCharCode(0x2014));
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
  assert.equal(elements.get('auth-status').textContent, 'Connecting' + String.fromCharCode(0x2026));
  assert.equal(elements.get('tasks-body').children.length, 0, 'stale response must not render rows');

  for (const item of secondSessionRequests) item.resolve(responseFor(item.path, 'new'));
  await secondConnecting;

  assert.match(elements.get('auth-status').textContent, /^Connected /);
  assert.equal(elements.get('tasks-body').children[0].children[0].textContent, 'new-task');
  assert.equal(elements.get('participants-body').children[0].children[0].textContent, 'new participant');
  assert.equal(elements.get('metric-participants').textContent, '2');
  assert.equal(elements.get('metric-unmatched').textContent, '3');
});

test('dashboard rejects Operator tokens outside the exact server length and alphabet before making API requests', async () => {
  const { elements, pending, submitToken } = await createDashboard();
  for (const invalid of ['x'.repeat(31), 'x'.repeat(1025), 'x'.repeat(39) + '!', 'x'.repeat(39) + ' ', 'x'.repeat(39) + '\n', '\n' + 'x'.repeat(39), 'x'.repeat(39) + '\r\n', 'x'.repeat(39) + String.fromCharCode(0xe9)]) {
    await submitToken(invalid);
    assert.equal(pending.length, 0, 'invalid token must not reach the API');
    assert.match(elements.get('auth-status').textContent, /between 32 and 1024 URL-safe ASCII characters/);
    assert.equal(elements.get('operator-token').value, '', 'invalid token is cleared from the input');
  }
});

test('blocked-task inspector gates requeue on the latest recognized block event and both operator confirmations', async () => {
  const { elements, pending, connect } = await createDashboard();
  const connecting = connect('operator-recovery-token-');
  await new Promise(resolve => setImmediate(resolve));
  for (const item of pending.splice(0)) {
    if (item.path.includes('/tasks/summary?')) item.resolve({ ok:true, json:async()=>({tasks:[{id:'blocked-task-1',type:'integration.test',status:'blocked'}]}) });
    else item.resolve(responseFor(item.path, 'inspect'));
  }
  await connecting;

  const row = elements.get('tasks-body').children[0];
  const inspectButton = row.children[6].children[0];
  assert.equal(inspectButton.textContent, 'Inspect / recover');
  const inspecting = inspectButton.listeners.get('click')();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending.length, 2);
  for (const item of pending.splice(0)) {
    if (item.path.includes('/tasks/blocked-task-1')) {
      item.resolve({ok:true,json:async()=>({task:{id:'blocked-task-1',type:'integration.test',status:'blocked',payload:{secret:'DO_NOT_RENDER'},result:{secret:'DO_NOT_RENDER'}}})});
    } else {
      item.resolve({ok:true,json:async()=>({events:[
        {eventType:'task.lease_expired_blocked',occurredAt:'2026-11-10T10:00:00Z',sequence:9,actorParticipantId:null},
        {eventType:'task.started',occurredAt:'2026-11-10T09:00:00Z',sequence:8,actorParticipantId:'worker-1'}
      ]})});
    }
  }
  await inspecting;
  assert.equal(elements.get('task-inspector').hidden, false);
  assert.equal(elements.get('recovery-panel').hidden, false);
  assert.match(elements.get('recovery-block-event').textContent, /task.lease_expired_blocked/);
  assert.equal(elements.get('requeue-task').disabled, true);
  assert.equal(elements.get('inspector-summary').textContent.includes('DO_NOT_RENDER'), false);
  assert.equal(elements.get('inspector-events').children.some(row => row.children.some(cell => String(cell.textContent).includes('DO_NOT_RENDER'))), false);

  elements.get('recovery-reason').value = 'Verified worker stopped; external state checked';
  elements.get('recovery-reason').listeners.get('input')();
  assert.equal(elements.get('requeue-task').disabled, true, 'both confirmations are required');
  elements.get('confirm-worker-stopped').checked = true;
  elements.get('confirm-worker-stopped').listeners.get('change')();
  assert.equal(elements.get('requeue-task').disabled, true, 'side-effect review is independently required');
  elements.get('confirm-side-effects').checked = true;
  elements.get('confirm-side-effects').listeners.get('change')();
  assert.equal(elements.get('requeue-task').disabled, false);

  const submitting = elements.get('requeue-task').listeners.get('click')();
  await new Promise(resolve => setImmediate(resolve));
  const post = pending.shift();
  assert.match(post.path, /\/tasks\/blocked-task-1\/requeue$/);
  assert.equal(post.options.method, 'POST');
  assert.deepEqual(JSON.parse(post.options.body), {
    reason:'Verified worker stopped; external state checked',
    confirmWorkerStopped:true,
    confirmSideEffectsReviewed:true
  });
  post.resolve({ok:false,json:async()=>({error:{code:'test_rejected'}})});
  await submitting;
  assert.match(elements.get('inspector-error').textContent, /test_rejected/);
});

test('participant inspector displays metadata and whitelisted revocation/capability audit details without credentials', async () => {
  const { elements, pending, connect, disconnect } = await createDashboard();
  const connecting = connect('operator-participant-inspection-token-');
  await new Promise(resolve => setImmediate(resolve));
  for (const item of pending.splice(0)) {
    if (item.path.includes('/participants?')) {
      item.resolve({ok:true,json:async()=>({participants:[{
        id:'participant-42',displayName:'worker-alpha',kind:'worker',status:'revoked',
        scopes:['tasks:claim'],capabilities:['worker:python'],lastSeenAt:'2026-11-10T10:00:00Z'
      }]})});
    } else item.resolve(responseFor(item.path, 'participant-test'));
  }
  await connecting;
  const row = elements.get('participants-body').children[0];
  const inspectButton = row.children[6].children[0];
  assert.equal(inspectButton.textContent, 'Inspect history');
  const inspecting = inspectButton.listeners.get('click')();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending.length, 2);
  const detailRequest = pending.find(item => item.path === '/control/v1/participants/participant-42');
  const historyRequest = pending.find(item => item.path.includes('/events?'));
  assert.ok(detailRequest);
  assert.match(historyRequest.path, /entityType=participant/);
  detailRequest.resolve({ok:true,json:async()=>({participant:{
    id:'participant-42',displayName:'worker-alpha',kind:'worker',status:'revoked',
    scopes:['tasks:claim'],capabilities:['worker:python'],
    createdAt:'2026-11-01T10:00:00Z',updatedAt:'2026-11-10T10:00:00Z',lastSeenAt:'2026-11-10T09:59:00Z'
  }})});
  historyRequest.resolve({ok:true,json:async()=>({events:[
    {eventType:'participant.revoked',occurredAt:'2026-11-10T10:00:00Z',sequence:12,data:{blockedTaskIds:['task-a','task-b']}},
    {eventType:'participant.capabilities_updated',occurredAt:'2026-11-09T10:00:00Z',sequence:11,data:{previousCapabilities:['worker:python'],capabilities:['worker:node'],affects:'future_claims_only'}},
    {eventType:'participant.registered',occurredAt:'2026-11-01T10:00:00Z',sequence:1,data:{scopes:['tasks:claim'],capabilities:['worker:python'],token:'DO_NOT_RENDER_SECRET'}}
  ]})});
  await inspecting;
  assert.equal(elements.get('participant-inspector').hidden, false);
  assert.match(elements.get('participant-summary').textContent, /worker-alpha/);
  assert.equal(elements.get('participant-detail-status').textContent, 'revoked');
  assert.equal(elements.get('participant-capability-editor').hidden, true, 'revoked participants cannot be edited');
  assert.equal(elements.get('participant-detail-kind').textContent, 'worker');
  assert.equal(elements.get('participant-detail-scopes').textContent, 'tasks:claim');
  assert.equal(elements.get('participant-detail-capabilities').textContent, 'worker:python');
  const rendered = elements.get('participant-events').children.flatMap(tr => tr.children).map(td => td.textContent).join(' ');
  assert.match(rendered, /Blocked tasks \(2\): task-a, task-b/);
  assert.ok(rendered.includes('Previous: [worker:python]') && rendered.includes('Current: [worker:node]'));
  assert.match(rendered, /future claims only/);
  assert.doesNotMatch(rendered, /DO_NOT_RENDER_SECRET|token/i);
  assert.doesNotMatch(JSON.stringify(elements.get('participant-events').children), /DO_NOT_RENDER_SECRET/);
  elements.get('close-participant-inspector').listeners.get('click')();
  assert.equal(elements.get('participant-inspector').hidden, true);
  assert.equal(elements.get('participant-events').children.length, 0);

  const reopening = inspectButton.listeners.get('click')();
  await new Promise(resolve => setImmediate(resolve));
  disconnect();
  for (const item of pending.splice(0)) item.resolve({ok:true,json:async()=>({participant:{},events:[]})});
  await reopening;
  assert.equal(elements.get('participant-inspector').hidden, true, 'Disconnect must close participant inspector');
});

test('Operator capability editor previews exact changes and requires explicit confirmation before audited update', async () => {
  const { elements, pending, confirmMessages, connect } = await createDashboard();
  const connecting = connect('operator-capability-editor-token-');
  await new Promise(resolve => setImmediate(resolve));
  for (const item of pending.splice(0)) {
    if (item.path.includes('/participants?')) item.resolve({ok:true,json:async()=>({participants:[{
      id:'participant-active-7',displayName:'worker-seven',kind:'worker',status:'active',
      scopes:['tasks:claim'],capabilities:['worker:python'],lastSeenAt:null
    }]})});
    else item.resolve(responseFor(item.path, 'capability-test'));
  }
  await connecting;

  const inspectButton = elements.get('participants-body').children[0].children[6].children[0];
  const inspecting = inspectButton.listeners.get('click')();
  await new Promise(resolve => setImmediate(resolve));
  const detail = pending.find(item => item.path === '/control/v1/participants/participant-active-7');
  const history = pending.find(item => item.path.includes('/events?'));
  detail.resolve({ok:true,json:async()=>({participant:{
    id:'participant-active-7',displayName:'worker-seven',kind:'worker',status:'active',
    scopes:['tasks:claim'],capabilities:['worker:python'],createdAt:'2026-11-01T00:00:00Z',updatedAt:'2026-11-02T00:00:00Z',lastSeenAt:null
  }})});
  history.resolve({ok:true,json:async()=>({events:[]})});
  pending.splice(0);
  await inspecting;

  assert.equal(elements.get('participant-capability-editor').hidden, false);
  assert.equal(elements.get('participant-capability-input').value, 'worker:python');
  elements.get('participant-capability-input').value = 'worker:python\nworker:python';
  elements.get('participant-capability-input').listeners.get('input')();
  assert.equal(elements.get('participant-capability-save').disabled, true, 'duplicate identifiers must be rejected');
  assert.match(elements.get('participant-capability-status').textContent, /Duplicate/);
  elements.get('participant-capability-input').value = 'worker:node\ntool:browser';
  elements.get('participant-capability-input').listeners.get('input')();
  assert.equal(elements.get('participant-capability-added').textContent, 'tool:browser, worker:node');
  assert.equal(elements.get('participant-capability-removed').textContent, 'worker:python');
  assert.equal(elements.get('participant-capability-save').disabled, true);

  elements.get('participant-capability-confirm').checked = true;
  elements.get('participant-capability-confirm').listeners.get('change')();
  assert.equal(elements.get('participant-capability-save').disabled, false);
  const updating = elements.get('participant-capability-save').listeners.get('click')();
  await new Promise(resolve => setImmediate(resolve));
  const post = pending.shift();
  assert.equal(post.path, '/control/v1/participants/participant-active-7/capabilities');
  assert.equal(post.options.method, 'POST');
  assert.deepEqual(JSON.parse(post.options.body), {capabilities:['tool:browser','worker:node']});
  assert.equal(confirmMessages.length, 1, 'a final native confirmation is required');
  assert.match(confirmMessages[0], /Added: tool:browser, worker:node/);
  assert.match(confirmMessages[0], /Removed: worker:python/);
  post.resolve({ok:true,json:async()=>({participant:{id:'participant-active-7',capabilities:['tool:browser','worker:node']}})});
  await new Promise(resolve => setImmediate(resolve));

  const refreshRequests = pending.splice(0);
  assert.equal(refreshRequests.length, 4);
  for (const item of refreshRequests) {
    if (item.path.includes('/participants?')) item.resolve({ok:true,json:async()=>({participants:[]})});
    else item.resolve(responseFor(item.path, 'after-update'));
  }
  await new Promise(resolve => setImmediate(resolve));
  const inspectRequests = pending.splice(0);
  assert.equal(inspectRequests.length, 2);
  for (const item of inspectRequests) {
    if (item.path.includes('/participants/participant-active-7')) item.resolve({ok:true,json:async()=>({participant:{
      id:'participant-active-7',displayName:'worker-seven',kind:'worker',status:'active',
      scopes:['tasks:claim'],capabilities:['tool:browser','worker:node'],createdAt:'2026-11-01T00:00:00Z',updatedAt:'2026-11-10T00:00:00Z',lastSeenAt:null
    }})});
    else item.resolve({ok:true,json:async()=>({events:[{
      eventType:'participant.capabilities_updated',occurredAt:'2026-11-10T00:00:00Z',sequence:2,
      data:{previousCapabilities:['worker:python'],capabilities:['tool:browser','worker:node'],affects:'future_claims_only'}
    }]})});
  }
  await updating;
  assert.equal(elements.get('participant-detail-capabilities').textContent, 'tool:browser, worker:node');
  const audit = elements.get('participant-events').children.flatMap(row => row.children).map(cell => cell.textContent).join(' ');
  assert.ok(audit.includes('Previous: [worker:python]'));
  assert.match(audit, /tool:browser, worker:node/);
  assert.match(audit, /future claims only/);
});
