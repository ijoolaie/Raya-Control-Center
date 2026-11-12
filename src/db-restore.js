import { existsSync } from 'node:fs';
import { restoreDatabaseBackup } from './database-maintenance.js';
import { createOperationalLogger, safeOperationalErrorCode } from './operational-logger.js';

const logger = createOperationalLogger();
const backupPath = process.argv[2];
const databasePath = process.env.RAYA_CC_DATABASE || '.data/control-center.sqlite';

if (!backupPath) {
  console.error('Usage: npm run db:restore -- <backup-file>');
  process.exitCode = 2;
} else {
  try {
    const result = restoreDatabaseBackup(backupPath, databasePath);
    logger.emit('database.restore_completed', {
      schemaVersion: result.schemaVersion,
      rollbackRetained: Boolean(result.rollbackPath),
      cleanupWarningCount: result.cleanupWarnings.length
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    logger.emit('database.restore_failed', {
      errorCode: safeOperationalErrorCode(error),
      journalMayRemain: existsSync(databasePath + '.restore-journal.json')
    });
    console.error(error.message);
    process.exitCode = 1;
  }
}
