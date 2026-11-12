import { openDatabase } from './db.js';
import { ControlCenter } from './control-center.js';
import { bootstrapOperatorToken } from './operator-auth.js';
import { createControlServer } from './http-server.js';
import { acquireDatabaseRuntimeLock } from './database-runtime-lock.js';
import { createOperationalLogger, safeOperationalErrorCode } from './operational-logger.js';

export async function startControlCenter({
  databasePath = process.env.RAYA_CC_DATABASE || '.data/control-center.sqlite',
  port = Number(process.env.RAYA_CC_PORT || 4317),
  host = '127.0.0.1',
  operatorToken = process.env.RAYA_CC_OPERATOR_TOKEN,
  logger = createOperationalLogger()
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
    const reconcile = ({ reportNoop = false } = {}) => {
      try {
        const recoveredTasks = center.reconcileExpiredLeases();
        if (reportNoop || recoveredTasks.length) {
          logger.emit('lease.reconciliation_completed', { blockedTaskCount: recoveredTasks.length });
        }
      } catch (error) {
        logger.emit('lease.reconciliation_failed', { errorCode: safeOperationalErrorCode(error) });
      }
    };
    reconcile({ reportNoop: true });
    maintenance = setInterval(reconcile, 15_000);
    maintenance.unref();
    const operator = bootstrapOperatorToken(db, operatorToken);
    server = createControlServer({ db, operatorToken: operator.token });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, resolve);
    });
    logger.emit('server.started', { port: server.address().port });

    let shutdownPromise;
    const shutdown = () => {
      if (shutdownPromise) return shutdownPromise;
      logger.emit('server.shutdown_started');
      clearInterval(maintenance);
      shutdownPromise = new Promise((resolve, reject) => {
        const forceClose = setTimeout(() => server.closeAllConnections(), 10_000);
        forceClose.unref();
        server.close(error => {
          clearTimeout(forceClose);
          let closeFailure;
          try { db.close(); }
          catch (closeError) { closeFailure = closeError; }
          try { releaseRuntimeLock(); }
          catch (lockError) { closeFailure ||= lockError; }
          if (error || closeFailure) {
            logger.emit('server.shutdown_failed', { errorCode: safeOperationalErrorCode(error || closeFailure) });
            reject(error || closeFailure);
          } else {
            logger.emit('server.shutdown_completed');
            resolve();
          }
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
    logger.emit('server.startup_failed', { errorCode: safeOperationalErrorCode(error) });
    clearInterval(maintenance);
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    try { db?.close(); } finally { releaseRuntimeLock(); }
    throw error;
  }
}
