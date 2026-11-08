import { openDatabase } from './db.js';
import { ControlCenter } from './control-center.js';
import { bootstrapOperatorToken } from './operator-auth.js';
import { createControlServer } from './http-server.js';
import { acquireDatabaseRuntimeLock } from './database-runtime-lock.js';

export async function startControlCenter({
  databasePath = process.env.RAYA_CC_DATABASE || '.data/control-center.sqlite',
  port = Number(process.env.RAYA_CC_PORT || 4317),
  host = '127.0.0.1',
  operatorToken = process.env.RAYA_CC_OPERATOR_TOKEN
} = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('RAYA_CC_PORT must be an integer between 1 and 65535');
  }
  if (host !== '127.0.0.1') throw new Error('Raya Control Center must bind to 127.0.0.1');

  const releaseRuntimeLock = acquireDatabaseRuntimeLock(databasePath);
  let db;
  let maintenance;
  let server;
  try {
    db = openDatabase(databasePath);
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
    const operator = bootstrapOperatorToken(db, operatorToken);
    server = createControlServer({ db, operatorToken: operator.token });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, resolve);
    });

    let shutdownPromise;
    const shutdown = () => {
      if (shutdownPromise) return shutdownPromise;
      clearInterval(maintenance);
      shutdownPromise = new Promise((resolve, reject) => {
        const forceClose = setTimeout(() => server.closeAllConnections(), 10_000);
        forceClose.unref();
        server.close(error => {
          clearTimeout(forceClose);
          try { db.close(); }
          catch (closeError) { reject(closeError); return; }
          try { releaseRuntimeLock(); }
          catch (lockError) { reject(lockError); return; }
          if (error) reject(error);
          else resolve();
        });
        server.closeIdleConnections();
      });
      return shutdownPromise;
    };
    let initialOperatorToken = operator.created ? operator.token : undefined;
    return {
      server,
      get operatorToken() {
        const token = initialOperatorToken;
        initialOperatorToken = undefined;
        return token;
      },
      operatorTokenCreated: operator.created,
      shutdown
    };
  } catch (error) {
    clearInterval(maintenance);
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    try { db?.close(); } finally { releaseRuntimeLock(); }
    throw error;
  }
}
