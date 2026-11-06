import { pathToFileURL } from 'node:url';
const BASE = (process.env.RAYA_CC_URL || 'http://127.0.0.1:4317/control/v1').replace(/\/+$/, '');

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
      else result[key] = value;
      i++;
    }
  }
  return result;
}

async function callApi(path, { method = 'GET', body, operator = true } = {}) {
  const headers = {};
  if (operator) {
    const token = process.env.RAYA_CC_OPERATOR_TOKEN;
    if (!token) throw new Error('Set RAYA_CC_OPERATOR_TOKEN before using operator commands.');
    headers.authorization = 'Bearer ' + token;
  }
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(BASE + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const error = data.error || {};
    throw new Error(response.status + ' ' + (error.code || 'http_error') + ': ' + (error.message || 'Request failed'));
  }
  return data;
}

function usage() {
  return [
    'Raya Control Center CLI',
    '',
    '  npm run cli -- health',
    '  npm run cli -- participant register --name NAME [--kind worker] [--scope tasks:claim]',
    '  npm run cli -- participant get PARTICIPANT_ID',
    '  npm run cli -- participant revoke PARTICIPANT_ID',
    '  npm run cli -- task create --type TASK.TYPE [--payload JSON] [--priority N] [--idempotency-key KEY]',
    '  npm run cli -- task get TASK_ID',
    '  npm run cli -- task cancel TASK_ID',
    '  npm run cli -- events [--entity-type TYPE] [--entity-id ID] [--limit N]',
    '  npm run cli -- reconcile',
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
      body: { displayName: opts.name, kind: opts.kind || 'worker', scopes: opts.scope || [] }
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
      body: { type: opts.type, payload, priority, idempotencyKey: opts['idempotency-key'] }
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
