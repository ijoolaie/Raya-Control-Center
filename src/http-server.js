import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { TextDecoder } from 'node:util';
import { ControlCenter, ControlCenterError } from './control-center.js';

const BASE = '/control/v1';
const MAX_BODY_BYTES = 16 * 1024;
const hash = value => createHash('sha256').update(value, 'utf8').digest();

function equalSecret(candidate, expectedHash) {
  if (typeof candidate !== 'string' || !expectedHash) return false;
  const actual = hash(candidate);
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function decodePathPart(value) {
  try { return decodeURIComponent(value); }
  catch { throw new ControlCenterError('validation_error', 'Malformed URL path encoding'); }
}

function validateQuery(method, url) {
  const path = url.pathname;
  let allowed = null;
  if (method === 'GET' && path === BASE + '/health') allowed = [];
  else if (method === 'GET' && path === BASE + '/participants') allowed = ['status', 'kind', 'limit', 'offset'];
  else if (method === 'GET' && path === BASE + '/tasks') allowed = ['status', 'type', 'assignedParticipantId', 'limit', 'offset'];
  else if (method === 'GET' && path === BASE + '/events') allowed = ['entityType', 'entityId', 'limit'];
  else if (method === 'GET' && new RegExp('^' + BASE + '/participants/[^/]+$').test(path)) allowed = [];
  else if (method === 'POST' && new RegExp('^' + BASE + '/participants/[^/]+/revoke$').test(path)) allowed = [];
  else if (method === 'GET' && new RegExp('^' + BASE + '/tasks/[^/]+$').test(path)) allowed = [];
  else if (method === 'GET' && new RegExp('^' + BASE + '/tasks/[^/]+/lease-status$').test(path)) allowed = [];
  else if (method === 'POST' && (
    path === BASE + '/participants/register' ||
    path === BASE + '/maintenance/reconcile-expired-leases' ||
    path === BASE + '/tasks' ||
    path === BASE + '/tasks/claim' ||
    new RegExp('^' + BASE + '/tasks/[^/]+/(start|heartbeat|progress|complete|fail|cancel-ack|cancel-request)$').test(path)
  )) allowed = [];

  if (allowed === null) return;
  const seen = new Set();
  for (const [name, value] of url.searchParams) {
    if (!allowed.includes(name)) {
      throw new ControlCenterError('validation_error', 'Unsupported query parameter: ' + name);
    }
    if (seen.has(name)) {
      throw new ControlCenterError('validation_error', 'Duplicate query parameter: ' + name);
    }
    if (value.length === 0) {
      throw new ControlCenterError('validation_error', 'Query parameter must not be empty: ' + name);
    }
    if ((name === 'limit' || name === 'offset') && !/^(0|[1-9][0-9]*)$/.test(value)) {
      throw new ControlCenterError('validation_error', name + ' must be a non-negative decimal integer');
    }
    seen.add(name);
  }
}
function bearer(req) {
  const value = req.headers.authorization;
  const match = typeof value === 'string' && /^Bearer ([A-Za-z0-9_-]{32,})$/.exec(value);
  return match ? match[1] : null;
}

function allowedMethods(path) {
  if (path === BASE + '/health' || path === BASE + '/participants' || path === BASE + '/events') return ['GET'];
  if (path === BASE + '/participants/register' || path === BASE + '/maintenance/reconcile-expired-leases' || path === BASE + '/tasks/claim') return ['POST'];
  if (path === BASE + '/tasks') return ['GET', 'POST'];
  if (new RegExp('^' + BASE + '/participants/[^/]+/revoke$').test(path)) return ['POST'];
  if (new RegExp('^' + BASE + '/participants/[^/]+$').test(path)) return ['GET'];
  if (new RegExp('^' + BASE + '/tasks/[^/]+/lease-status$').test(path)) return ['GET'];
  if (new RegExp('^' + BASE + '/tasks/[^/]+/(start|heartbeat|progress|complete|fail|cancel-ack|cancel-request)$').test(path)) return ['POST'];
  if (new RegExp('^' + BASE + '/tasks/[^/]+$').test(path)) return ['GET'];
  return null;
}

function send(res, status, value, headers = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers
  });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new ControlCenterError('payload_too_large', 'Request body exceeds 16 KiB');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json') throw new ControlCenterError('validation_error', 'Content-Type must be application/json');
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new ControlCenterError('validation_error', 'Request body must contain valid JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ControlCenterError('validation_error', 'JSON body must be an object');
  }
  return value;
}

