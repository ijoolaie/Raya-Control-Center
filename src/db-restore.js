import { restoreDatabaseBackup } from './database-maintenance.js';

const backupPath = process.argv[2];
const databasePath = process.env.RAYA_CC_DATABASE || '.data/control-center.sqlite';

if (!backupPath) {
  console.error('Usage: npm run db:restore -- <backup-file>');
  process.exitCode = 2;
} else {
  try {
    const result = restoreDatabaseBackup(backupPath, databasePath);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
