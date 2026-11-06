import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { openDatabase } from '../src/db.js';
import { bootstrapOperatorToken, rotateOperatorToken } from '../src/operator-auth.js';
import { createControlServer } from '../src/http-server.js';

const jsonHeaders = { 'content-type': 'application/json' };

test('operator token is bootstrapped once, verified on restart, and rotatable', () => {
  const db = openDatabase(':memory:');
  const first = bootstrapOperatorToken(db);
  assert.equal(first.created, true);
  assert.equal(first.token.length >= 32, true);
  const second = bootstrapOperatorToken(db, first.token);
  assert.equal(second.created, false);
  assert.equal(second.token, first.token);
  assert.throws(() => bootstrapOperatorToken(db, 'x'.repeat(40)), /does not match/);
  const rotated = rotateOperatorToken(db);
  assert.notEqual(rotated, first.token);
  assert.equal(bootstrapOperatorToken(db, rotated).created, false);
  db.close();
});

test('HTTP API separates operator and participant credentials and enforces lease token', async () => {
  const db = openDatabase(':memory:');
  const operatorToken = 'operator-secret-token-'.repeat(2);
  const server = createControlServer({ db, operatorToken });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const base = 'http://127.0.0.1:' + address.port + '/control/v1';
  const operatorHeaders = { ...jsonHeaders, authorization: 'Bearer ' + operatorToken };

  try {
    const health = await fetch(base + '/health');
    assert.equal(health.status, 200);
    const badHost = await new Promise((resolve, reject) => {
      const request = httpRequest({
        hostname: '127.0.0.1', port: address.port, path: '/control/v1/health',
        headers: { host: 'attacker.example' }
      }, response => {
        response.resume();
        response.on('end', () => resolve(response.statusCode));
      });
      request.on('error', reject);
      request.end();
    });
    assert.equal(badHost, 421);

    const denied = await fetch(base + '/events');
    assert.equal(denied.status, 401);

    const registeredResponse = await fetch(base + '/participants/register', {
      method: 'POST',
      headers: operatorHeaders,
      body: JSON.stringify({ displayName: 'api-worker', scopes: ['tasks:claim'] })
    });
    assert.equal(registeredResponse.status, 201);
    const registered = await registeredResponse.json();

    const createdResponse = await fetch(base + '/tasks', {
      method: 'POST',
      headers: operatorHeaders,
      body: JSON.stringify({ type: 'api.test', payload: { value: 1 } })
    });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json();

    const participantHeaders = {
      ...jsonHeaders,
      authorization: 'Bearer ' + registered.token
    };
    const claimResponse = await fetch(base + '/tasks/claim', {
      method: 'POST',
      headers: participantHeaders,
      body: '{}'
    });
    assert.equal(claimResponse.status, 200);
    const claim = (await claimResponse.json()).claim;
    assert.equal(claim.task.id, created.task.id);

    const noLease = await fetch(base + '/tasks/' + created.task.id + '/start', {
      method: 'POST',
      headers: participantHeaders,
      body: '{}'
    });
    assert.equal(noLease.status, 409);

    const leaseHeaders = { ...participantHeaders, 'x-lease-token': claim.lease.token };
    const started = await fetch(base + '/tasks/' + created.task.id + '/start', {
      method: 'POST', headers: leaseHeaders, body: '{}'
    });
    assert.equal(started.status, 200);

    const completed = await fetch(base + '/tasks/' + created.task.id + '/complete', {
      method: 'POST', headers: leaseHeaders, body: JSON.stringify({ result: { ok: true } })
    });
    assert.equal(completed.status, 200);

    const taskResponse = await fetch(base + '/tasks/' + created.task.id, {
      headers: { authorization: 'Bearer ' + operatorToken }
    });
    assert.equal((await taskResponse.json()).task.status, 'succeeded');

    const revoked = await fetch(base + '/participants/' + registered.participant.id + '/revoke', {
      method: 'POST', headers: operatorHeaders, body: '{}'
    });
    assert.equal(revoked.status, 200);
    const afterRevocation = await fetch(base + '/tasks/claim', {
      method: 'POST', headers: participantHeaders, body: '{}'
    });
    assert.equal(afterRevocation.status, 401);

    const reconcile = await fetch(base + '/maintenance/reconcile-expired-leases', {
      method: 'POST', headers: operatorHeaders, body: '{}'
    });
    assert.equal(reconcile.status, 200);
    assert.deepEqual((await reconcile.json()).blockedTaskIds, []);
  } finally {
    await new Promise(resolve => server.close(resolve));
    db.close();
  }
});

test('HTTP API rejects request bodies larger than 16 KiB', async () => {
  const db = openDatabase(':memory:');
  const operatorToken = 'operator-secret-token-'.repeat(2);
  const server = createControlServer({ db, operatorToken });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port + '/control/v1';
  try {
    const response = await fetch(base + '/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + operatorToken },
      body: JSON.stringify({ type: 'oversize.test', payload: 'x'.repeat(17_000) })
    });
    assert.equal(response.status, 413);
  } finally {
    await new Promise(resolve => server.close(error => error ? reject(error) : resolve()));
    db.close();
  }
});
