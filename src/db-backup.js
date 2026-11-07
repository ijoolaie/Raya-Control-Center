import { createDatabaseBackup } from './database-maintenance.js';

const databasePath = process.env.RAYA_CC_DATABASE || '.data/control-center.sqlite';
const backupPath = process.argv[2] || '.backups/control-center-' + new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-') + '.sqlite';

try {
  const result = createDatabaseBackup(databasePath, backupPath);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error.message);
  if (error.publishedArtifact) console.error('A published backup artifact exists but its directory-entry durability could not be confirmed: ' + error.publishedArtifact);
  if (error.cleanupWarnings?.length) {
    console.error(JSON.stringify({ cleanupWarnings: error.cleanupWarnings }, null, 2));
  }
  process.exitCode = 1;
}
