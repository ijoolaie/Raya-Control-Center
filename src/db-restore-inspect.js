import { inspectDatabaseRestore } from './database-maintenance.js';

const databasePath = process.env.RAYA_CC_DATABASE || '.data/control-center.sqlite';
try {
  console.log(JSON.stringify(inspectDatabaseRestore(databasePath), null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
