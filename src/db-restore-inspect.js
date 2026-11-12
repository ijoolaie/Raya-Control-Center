import { inspectDatabaseRestore } from './database-maintenance.js';
import { createOperationalLogger, safeOperationalErrorCode } from './operational-logger.js';

const logger = createOperationalLogger();
const databasePath = process.env.RAYA_CC_DATABASE || '.data/control-center.sqlite';
try {
  const report = inspectDatabaseRestore(databasePath);
  const status = ['absent', 'valid', 'invalid', 'malformed', 'unreadable'].includes(report.journal.status)
    ? report.journal.status : 'unknown';
  logger.emit('database.restore_inspection_completed', {
    journalStatus: status,
    manualReview: report.recovery?.state !== 'no-pending-restore'
  });
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  logger.emit('database.restore_inspection_failed', { errorCode: safeOperationalErrorCode(error) });
  console.error(error.message);
  process.exitCode = 1;
}