function statusFor(error) {
  if (error.code === 'authentication_required') return 401;
  if (error.code === 'insufficient_scope') return 403;
  if (error.code === 'not_found') return 404;
  if (error.code === 'conflict' || error.code === 'invalid_transition' || error.code === 'lease_mismatch') return 409;
  if (error.code === 'payload_too_large') return 413;
  if (error.code === 'validation_error') return 400;
  return 500;
}

export function createControlServer({ db, operatorToken }) {
  if (!db) throw new TypeError('A database connection is required');
  if (typeof operatorToken !== 'string' || operatorToken.length < 32) {
    throw new TypeError('A valid operator token (at least 32 characters) is required');
  }
  const center = new ControlCenter(db);
  const operatorHash = hash(operatorToken).toString('hex');

  const server = createServer({
    maxHeaderSize: 8 * 1024,
    headersTimeout: 10_000,
    requestTimeout: 30_000,
    connectionsCheckingInterval: 1_000,
    keepAliveTimeout: 5_000
  }, async (req, res) => {
    try {
      let hostName;
      try { hostName = new URL('http://' + String(req.headers.host || '')).hostname.toLowerCase(); }
      catch { hostName = ''; }
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(hostName)) {
        send(res, 421, { error: { code: 'misdirected_request', message: 'Only loopback Host headers are accepted' } });
        return;
      }

      const url = new URL(req.url || '/', 'http://127.0.0.1');
      validateQuery(req.method || 'GET', url);
      const methods = allowedMethods(url.pathname);
      if (methods && !methods.includes(req.method || 'GET')) {
        send(res, 405, { error: { code: 'method_not_allowed', message: 'Method not allowed' } }, { allow: methods.join(', ') });
        return;
      }
      if (url.pathname === BASE + '/health' && req.method === 'GET') {
        db.prepare('SELECT 1 AS ok').get();
        send(res, 200, { status: 'ok', api: 'control/v1' });
        return;
      }

      const token = bearer(req);
      const operator = equalSecret(token, operatorHash);
      const requireOperator = () => {
        if (!operator) throw new ControlCenterError('authentication_required', 'Operator authentication required');
      };
      const requireParticipant = () => {
        const participant = center.authenticateParticipant(token);
        if (!participant) throw new ControlCenterError('authentication_required', 'Valid participant credentials required');
        return participant;
      };

      if (req.method === 'POST' && url.pathname === BASE + '/participants/register') {
        requireOperator();
        const body = await readJson(req);
        const result = center.registerParticipant({
          displayName: body.displayName, kind: body.kind, scopes: body.scopes
        });
        send(res, 201, result);
        return;
      }

      if (req.method === 'GET' && url.pathname === BASE + '/participants') {
        requireOperator();
        const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 50;
        const offset = url.searchParams.has('offset') ? Number(url.searchParams.get('offset')) : 0;
        const participants = center.listParticipants({ status: url.searchParams.get('status') || undefined, kind: url.searchParams.get('kind') || undefined, limit, offset });
        send(res, 200, { participants, page: { limit, offset, count: participants.length } }); return;
      }

      const participantPath = new RegExp('^' + BASE + '/participants/([^/]+)$').exec(url.pathname);
      if (req.method === 'GET' && participantPath) {
        requireOperator();
        const participant = center.getParticipant(decodePathPart(participantPath[1]));
        if (!participant) throw new ControlCenterError('not_found', 'Participant not found');
        send(res, 200, { participant });
        return;
      }

      const revokePath = new RegExp('^' + BASE + '/participants/([^/]+)/revoke$').exec(url.pathname);
      if (req.method === 'POST' && revokePath) {
        requireOperator();
        const participant = center.revokeParticipant(decodePathPart(revokePath[1]));
        send(res, 200, { participant });
        return;
      }

      if (req.method === 'POST' && url.pathname === BASE + '/maintenance/reconcile-expired-leases') {
        requireOperator();
        const blockedTaskIds = center.reconcileExpiredLeases();
        send(res, 200, { blockedTaskIds });
        return;
      }

      if (req.method === 'GET' && url.pathname === BASE + '/tasks') {
        requireOperator();
        const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 50;
        const offset = url.searchParams.has('offset') ? Number(url.searchParams.get('offset')) : 0;
        const tasks = center.listTasks({ status: url.searchParams.get('status') || undefined, type: url.searchParams.get('type') || undefined, assignedParticipantId: url.searchParams.get('assignedParticipantId') || undefined, limit, offset });
        send(res, 200, { tasks, page: { limit, offset, count: tasks.length } }); return;
      }

      if (req.method === 'POST' && url.pathname === BASE + '/tasks') {
        requireOperator();
        const body = await readJson(req);
        const task = center.createTask({
          type: body.type, payload: body.payload, priority: body.priority,
          idempotencyKey: body.idempotencyKey
        });
        send(res, task.idempotentReplay ? 200 : 201, { task, idempotentReplay: task.idempotentReplay });
        return;
      }

      if (req.method === 'POST' && url.pathname === BASE + '/tasks/claim') {
        const participant = requireParticipant();
        const body = await readJson(req);
        const claim = center.claimTask({
          participantId: participant.id, token,
          leaseDurationMs: body.leaseDurationMs
        });
        send(res, 200, { claim });
        return;
      }

      const leaseStatusPath = new RegExp('^' + BASE + '/tasks/([^/]+)/lease-status$').exec(url.pathname);
      if (req.method === 'GET' && leaseStatusPath) {
        const participant = requireParticipant();
        const status = center.getLeasedTaskStatus({ taskId: decodePathPart(leaseStatusPath[1]), participantId: participant.id, leaseToken: req.headers['x-lease-token'] });
        send(res, 200, { status });
        return;
      }
      const taskPath = new RegExp('^' + BASE + '/tasks/([^/]+)$').exec(url.pathname);
      if (req.method === 'GET' && taskPath) {
        requireOperator();
        const task = center.getTask(decodePathPart(taskPath[1]));
        if (!task) throw new ControlCenterError('not_found', 'Task not found');
        send(res, 200, { task });
        return;
      }

      const taskAction = new RegExp('^' + BASE + '/tasks/([^/]+)/(start|heartbeat|progress|complete|fail|cancel-ack|cancel-request)$').exec(url.pathname);
      if (taskAction && req.method === 'POST') {
        const taskId = decodePathPart(taskAction[1]);
        const action = taskAction[2];
        if (action === 'cancel-request') {
          requireOperator();
          send(res, 200, { task: center.requestCancellation(taskId) });
          return;
        }
        const participant = requireParticipant();
        const body = await readJson(req);
        const leaseToken = req.headers['x-lease-token'];
        const lease = { taskId, participantId: participant.id, leaseToken };
        if (action === 'start') send(res, 200, { task: center.startTask(lease) });
        else if (action === 'heartbeat') send(res, 200, center.heartbeatLease({ ...lease, leaseDurationMs: body.leaseDurationMs }));
        else if (action === 'progress') send(res, 200, { task: center.updateTaskProgress({ ...lease, percent: body.percent ?? null, message: body.message ?? '', details: body.details ?? {} }) });
        else if (action === 'complete') send(res, 200, { task: center.completeTask({ ...lease, result: body.result }) });
        else if (action === 'fail') send(res, 200, { task: center.failTask({ ...lease, reason: body.reason }) });
        else if (action === 'cancel-ack') send(res, 200, { task: center.acknowledgeCancellation(lease) });
        return;
      }

      if (req.method === 'GET' && url.pathname === BASE + '/events') {
        requireOperator();
        const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 100;
        const events = center.listEvents({
          entityType: url.searchParams.get('entityType') || undefined,
          entityId: url.searchParams.get('entityId') || undefined,
          limit
        });
        send(res, 200, { events });
        return;
      }

      send(res, 404, { error: { code: 'not_found', message: 'Route not found' } });
    } catch (error) {
      const status = error instanceof ControlCenterError ? statusFor(error) : 500;
      const code = error instanceof ControlCenterError ? error.code : 'internal_error';
      const message = status === 500 ? 'Internal server error' : error.message;
      if ((req.aborted && status !== 413) || res.destroyed || res.writableEnded) return;
      if (!res.headersSent) send(res, status, { error: { code, message } }, status === 413 ? { connection: 'close' } : {});
      else res.destroy();
    }
  });
  server.maxRequestsPerSocket = 100;
  return server;
}
