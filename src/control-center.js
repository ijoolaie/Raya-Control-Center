import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

const now = () => new Date().toISOString();
const hash = value => createHash('sha256').update(value, 'utf8').digest('hex');
const json = value => JSON.stringify(value);
const canonicalJson = value => {
  const normalized = JSON.parse(JSON.stringify(value));
  const sort = item => Array.isArray(item) ? item.map(sort)
    : item && typeof item === 'object'
      ? Object.fromEntries(Object.keys(item).sort().map(key => [key, sort(item[key])]))
      : item;
  return JSON.stringify(sort(normalized));
};
const parse = value => JSON.parse(value);

export class ControlCenterError extends Error {
  constructor(code, message) { super(message); this.name = 'ControlCenterError'; this.code = code; }
}

function transaction(db, work) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = work(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}

function appendEvent(db, { actorId = null, entityType, entityId, eventType, data = {}, correlationId = null }) {
  db.prepare(`INSERT INTO events
    (id, occurred_at, actor_participant_id, entity_type, entity_id, event_type, data_json, correlation_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(randomUUID(), now(), actorId, entityType, entityId, eventType, json(data), correlationId);
}

function verifyToken(candidate, storedHash) {
  if (typeof candidate !== 'string' || !storedHash) return false;
  const actual = Buffer.from(hash(candidate), 'hex');
  const expected = Buffer.from(storedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export class ControlCenter {
  constructor(db, { leaseDurationMs = 30_000 } = {}) {
    if (!db) throw new TypeError('A database connection is required');
    this.db = db;
    this.leaseDurationMs = leaseDurationMs;
  }

  registerParticipant({ displayName, kind = 'worker', scopes = [] }) {
    if (typeof displayName !== 'string' || !displayName.trim() || displayName.length > 120)
      throw new ControlCenterError('validation_error', 'displayName must contain 1..120 characters');
    if (!['worker', 'adapter', 'operator_client'].includes(kind))
      throw new ControlCenterError('validation_error', 'Unsupported participant kind');
    if (!Array.isArray(scopes) || scopes.some(s => typeof s !== 'string' || !/^[a-z][a-z0-9:._-]{0,79}$/.test(s)))
      throw new ControlCenterError('validation_error', 'Invalid scopes');
    const id = randomUUID();
    const token = randomBytes(32).toString('base64url');
    const timestamp = now();
    transaction(this.db, () => {
    this.db.prepare(`INSERT INTO participants
      (id, display_name, kind, scopes_json, token_hash, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, displayName.trim(), kind, json([...new Set(scopes)]), hash(token), timestamp, timestamp);
    appendEvent(this.db, { entityType: 'participant', entityId: id, eventType: 'participant.registered', data: { kind, scopes: [...new Set(scopes)] } });
    });
    return { participant: this.getParticipant(id), token };
  }

  authenticateParticipant(token) {
    if (typeof token !== 'string') return null;
    const candidateHash = hash(token);
    const row = this.db.prepare(`SELECT id, display_name, kind, status, scopes_json, token_hash
      FROM participants WHERE status = 'active' AND token_hash = ?`).get(candidateHash);
    if (!row || !verifyToken(token, row.token_hash)) return null;
    const timestamp = now();
    this.db.prepare('UPDATE participants SET last_seen_at = ?, updated_at = ? WHERE id = ?')
      .run(timestamp, timestamp, row.id);
    return { id: row.id, displayName: row.display_name, kind: row.kind, scopes: parse(row.scopes_json) };
  }

  getParticipant(id) {
    const row = this.db.prepare(`SELECT id, display_name, kind, status, scopes_json, created_at, updated_at, last_seen_at
      FROM participants WHERE id = ?`).get(id);
    if (!row) return null;
    return { id: row.id, displayName: row.display_name, kind: row.kind, status: row.status,
      scopes: parse(row.scopes_json), createdAt: row.created_at, updatedAt: row.updated_at, lastSeenAt: row.last_seen_at };
  }

  listParticipants({ status, kind, limit = 50, offset = 0 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new ControlCenterError('validation_error', 'Participant limit must be 1..100');
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000000) throw new ControlCenterError('validation_error', 'Participant offset must be 0..1000000');
    if (status !== undefined && !['active','disabled','revoked'].includes(status)) throw new ControlCenterError('validation_error', 'Invalid participant status filter');
    if (kind !== undefined && !['worker','adapter','operator_client'].includes(kind)) throw new ControlCenterError('validation_error', 'Invalid participant kind filter');
    let sql = 'SELECT id, display_name, kind, status, scopes_json, created_at, updated_at, last_seen_at FROM participants WHERE 1 = 1';
    const args = [];
    if (status) { sql += ' AND status = ?'; args.push(status); }
    if (kind) { sql += ' AND kind = ?'; args.push(kind); }
    sql += ' ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?'; args.push(limit, offset);
    return this.db.prepare(sql).all(...args).map(row => ({ id: row.id, displayName: row.display_name, kind: row.kind, status: row.status, scopes: parse(row.scopes_json), createdAt: row.created_at, updatedAt: row.updated_at, lastSeenAt: row.last_seen_at }));
  }

  revokeParticipant(id) {
    return transaction(this.db, () => {
      const existing = this.db.prepare('SELECT status FROM participants WHERE id = ?').get(id);
      if (!existing) throw new ControlCenterError('not_found', 'Participant not found');
      if (existing.status === 'revoked') return this.getParticipant(id);
      this.db.prepare(`UPDATE participants SET status = 'revoked', updated_at = ?
        WHERE id = ? AND status != 'revoked'`).run(now(), id);
      const affectedTasks = this.db.prepare(`SELECT t.id, t.status, l.id AS lease_id
        FROM tasks t JOIN leases l ON l.id = t.lease_id
        WHERE l.participant_id = ? AND l.status = 'active'
          AND t.status IN ('claimed', 'running', 'cancellation_requested')`).all(id);
      const timestamp = now();
      this.db.prepare(`UPDATE leases SET status = 'revoked', released_at = ?
        WHERE participant_id = ? AND status = 'active'`).run(timestamp, id);
      for (const task of affectedTasks) {
        this.db.prepare(`UPDATE tasks SET status = 'blocked', lease_id = NULL,
          assigned_participant_id = NULL, updated_at = ? WHERE id = ?`).run(timestamp, task.id);
        appendEvent(this.db, { entityType: 'task', entityId: task.id,
          eventType: 'task.participant_revoked_blocked',
          data: { previousStatus: task.status, leaseId: task.lease_id, participantId: id } });
      }
      appendEvent(this.db, { entityType: 'participant', entityId: id,
        eventType: 'participant.revoked', data: { blockedTaskIds: affectedTasks.map(task => task.id) } });
      return this.getParticipant(id);
    });
  }

  createTask({ type, payload = {}, priority = 0, createdBy = null, idempotencyKey = null }) {
    if (typeof type !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9:._/-]{0,159}$/.test(type))
      throw new ControlCenterError('validation_error', 'Invalid task type');
    if (!Number.isSafeInteger(priority) || priority < -1000 || priority > 1000)
      throw new ControlCenterError('validation_error', 'Priority must be an integer from -1000 to 1000');
    if (!payload || typeof payload !== 'object' || Array.isArray(payload))
      throw new ControlCenterError('validation_error', 'Task payload must be a JSON object');
    if (idempotencyKey !== null && (typeof idempotencyKey !== 'string' || !idempotencyKey.trim() || idempotencyKey.length > 200))
      throw new ControlCenterError('validation_error', 'idempotencyKey must contain 1..200 characters');
    let payloadText;
    try { payloadText = canonicalJson(payload); }
    catch { throw new ControlCenterError('validation_error', 'Task payload must be JSON serializable'); }
    if (typeof payloadText !== 'string' || Buffer.byteLength(payloadText) > 16_384)
      throw new ControlCenterError('validation_error', 'Task payload exceeds 16 KiB or is not serializable');
    const id = randomUUID();
    const timestamp = now();
    let taskId = id;
    let idempotentReplay = false;
    try {
      transaction(this.db, () => {
        if (idempotencyKey !== null) {
          const existing = this.db.prepare(`SELECT id, type, payload_json, priority
            FROM tasks WHERE idempotency_key = ?`).get(idempotencyKey);
          if (existing) {
            if (existing.type !== type || existing.payload_json !== payloadText || existing.priority !== priority)
              throw new ControlCenterError('conflict', 'Idempotency key was already used for a different task request');
            taskId = existing.id;
            idempotentReplay = true;
            return;
          }
        }
        this.db.prepare(`INSERT INTO tasks
          (id, type, status, payload_json, priority, created_by, idempotency_key, created_at, updated_at)
          VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?)`)
          .run(id, type, payloadText, priority, createdBy, idempotencyKey, timestamp, timestamp);
        appendEvent(this.db, { entityType: 'task', entityId: id, eventType: 'task.queued', data: { type, priority } });
      });
    } catch (error) {
      if (error instanceof ControlCenterError) throw error;
      if (String(error.message).includes('UNIQUE')) throw new ControlCenterError('conflict', 'Task id or idempotency key already exists');
      throw error;
    }
    const task = this.getTask(taskId);
    Object.defineProperty(task, 'idempotentReplay', { value: idempotentReplay, enumerable: false });
    return task;
  }

  getTask(id) {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    if (!row) return null;
    return { id: row.id, type: row.type, status: row.status, payload: parse(row.payload_json),
      priority: row.priority, createdBy: row.created_by, assignedParticipantId: row.assigned_participant_id,
      leaseId: row.lease_id, createdAt: row.created_at, updatedAt: row.updated_at,
      startedAt: row.started_at, finishedAt: row.finished_at, progress: row.progress_json ? parse(row.progress_json) : null };
  }

  listTasks({ status, type, assignedParticipantId, limit = 50, offset = 0 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new ControlCenterError('validation_error', 'Task limit must be 1..100');
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000000) throw new ControlCenterError('validation_error', 'Task offset must be 0..1000000');
    const statuses = ['queued','claimed','running','waiting_approval','blocked','cancellation_requested','succeeded','failed','cancelled'];
    if (status !== undefined && !statuses.includes(status)) throw new ControlCenterError('validation_error', 'Invalid task status filter');
    if (type !== undefined && (typeof type !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9:._/-]{0,159}$/.test(type))) throw new ControlCenterError('validation_error', 'Invalid task type filter');
    if (assignedParticipantId !== undefined && (typeof assignedParticipantId !== 'string' || !assignedParticipantId.trim() || assignedParticipantId.length > 100)) throw new ControlCenterError('validation_error', 'Invalid assignedParticipantId filter');
    let sql = 'SELECT * FROM tasks WHERE 1 = 1'; const args = [];
    if (status) { sql += ' AND status = ?'; args.push(status); }
    if (type) { sql += ' AND type = ?'; args.push(type); }
    if (assignedParticipantId) { sql += ' AND assigned_participant_id = ?'; args.push(assignedParticipantId); }
    sql += ' ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?'; args.push(limit, offset);
    return this.db.prepare(sql).all(...args).map(row => ({ id: row.id, type: row.type, status: row.status, payload: parse(row.payload_json), priority: row.priority, createdBy: row.created_by, assignedParticipantId: row.assigned_participant_id, leaseId: row.lease_id, createdAt: row.created_at, updatedAt: row.updated_at, startedAt: row.started_at, finishedAt: row.finished_at, progress: row.progress_json ? parse(row.progress_json) : null }));
  }

  claimTask({ participantId, token, leaseDurationMs = this.leaseDurationMs }) {
    if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 1000 || leaseDurationMs > 3_600_000)
      throw new ControlCenterError('validation_error', 'Lease duration must be 1s..1h');
    return transaction(this.db, () => {
      const participant = this.db.prepare(`SELECT id, scopes_json, token_hash FROM participants
        WHERE id = ? AND status = 'active'`).get(participantId);
      if (!participant || !verifyToken(token, participant.token_hash)) throw new ControlCenterError('authentication_required', 'Valid participant credentials required');
      if (!parse(participant.scopes_json).includes('tasks:claim'))
        throw new ControlCenterError('insufficient_scope', 'Participant lacks tasks:claim scope');
      const leaseToken = randomBytes(32).toString('base64url');
      const leaseId = randomUUID();
      const timestamp = now();
      const expiresAt = new Date(Date.now() + leaseDurationMs).toISOString();
      const task = this.db.prepare(`SELECT id FROM tasks WHERE status = 'queued'
        ORDER BY priority DESC, created_at ASC LIMIT 1`).get();
      if (!task) return null;
      const update = this.db.prepare(`UPDATE tasks SET status = 'claimed', assigned_participant_id = ?,
        lease_id = ?, updated_at = ? WHERE id = ? AND status = 'queued'`)
        .run(participantId, leaseId, timestamp, task.id);
      if (update.changes !== 1) throw new ControlCenterError('conflict', 'Task was claimed concurrently');
      this.db.prepare(`INSERT INTO leases
        (id, task_id, participant_id, token_hash, status, issued_at, expires_at)
        VALUES (?, ?, ?, ?, 'active', ?, ?)`)
        .run(leaseId, task.id, participantId, hash(leaseToken), timestamp, expiresAt);
      appendEvent(this.db, { actorId: participantId, entityType: 'task', entityId: task.id,
        eventType: 'task.claimed', data: { participantId, leaseId, expiresAt } });
      return { task: this.getTask(task.id), lease: { id: leaseId, token: leaseToken, expiresAt } };
    });
  }

  startTask({ taskId, participantId, leaseToken }) {
    return this.#withLease({ taskId, participantId, leaseToken }, (task) => {
      if (task.status !== 'claimed') throw new ControlCenterError('invalid_transition', 'Only claimed tasks can start');
      const timestamp = now();
      this.db.prepare(`UPDATE tasks SET status = 'running', started_at = ?, updated_at = ? WHERE id = ?`)
        .run(timestamp, timestamp, taskId);
      appendEvent(this.db, { actorId: participantId, entityType: 'task', entityId: taskId, eventType: 'task.started' });
      return this.getTask(taskId);
    });
  }

  updateTaskProgress({ taskId, participantId, leaseToken, percent = null, message = '', details = {} }) {
    if (percent !== null && (!Number.isInteger(percent) || percent < 0 || percent > 100))
      throw new ControlCenterError('validation_error', 'Progress percent must be null or an integer from 0 to 100');
    if (typeof message !== 'string' || message.length > 240)
      throw new ControlCenterError('validation_error', 'Progress message must be at most 240 characters');
    if (!details || typeof details !== 'object' || Array.isArray(details))
      throw new ControlCenterError('validation_error', 'Progress details must be a JSON object');
    let detailsText;
    try { detailsText = json(details); }
    catch { throw new ControlCenterError('validation_error', 'Progress details must be JSON serializable'); }
    if (Buffer.byteLength(detailsText) > 2048)
      throw new ControlCenterError('validation_error', 'Progress details exceed 2 KiB');
    return this.#withLease({ taskId, participantId, leaseToken }, task => {
      if (task.status !== 'running')
        throw new ControlCenterError('invalid_transition', 'Progress can only be reported for running tasks');
      const timestamp = now();
      const progress = { percent, message, details, updatedAt: timestamp };
      this.db.prepare('UPDATE tasks SET progress_json = ?, updated_at = ? WHERE id = ?')
        .run(json(progress), timestamp, taskId);
      appendEvent(this.db, { actorId: participantId, entityType: 'task', entityId: taskId,
        eventType: 'task.progress_updated', data: { percent, message } });
      return this.getTask(taskId);
    });
  }
  getLeasedTaskStatus({ taskId, participantId, leaseToken }) {
    return this.#withLease({ taskId, participantId, leaseToken }, task => {
      const lease = this.db.prepare("SELECT expires_at FROM leases WHERE id = ? AND status = 'active'").get(task.lease_id);
      return { taskId: task.id, status: task.status, cancellationRequested: task.status === 'cancellation_requested', updatedAt: task.updated_at, leaseExpiresAt: lease.expires_at };
    });
  }
  heartbeatLease({ taskId, participantId, leaseToken, leaseDurationMs = this.leaseDurationMs }) {
    if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 1000 || leaseDurationMs > 3_600_000)
      throw new ControlCenterError('validation_error', 'Lease duration must be 1s..1h');
    return this.#withLease({ taskId, participantId, leaseToken }, () => {
      const timestamp = now();
      const expiresAt = new Date(Date.now() + leaseDurationMs).toISOString();
      this.db.prepare('UPDATE leases SET renewed_at = ?, expires_at = ? WHERE task_id = ? AND status = \'active\'')
        .run(timestamp, expiresAt, taskId);
      return { taskId, expiresAt };
    });
  }

  completeTask({ taskId, participantId, leaseToken, result = {} }) {
    if (!result || typeof result !== 'object' || Array.isArray(result))
      throw new ControlCenterError('validation_error', 'Task result must be a JSON object');
    let resultText;
    try { resultText = json(result); }
    catch { throw new ControlCenterError('validation_error', 'Task result must be JSON serializable'); }
    if (typeof resultText !== 'string' || Buffer.byteLength(resultText) > 16_384)
      throw new ControlCenterError('validation_error', 'Task result exceeds 16 KiB or is not serializable');
    return this.#finishTask({ taskId, participantId, leaseToken, status: 'succeeded', eventType: 'task.succeeded', data: result });
  }

  failTask({ taskId, participantId, leaseToken, reason = 'unspecified' }) {
    if (typeof reason !== 'string' || reason.length > 500)
      throw new ControlCenterError('validation_error', 'Failure reason must be a string of at most 500 characters');
    return this.#finishTask({ taskId, participantId, leaseToken, status: 'failed', eventType: 'task.failed', data: { reason } });
  }

  #finishTask({ taskId, participantId, leaseToken, status, eventType, data }) {
    return this.#withLease({ taskId, participantId, leaseToken }, task => {
      if (!['claimed', 'running', 'cancellation_requested'].includes(task.status))
        throw new ControlCenterError('invalid_transition', 'Task is not in a finishable state');
      const timestamp = now();
      this.db.prepare('UPDATE tasks SET status = ?, finished_at = ?, updated_at = ? WHERE id = ?')
        .run(status, timestamp, timestamp, taskId);
      this.db.prepare(`UPDATE leases SET status = 'released', released_at = ? WHERE task_id = ? AND status = 'active'`)
        .run(timestamp, taskId);
      appendEvent(this.db, { actorId: participantId, entityType: 'task', entityId: taskId, eventType, data });
      return this.getTask(taskId);
    });
  }

  requestCancellation(taskId) {
    return transaction(this.db, () => {
      const task = this.db.prepare('SELECT status, lease_id FROM tasks WHERE id = ?').get(taskId);
      if (!task) throw new ControlCenterError('not_found', 'Task not found');
      if (task.status === 'cancellation_requested' || task.status === 'cancelled')
        return this.getTask(taskId);
      if (['succeeded', 'failed'].includes(task.status))
        throw new ControlCenterError('invalid_transition', 'Terminal task cannot be cancelled');
      const activeLease = task.lease_id ? this.db.prepare(`SELECT id FROM leases WHERE id = ? AND status = 'active' AND expires_at > ?`).get(task.lease_id, now()) : null;
      const next = task.status === 'queued' || !activeLease ? 'cancelled' : 'cancellation_requested';
      const timestamp = now();
      this.db.prepare('UPDATE tasks SET status = ?, updated_at = ?, finished_at = ? WHERE id = ?')
        .run(next, timestamp, next === 'cancelled' ? timestamp : null, taskId);
      if (next === 'cancelled') this.db.prepare(`UPDATE leases SET status = 'released', released_at = ?
        WHERE task_id = ? AND status = 'active'`).run(timestamp, taskId);
      appendEvent(this.db, { entityType: 'task', entityId: taskId,
        eventType: next === 'cancelled' ? 'task.cancelled' : 'task.cancellation_requested' });
      return this.getTask(taskId);
    });
  }

  acknowledgeCancellation({ taskId, participantId, leaseToken }) {
    return this.#withLease({ taskId, participantId, leaseToken }, task => {
      if (task.status !== 'cancellation_requested')
        throw new ControlCenterError('invalid_transition', 'Cancellation was not requested');
      const timestamp = now();
      this.db.prepare(`UPDATE tasks SET status = 'cancelled', finished_at = ?, updated_at = ? WHERE id = ?`)
        .run(timestamp, timestamp, taskId);
      this.db.prepare(`UPDATE leases SET status = 'released', released_at = ? WHERE task_id = ? AND status = 'active'`)
        .run(timestamp, taskId);
      appendEvent(this.db, { actorId: participantId, entityType: 'task', entityId: taskId, eventType: 'task.cancelled' });
      return this.getTask(taskId);
    });
  }

  #withLease({ taskId, participantId, leaseToken }, work) {
    return transaction(this.db, () => {
      const task = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
      if (!task) throw new ControlCenterError('not_found', 'Task not found');
      const lease = this.db.prepare(`SELECT * FROM leases WHERE id = ? AND task_id = ?
        AND participant_id = ? AND status = 'active'`).get(task.lease_id, taskId, participantId);
      if (!lease || Date.parse(lease.expires_at) <= Date.now() || !verifyToken(leaseToken, lease.token_hash))
        throw new ControlCenterError('lease_mismatch', 'Active lease required');
      return work(task);
    });
  }

  reconcileExpiredLeases() {
    return transaction(this.db, () => {
      const expired = this.db.prepare(`SELECT l.id AS lease_id, l.task_id, l.participant_id, t.status AS task_status
        FROM leases l JOIN tasks t ON t.id = l.task_id
        WHERE l.status = 'active' AND l.expires_at <= ?
        ORDER BY l.expires_at ASC`).all(now());
      const reconciled = [];
      for (const item of expired) {
        const timestamp = now();
        this.db.prepare(`UPDATE leases SET status = 'expired', released_at = ? WHERE id = ? AND status = 'active'`).run(timestamp, item.lease_id);
        if (['claimed', 'running', 'cancellation_requested'].includes(item.task_status)) {
          this.db.prepare(`UPDATE tasks SET status = 'blocked', lease_id = NULL, assigned_participant_id = NULL, updated_at = ? WHERE id = ?`).run(timestamp, item.task_id);
          appendEvent(this.db, { entityType: 'task', entityId: item.task_id, eventType: 'task.lease_expired_blocked', data: { previousStatus: item.task_status, leaseId: item.lease_id } });
          reconciled.push(item.task_id);
        }
      }
      return reconciled;
    });
  }

  listEvents({ entityType, entityId, limit = 100 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
      throw new ControlCenterError('validation_error', 'Event limit must be 1..500');
    let sql = 'SELECT * FROM events WHERE 1 = 1';
    const args = [];
    if (entityType) { sql += ' AND entity_type = ?'; args.push(entityType); }
    if (entityId) { sql += ' AND entity_id = ?'; args.push(entityId); }
    sql += ' ORDER BY sequence DESC LIMIT ?'; args.push(limit);
    return this.db.prepare(sql).all(...args).map(row => ({ sequence: row.sequence, id: row.id,
      occurredAt: row.occurred_at, actorParticipantId: row.actor_participant_id,
      entityType: row.entity_type, entityId: row.entity_id, eventType: row.event_type,
      data: parse(row.data_json), correlationId: row.correlation_id }));
  }
}