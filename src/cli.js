import { pathToFileURL } from 'node:url';
const BASE = (process.env.RAYA_CC_URL || 'http://127.0.0.1:4317/control/v1').replace(/\/+$/, '');
let API_URL;
try { API_URL = new URL(BASE); }
catch { throw new Error('RAYA_CC_URL must be a valid HTTP URL on a loopback host.'); }
if (API_URL.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(API_URL.hostname) ||
    API_URL.username || API_URL.password || API_URL.pathname !== '/control/v1' || API_URL.search || API_URL.hash) {
  throw new Error('RAYA_CC_URL must use HTTP on a loopback host with the /control/v1 path.');
}

function parseOptions(args) {
  const result = {};
  for (let i = 0; i < args.length; i++) {
    const item = args[i];
    if (!item.startsWith('--')) throw new Error('Unexpected argument: ' + item);
    const key = item.slice(2);
    const value = args[i + 1];
    if (value === undefined || value.startsWith('--')) {
      result[key] = true;
    } else {
      if (key === 'scope') (result.scope ||= []).push(value);
      else if (key === 'capability') (result.capability ||= []).push(value);
      else if (key === 'requires') (result.requires ||= []).push(value);
      else result[key] = value;
      i++;
    }
  }
  return result;
}

async function callApi(path, { method = 'GET', body, operator = true } = {}) {
  const headers = {};
  let operatorToken;
  if (operator) {
    operatorToken = process.env.RAYA_CC_OPERATOR_TOKEN;
    if (!operatorToken) throw new Error('Set RAYA_CC_OPERATOR_TOKEN before using operator commands.');
    headers.authorization = 'Bearer ' + operatorToken;
  }
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(BASE + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error'
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const error = data.error || {};
    const message = String(error.message || 'Request failed');
    const safeMessage = operatorToken ? message.split(operatorToken).join('[REDACTED]') : message;
    throw new Error(response.status + ' ' + (error.code || 'http_error') + ': ' + safeMessage);
  }
  return data;
}

function usage() {
  return [
    'Raya Control Center CLI',
    '',
    '  npm run cli -- health',
    '  npm run cli -- participant register --name NAME [--kind worker] [--scope tasks:claim] [--capability worker:python]',
    '  npm run cli -- participant get PARTICIPANT_ID',
    '  npm run cli -- participant list [--status active] [--kind worker] [--limit 50] [--offset 0]',
    '  npm run cli -- participant capabilities PARTICIPANT_ID --capability worker:python',
    '  npm run cli -- participant revoke PARTICIPANT_ID',
    '  npm run cli -- task create --type TASK.TYPE [--payload JSON] [--priority N] [--idempotency-key KEY] [--requires worker:python]',
    '  npm run cli -- task get TASK_ID',
    '  npm run cli -- task list [--status queued] [--type TASK.TYPE] [--limit 50] [--offset 0]',
    '  npm run cli -- task cancel TASK_ID',
    '  npm run cli -- task requeue TASK_ID --reason TEXT --confirm-worker-stopped --confirm-side-effects-reviewed',
    '  npm run cli -- events [--entity-type TYPE] [--entity-id ID] [--limit N]',
    '  npm run cli -- reconcile',
    '  npm run cli -- operator rotate',
    '',
    'Set RAYA_CC_OPERATOR_TOKEN for operator commands and RAYA_CC_URL to override the API base URL.'
  ].join('\n');
}

