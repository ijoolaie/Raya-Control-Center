import { createDatabaseBackup } from './database-maintenance.js';
import { createOperationalLogger, safeOperationalErrorCode } from './operational-logger.js';

const logger = createOperationalLogger();
const databasePath = process.env.RAYA_CC_DATABASE || '.data/control-center.sqlite';
const backupPath = process.argv[2] || '.backups/control-center-' + new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-') + '.sqlite';

try {
  const result = createDatabaseBackup(databasePath, backupPath);
  logger.emit('database.backup_completed', {
    schemaVersion: result.schemaVersion,
    cleanupWarningCount: result.cleanupWarnings.length
  });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  logger.emit('database.backup_failed', {
    errorCode: safeOperationalErrorCode(error),
    publishedArtifact: Boolean(error.publishedArtifact)
  });
  console.error(error.message);
  if (error.publishedArtifact) console.error('A published backup artifact exists but its directory-entry durability could not be confirmed: ' + error.publishedArtifact);
  if (error.cleanupWarnings?.length) {
    console.error(JSON.stringify({ cleanupWarnings: error.cleanupWarnings }, null, 2));
  }
  process.exitCode = 1;
}
