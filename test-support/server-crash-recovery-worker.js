import { openDatabase } from '../src/db.js';
import { ControlCenter } from '../src/control-center.js';
import { startControlCenter } from '../src/server-runtime.js';

const [databasePath, operatorToken] = process.argv.slice(2);
if (!databasePath || !operatorToken) throw new Error('database path and operator token are required');

const runtime = await startControlCenter({ databasePath, port: 0, operatorToken });
const db = openDatabase(databasePath);
const center = new ControlCenter(db);
const participant = center.registerParticipant({ displayName: 'crash-process-worker', scopes: ['tasks:claim'] });
const task = center.createTask({ type: 'crash.process-recovery' });
const claim = center.claimTask({ participantId: participant.participant.id, token: participant.token });
center.startTask({ taskId: task.id, participantId: participant.participant.id, leaseToken: claim.lease.token });
process.stdout.write(JSON.stringify({ taskId: task.id, leaseId: claim.lease.id, port: runtime.server.address().port }) + String.fromCharCode(10));
setInterval(() => {}, 1000);