export async function main(args = process.argv.slice(2)) {
  const [group, action, ...rest] = args;
  if (!group || group === 'help' || group === '--help') {
    process.stdout.write(usage() + '\n');
    return;
  }
  if (group === 'health') {
    const data = await callApi('/health', { operator: false });
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
    return;
  }
  if (group === 'participant' && action === 'register') {
    const opts = parseOptions(rest);
    if (typeof opts.name !== 'string' || !opts.name.trim()) throw new Error('--name is required');
    const data = await callApi('/participants/register', {
      method: 'POST',
      body: { displayName: opts.name, kind: opts.kind || 'worker', scopes: opts.scope || [], capabilities: opts.capability || [] }
    });
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
    return;
  }
  if (group === 'participant' && action === 'get') {
    if (!rest[0]) throw new Error('Participant ID is required');
    const data = await callApi('/participants/' + encodeURIComponent(rest[0]));
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
    return;
  }
  if (group === 'participant' && action === 'list') {
    const opts = parseOptions(rest); const query = new URLSearchParams();
    for (const key of ['status','kind','limit','offset']) if (opts[key] !== undefined) query.set(key, String(opts[key]));
    const data = await callApi('/participants' + (query.size ? '?' + query.toString() : ''));
    process.stdout.write(JSON.stringify(data, null, 2) + '\n'); return;
  }
  if (group === 'participant' && action === 'capabilities') {
    if (!rest[0]) throw new Error('Participant ID is required');
    const opts = parseOptions(rest.slice(1));
    const data = await callApi('/participants/' + encodeURIComponent(rest[0]) + '/capabilities', {
      method: 'POST', body: { capabilities: opts.capability || [] }
    });
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
    return;
  }
  if (group === 'participant' && action === 'revoke') {
    if (!rest[0]) throw new Error('Participant ID is required');
    const data = await callApi('/participants/' + encodeURIComponent(rest[0]) + '/revoke', { method: 'POST', body: {} });
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
    return;
  }
  if (group === 'task' && action === 'create') {
    const opts = parseOptions(rest);
    if (typeof opts.type !== 'string' || !opts.type) throw new Error('--type is required');
    let payload = {};
    if (opts.payload !== undefined) {
      try { payload = JSON.parse(opts.payload); }
      catch { throw new Error('--payload must be valid JSON'); }
    }
    const priority = opts.priority === undefined ? 0 : Number(opts.priority);
    if (!Number.isSafeInteger(priority)) throw new Error('--priority must be an integer');
    const data = await callApi('/tasks', {
      method: 'POST',
      body: { type: opts.type, payload, priority, idempotencyKey: opts['idempotency-key'], requiredCapabilities: opts.requires || [] }
    });
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
    return;
  }
  if (group === 'task' && action === 'get') {
    if (!rest[0]) throw new Error('Task ID is required');
    const data = await callApi('/tasks/' + encodeURIComponent(rest[0]));
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
    return;
  }
  if (group === 'task' && action === 'list') {
    const opts = parseOptions(rest); const query = new URLSearchParams();
    for (const key of ['status','type','assigned-participant-id','limit','offset']) if (opts[key] !== undefined) query.set(key === 'assigned-participant-id' ? 'assignedParticipantId' : key, String(opts[key]));
    const data = await callApi('/tasks' + (query.size ? '?' + query.toString() : ''));
    process.stdout.write(JSON.stringify(data, null, 2) + '\n'); return;
  }
  if (group === 'task' && action === 'requeue') {
    if (!rest[0]) throw new Error('Task ID is required');
    const opts = parseOptions(rest.slice(1));
    if (typeof opts.reason !== 'string' || !opts.reason.trim()) throw new Error('--reason is required');
    if (opts['confirm-worker-stopped'] !== true) throw new Error('--confirm-worker-stopped is required');
    if (opts['confirm-side-effects-reviewed'] !== true) throw new Error('--confirm-side-effects-reviewed is required');
    const data = await callApi('/tasks/' + encodeURIComponent(rest[0]) + '/requeue', {
      method: 'POST', body: { reason: opts.reason, confirmWorkerStopped: true, confirmSideEffectsReviewed: true }
    });
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
    return;
  }
  if (group === 'task' && action === 'cancel') {
    if (!rest[0]) throw new Error('Task ID is required');
    const data = await callApi('/tasks/' + encodeURIComponent(rest[0]) + '/cancel-request', { method: 'POST', body: {} });
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
    return;
  }
  if (group === 'events') {
    const opts = parseOptions([action, ...rest].filter(Boolean));
    const query = new URLSearchParams();
    if (opts['entity-type']) query.set('entityType', opts['entity-type']);
    if (opts['entity-id']) query.set('entityId', opts['entity-id']);
    if (opts.limit !== undefined) query.set('limit', String(opts.limit));
    const data = await callApi('/events' + (query.size ? '?' + query.toString() : ''));
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
    return;
  }
  if (group === 'operator' && action === 'rotate') {
    const data = await callApi('/operator/rotate-token', { method: 'POST', body: {} });
    process.stdout.write('New operator token (save it now; it is shown only once):\n' + data.token + '\n');
    return;
  }
  if (group === 'reconcile') {
    const data = await callApi('/maintenance/reconcile-expired-leases', { method: 'POST', body: {} });
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
    return;
  }
  throw new Error('Unknown command.\n\n' + usage());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    process.stderr.write(error.message + '\n');
    process.exitCode = 1;
  });
}
