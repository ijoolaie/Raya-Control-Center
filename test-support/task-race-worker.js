import { parentPort, workerData } from 'node:worker_threads';
import { openDatabase } from '../src/db.js';
import { ControlCenter } from '../src/control-center.js';

const db = openDatabase(workerData.filename);
const center = new ControlCenter(db);
parentPort.postMessage({ type: 'ready' });
try {
  if (workerData.startAt) {
    const delay = workerData.startAt - Date.now();
    if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
  }
  let result;
  switch (workerData.operation) {
    case 'complete':
      result = center.completeTask({ taskId: workerData.taskId, participantId: workerData.participantId, leaseToken: workerData.leaseToken, result: { completed: true } });
      break;
    case 'cancel':
      result = center.requestCancellation(workerData.taskId);
      break;
    case 'revoke':
      result = center.revokeParticipant(workerData.participantId);
      break;
    case 'heartbeat':
      result = center.heartbeatLease({ taskId: workerData.taskId, participantId: workerData.participantId, leaseToken: workerData.leaseToken, leaseDurationMs: 60_000 });
      break;
    case 'reconcile':
      result = center.reconcileExpiredLeases();
      break;
    default:
      throw new Error('Unsupported test operation');
  }
  parentPort.postMessage({ type: 'result', value: result });
} catch (error) {
  parentPort.postMessage({ type: 'result', error: { code: error.code || null, message: error.message } });
} finally {
  db.close();
}