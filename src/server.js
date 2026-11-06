import { openDatabase } from './db.js';
import { ControlCenter } from './control-center.js';
import { bootstrapOperatorToken } from './operator-auth.js';
import { createControlServer } from './http-server.js';

const host = '127.0.0.1';
const port = Number(process.env.RAYA_CC_PORT || 4317);
const databasePath = process.env.RAYA_CC_DATABASE || '.data/control-center.sqlite';

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('RAYA_CC_PORT must be an integer between 1 and 65535');
}

const db = openDatabase(databasePath);
let server;
let maintenance;
try {
  const center = new ControlCenter(db);
  const recoveredTasks = center.reconcileExpiredLeases();
  if (recoveredTasks.length) {
    process.stderr.write('Blocked ' + recoveredTasks.length + ' task(s) after expired leases.\n');
  }
  maintenance = setInterval(() => {
    try { center.reconcileExpiredLeases(); }
    catch { process.stderr.write('Lease reconciliation failed; inspect local database health.\n'); }
  }, 15_000);
  maintenance.unref();
  const operator = bootstrapOperatorToken(db);
  if (operator.created) {
    process.stderr.write('\nRaya Control Center operator token (save it now; it will not be shown again):\n');
    process.stderr.write(operator.token + '\n\n');
  }
  server = createControlServer({ db, operatorToken: operator.token });
  server.listen(port, host, () => {
    process.stdout.write('Raya Control Center listening on http://' + host + ':' + port + '/control/v1\n');
  });
} catch (error) {
  clearInterval(maintenance);
  db.close();
  throw error;
}

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(maintenance);
  const forceClose = setTimeout(() => server.closeAllConnections(), 10_000);
  forceClose.unref();
  server.close(() => {
    clearTimeout(forceClose);
    db.close();
    process.exit(0);
  });
  server.closeIdleConnections();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
