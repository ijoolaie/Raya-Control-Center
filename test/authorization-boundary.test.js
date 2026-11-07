import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { createControlServer } from '../src/http-server.js';

async function withServer(run) {
  const db = openDatabase(':memory:');
  const operatorToken = 'operator-boundary-secret-'.repeat(2);
  const server = createControlServer({ db, operatorToken });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port + '/control/v1';
  try {
    await run({ base, operatorToken });
  } finally {
    await new Promise(resolve => server.close(resolve));
    db.close();
  }
}

test('HTTP authorization matrix separates operator, participant, scope, and lease credentials', async () => {
  await withServer(async ({ base, operatorToken }) => {
    const operatorHeaders = { authorization: 'Bearer ' + operatorToken, 'content-type': 'application/json' };
    const call = (path, options = {}) => fetch(base + path, options);

    const operatorCannotClaim = await call('/tasks/claim', { method: 'POST', headers: operatorHeaders, body: '{}' });
    assert.equal(operatorCannotClaim.status, 401);

    const noScopeResponse = await call('/participants/register', {
      method: 'POST', headers: operatorHeaders,
      body: JSON.stringify({ displayName: 'no-scope', scopes: [] })
    });
    assert.equal(noScopeResponse.status, 201);
    const noScope = await noScopeResponse.json();
    const noScopeHeaders = { authorization: 'Bearer ' + noScope.token, 'content-type': 'application/json' };

    const participantCannotReadEvents = await call('/events', { headers: noScopeHeaders });
    assert.equal(participantCannotReadEvents.status, 401);
    const participantCannotCreateTask = await call('/tasks', {
      method: 'POST', headers: noScopeHeaders, body: JSON.stringify({ type: 'forbidden.task' })
    });
    assert.equal(participantCannotCreateTask.status, 401);

    const missingScope = await call('/tasks/claim', { method: 'POST', headers: noScopeHeaders, body: '{}' });
    assert.equal(missingScope.status, 403);
    assert.equal((await missingScope.json()).error.code, 'insufficient_scope');

    const scopedResponse = await call('/participants/register', {
      method: 'POST', headers: operatorHeaders,
      body: JSON.stringify({ displayName: 'scoped-worker', scopes: ['tasks:claim'] })
    });
    const scoped = await scopedResponse.json();
    const scopedHeaders = { authorization: 'Bearer ' + scoped.token, 'content-type': 'application/json' };

    const taskResponse = await call('/tasks', {
      method: 'POST', headers: operatorHeaders, body: JSON.stringify({ type: 'lease.boundary' })
    });
    const task = (await taskResponse.json()).task;
    const claimResponse = await call('/tasks/claim', { method: 'POST', headers: scopedHeaders, body: '{}' });
    const claim = (await claimResponse.json()).claim;

    const wrongLease = await call('/tasks/' + task.id + '/start', {
      method: 'POST',
      headers: { ...scopedHeaders, 'x-lease-token': 'wrong-lease-secret-'.repeat(2) },
      body: '{}'
    });
    assert.equal(wrongLease.status, 409);
    assert.equal((await wrongLease.json()).error.code, 'lease_mismatch');

    const correctLease = await call('/tasks/' + task.id + '/start', {
      method: 'POST', headers: { ...scopedHeaders, 'x-lease-token': claim.lease.token }, body: '{}'
    });
    assert.equal(correctLease.status, 200);

    const operatorCannotUseParticipantLease = await call('/tasks/' + task.id + '/heartbeat', {
      method: 'POST', headers: { ...operatorHeaders, 'x-lease-token': claim.lease.token }, body: '{}'
    });
    assert.equal(operatorCannotUseParticipantLease.status, 401);
  });
});

test('HTTP validation errors do not disclose credentials, body contents, or stack traces', async () => {
  await withServer(async ({ base, operatorToken }) => {
    const headers = { authorization: 'Bearer ' + operatorToken, 'content-type': 'application/json' };

    const malformed = await fetch(base + '/tasks', { method: 'POST', headers, body: '{"type":' });
    assert.equal(malformed.status, 400);
    const malformedText = await malformed.text();
    assert.match(malformedText, /validation_error/);
    assert.doesNotMatch(malformedText, /operator-boundary-secret|Error:|at \\w/);

    const arrayBody = await fetch(base + '/tasks', { method: 'POST', headers, body: '[]' });
    assert.equal(arrayBody.status, 400);
    assert.match(await arrayBody.text(), /JSON body must be an object/);

    const wrongContentType = await fetch(base + '/tasks', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + operatorToken, 'content-type': 'text/plain' },
      body: '{"type":"not-json"}'
    });
    assert.equal(wrongContentType.status, 400);
    assert.doesNotMatch(await wrongContentType.text(), /operator-boundary-secret|not-json/);

    const invalidPathEncoding = await fetch(base + '/tasks/%E0%A4%A', {
      headers: { authorization: 'Bearer ' + operatorToken }
    });
    assert.equal(invalidPathEncoding.status, 400);
    const invalidPathText = await invalidPathEncoding.text();
    assert.doesNotMatch(invalidPathText, /operator-boundary-secret|URIError|at \\w/);
  });
});

test('Participant kind is metadata; Operator authority and tasks:claim scope remain separate', async () => {
  await withServer(async ({ base, operatorToken }) => {
    const operatorHeaders = {
      authorization: 'Bearer ' + operatorToken,
      'content-type': 'application/json'
    };
    const call = (path, options = {}) => fetch(base + path, options);
    const register = async (displayName, kind, scopes) => {
      const response = await call('/participants/register', {
        method: 'POST',
        headers: operatorHeaders,
        body: JSON.stringify({ displayName, kind, scopes })
      });
      assert.equal(response.status, 201);
      return response.json();
    };

    const adapter = await register('mcp-adapter-no-scope', 'adapter', []);
    const adapterHeaders = {
      authorization: 'Bearer ' + adapter.token,
      'content-type': 'application/json'
    };

    const adapterCannotCreateTask = await call('/tasks', {
      method: 'POST',
      headers: adapterHeaders,
      body: JSON.stringify({ type: 'adapter.must.not.create' })
    });
    assert.equal(adapterCannotCreateTask.status, 401);

    const adapterCannotReadEvents = await call('/events', { headers: adapterHeaders });
    assert.equal(adapterCannotReadEvents.status, 401);

    const adapterWithoutClaimScope = await call('/tasks/claim', {
      method: 'POST',
      headers: adapterHeaders,
      body: '{}'
    });
    assert.equal(adapterWithoutClaimScope.status, 403);
    assert.equal((await adapterWithoutClaimScope.json()).error.code, 'insufficient_scope');

    const adapterWithClaimScope = await register('mcp-adapter-worker-mode', 'adapter', ['tasks:claim']);
    const workerModeHeaders = {
      authorization: 'Bearer ' + adapterWithClaimScope.token,
      'content-type': 'application/json'
    };
    const claim = await call('/tasks/claim', {
      method: 'POST',
      headers: workerModeHeaders,
      body: '{}'
    });
    assert.equal(claim.status, 200);
    assert.deepEqual(await claim.json(), { claim: null });

    const workerModeCannotCreateTask = await call('/tasks', {
      method: 'POST',
      headers: workerModeHeaders,
      body: JSON.stringify({ type: 'adapter.must.not.create' })
    });
    assert.equal(workerModeCannotCreateTask.status, 401);
  });
});
