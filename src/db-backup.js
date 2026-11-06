import { createDatabaseBackup } from './database-maintenance.js';

const databasePath = process.env.RAYA_CC_DATABASE || '.data/control-center.sqlite';
const backupPath = process.argv[2] || '.backups/control-center-' + new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-') + '.sqlite';

try {
  const result = createDatabaseBackup(databasePath, backupPath);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
