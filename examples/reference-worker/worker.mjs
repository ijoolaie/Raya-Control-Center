import { setTimeout as sleep } from 'node:timers/promises';
import { removeOperatorCredential } from './environment.mjs';

// A worker is a lower-trust process. Drop any Operator credential inherited from its launcher.
removeOperatorCredential();

const BASE = (process.env.RAYA_CC_URL || 'http://127.0.0.1:4317/control/v1').replace(/\/+$/, '');
const API_URL = new URL(BASE);
if (API_URL.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(API_URL.hostname) || API_URL.pathname !== '/control/v1' || API_URL.search || API_URL.hash) {
  throw new Error('RAYA_CC_URL must use HTTP on a loopback host.');
}
const PARTICIPANT_TOKEN = process.env.RAYA_CC_PARTICIPANT_TOKEN;
const POLL_MS = Number(process.env.RAYA_CC_POLL_MS || 1000);
const LEASE_MS = Number(process.env.RAYA_CC_LEASE_MS || 30000);
const MAX_TASKS = process.env.RAYA_CC_MAX_TASKS === undefined ? Infinity : Number(process.env.RAYA_CC_MAX_TASKS);
const STOP = new AbortController();
let stopping = false;

if (!PARTICIPANT_TOKEN || PARTICIPANT_TOKEN.length < 32) throw new Error('RAYA_CC_PARTICIPANT_TOKEN must be set to a valid participant token.');
if (!Number.isSafeInteger(POLL_MS) || POLL_MS < 100 || POLL_MS > 60000) throw new Error('RAYA_CC_POLL_MS must be 100..60000.');
if (!Number.isSafeInteger(LEASE_MS) || LEASE_MS < 3000 || LEASE_MS > 3600000) throw new Error('RAYA_CC_LEASE_MS must be 3000..3600000.');
if (!(MAX_TASKS === Infinity || (Number.isSafeInteger(MAX_TASKS) && MAX_TASKS >= 1))) throw new Error('RAYA_CC_MAX_TASKS must be a positive integer.');

class ApiError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}

async function api(path, { method = 'GET', body, leaseToken, signal } = {}) {
  const headers = { authorization: 'Bearer ' + PARTICIPANT_TOKEN };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (leaseToken) headers['x-lease-token'] = leaseToken;
  let response;
  try {
    response = await fetch(BASE + path, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal
    });
  } catch (error) {
    // A network failure after a mutation is ambiguous. Never replay that mutation.
    throw new Error('network_outcome_unknown');
  }
  let data;
  try { data = await response.json(); } catch { throw new Error('invalid_api_response'); }
  if (!response.ok) throw new ApiError(response.status, data?.error?.code || 'http_error');
  return data;
}

const taskPath = (id, action) => '/tasks/' + encodeURIComponent(id) + '/' + action;

async function readCancellation(taskId, leaseToken) {
  const data = await api(taskPath(taskId, 'lease-status'), { leaseToken });
  return data.status.cancellationRequested;
}

async function heartbeat(taskId, leaseToken) {
  await api(taskPath(taskId, 'heartbeat'), { method: 'POST', body: { leaseDurationMs: LEASE_MS }, leaseToken });
}

async function runAllowlistedTask(task) {
  if (task.type === 'demo.echo') {
    const value = Object.hasOwn(task.payload, 'value') ? task.payload.value : null;
    if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) {
      throw new Error('demo_echo_value_must_be_scalar');
    }
    if (typeof value === 'string' && Buffer.byteLength(value) > 8000) {
      throw new Error('demo_echo_value_too_large');
    }
    return { echo: value };
  }
  if (task.type === 'demo.delay') {
    const durationMs = task.payload.durationMs;
    if (!Number.isSafeInteger(durationMs) || durationMs < 0 || durationMs > 5000) {
      throw new Error('invalid_demo_delay_duration');
    }
    const startedAt = Date.now();
    let lastHeartbeat = Date.now();
    while (Date.now() - startedAt < durationMs) {
      if (stopping) return { interrupted: true };
      if (await readCancellation(task.id, activeLeaseToken)) return { cancelled: true };
      if (Date.now() - lastHeartbeat >= Math.floor(LEASE_MS / 3)) {
        await heartbeat(task.id, activeLeaseToken);
        lastHeartbeat = Date.now();
      }
      const elapsed = Date.now() - startedAt;
      await sleep(Math.min(250, Math.max(1, durationMs - elapsed)), STOP.signal);
    }
    return { elapsedMs: Date.now() - startedAt };
  }
  throw new Error('unsupported_task_type');
}

let activeLeaseToken;
async function handleClaim(claim) {
  const { task, lease } = claim;
  activeLeaseToken = lease.token;
  try {
    await api(taskPath(task.id, 'start'), { method: 'POST', body: {}, leaseToken: lease.token });
    if (await readCancellation(task.id, lease.token)) {
      await api(taskPath(task.id, 'cancel-ack'), { method: 'POST', body: {}, leaseToken: lease.token });
      return;
    }
    let result;
    try {
      result = await runAllowlistedTask(task);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'lease_mismatch') return;
      if (error.message === 'network_outcome_unknown' || error.name === 'AbortError') return;
      if (stopping) return;
      await api(taskPath(task.id, 'fail'), {
        method: 'POST', body: { reason: error.message.slice(0, 500) }, leaseToken: lease.token
      });
      return;
    }
    if (stopping) return;
    if (await readCancellation(task.id, lease.token)) {
      await api(taskPath(task.id, 'cancel-ack'), { method: 'POST', body: {}, leaseToken: lease.token });
      return;
    }
    await api(taskPath(task.id, 'progress'), {
      method: 'POST', body: { percent: 100, message: 'Completed allowlisted demo operation', details: {} },
      leaseToken: lease.token
    });
    await api(taskPath(task.id, 'complete'), { method: 'POST', body: { result }, leaseToken: lease.token });
  } catch (error) {
    if (!(error instanceof ApiError && error.code === 'lease_mismatch') && error.message !== 'network_outcome_unknown') {
      process.stderr.write('Worker task stopped safely: ' + (error.code || error.message) + '\n');
    }
  } finally {
    activeLeaseToken = undefined;
  }
}

async function main() {
  let handled = 0;
  while (!stopping && handled < MAX_TASKS) {
    let data;
    try {
      data = await api('/tasks/claim', {
        method: 'POST', body: { leaseDurationMs: LEASE_MS }, signal: STOP.signal
      });
    } catch (error) {
      if (stopping || error.name === 'AbortError') break;
      // Claim may have succeeded even if its response was lost. Exit rather than
      // retrying and potentially claiming another task while the first is unknown.
      process.stderr.write('Claim outcome unknown; worker exiting without retry.\n');
      process.exitCode = 2;
      break;
    }
    if (!data.claim) {
      await sleep(POLL_MS, STOP.signal).catch(() => {});
      continue;
    }
    handled++;
    await handleClaim(data.claim);
  }
}

function requestStop() {
  if (stopping) return;
  stopping = true;
  STOP.abort();
}
process.once('SIGINT', requestStop);
process.once('SIGTERM', requestStop);
main().catch(() => {
  process.stderr.write('Reference Worker stopped due to an unexpected error.\n');
  process.exitCode = 1;
});
