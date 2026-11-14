import { randomUUID } from 'node:crypto';

const SCHEMA_VERSION = 1;
const MAX_RECORD_BYTES = 2048;
const MAX_TOTAL_EVENTS = 1000;
const MAX_EVENTS_BY_NAME = 100;

const ERROR_CODES = new Set([
  'EADDRINUSE', 'EACCES', 'ENOENT', 'SQLITE_BUSY', 'SQLITE_CORRUPT',
  'SQLITE_IOERR', 'SQLITE_READONLY', 'operation-failed'
]);

const EVENT_FIELDS = Object.freeze({
  'server.started': { severity: 'info', fields: { port: 'port' } },
  'server.startup_failed': { severity: 'error', fields: { errorCode: 'errorCode' } },
  'server.shutdown_started': { severity: 'info', fields: {} },
  'server.shutdown_completed': { severity: 'info', fields: {} },
  'server.shutdown_failed': { severity: 'error', fields: { errorCode: 'errorCode' } },
  'lease.reconciliation_completed': { severity: 'info', fields: { blockedTaskCount: 'count' } },
  'lease.reconciliation_failed': { severity: 'error', fields: { errorCode: 'errorCode' } },
  'database.backup_completed': { severity: 'info', fields: { schemaVersion: 'schemaVersion', cleanupWarningCount: 'count' } },
  'database.backup_failed': { severity: 'error', fields: { errorCode: 'errorCode', publishedArtifact: 'boolean' } },
  'database.restore_completed': { severity: 'info', fields: { schemaVersion: 'schemaVersion', rollbackRetained: 'boolean', cleanupWarningCount: 'count' } },
  'database.restore_failed': { severity: 'error', fields: { errorCode: 'errorCode', journalMayRemain: 'boolean' } },
  'database.restore_inspection_completed': { severity: 'info', fields: { journalStatus: 'journalStatus', manualReview: 'boolean' } },
  'database.restore_inspection_failed': { severity: 'error', fields: { errorCode: 'errorCode' } },
  'operator.token_recovery_completed': { severity: 'info', fields: {} },
  'operator.token_recovery_failed': { severity: 'error', fields: { errorCode: 'errorCode' } }
});

function validField(type, value) {
  if (type === 'port') return Number.isInteger(value) && value >= 0 && value <= 65535;
  if (type === 'count') return Number.isSafeInteger(value) && value >= 0 && value <= 1000000;
  if (type === 'schemaVersion') return Number.isInteger(value) && value >= 0 && value <= 1000;
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'journalStatus') return ['absent', 'valid', 'invalid', 'malformed', 'unreadable', 'unknown'].includes(value);
  if (type === 'errorCode') return typeof value === 'string' && ERROR_CODES.has(value);
  return false;
}

export function safeOperationalErrorCode(error) {
  const code = error && typeof error.code === 'string' ? error.code : '';
  return ERROR_CODES.has(code) ? code : 'operation-failed';
}

export function createOperationalLogger({
  write = record => process.stderr.write(record),
  now = () => new Date(),
  instanceId = randomUUID()
} = {}) {
  let totalEvents = 0;
  const eventCounts = new Map(Object.keys(EVENT_FIELDS).map(name => [name, 0]));

  return Object.freeze({
    emit(eventName, fields = {}) {
      try {
        const definition = EVENT_FIELDS[eventName];
        if (!definition || !fields || typeof fields !== 'object' || Array.isArray(fields)) return false;
        const keys = Object.keys(fields);
        const allowed = Object.keys(definition.fields);
        if (keys.length !== allowed.length || keys.some(key => !Object.hasOwn(definition.fields, key))) return false;
        for (const key of keys) {
          if (!validField(definition.fields[key], fields[key])) return false;
        }
        if (totalEvents >= MAX_TOTAL_EVENTS || eventCounts.get(eventName) >= MAX_EVENTS_BY_NAME) return false;

        const timestamp = now();
        if (!(timestamp instanceof Date) || !Number.isFinite(timestamp.getTime())) return false;
        const record = {
          schemaVersion: SCHEMA_VERSION,
          eventName,
          timestamp: timestamp.toISOString(),
          severity: definition.severity,
          processInstanceId: instanceId,
          eventId: randomUUID(),
          ...fields
        };
        const line = JSON.stringify(record) + '\n';
        if (Buffer.byteLength(line, 'utf8') > MAX_RECORD_BYTES) return false;

        write(line);
        totalEvents++;
        eventCounts.set(eventName, eventCounts.get(eventName) + 1);
        return true;
      } catch {
        return false;
      }
    }
  });
}
