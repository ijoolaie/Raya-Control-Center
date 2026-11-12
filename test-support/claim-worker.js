import { parentPort, workerData } from 'node:worker_threads';
import { openDatabase } from '../src/db.js';
import { ControlCenter } from '../src/control-center.js';

const db = openDatabase(workerData.filename);
try {
  const result = new ControlCenter(db).claimTask({
    participantId: workerData.participantId,
    token: workerData.token
  });
  parentPort.postMessage(result ? { taskId: result.task.id, leaseId: result.lease.id } : null);
} finally {
  db.close();
}
