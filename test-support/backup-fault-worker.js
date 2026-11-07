import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { syncBuiltinESMExports } from 'node:module';
import { createDatabaseBackup } from '../src/database-maintenance.js';

const [database, destination] = process.argv.slice(2);
const originalExec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function (sql) {
  if (sql.startsWith('VACUUM INTO ')) {
    const match = sql.match(/^VACUUM INTO '((?:''|[^'])*)'$/);
    if (!match) throw new Error('unexpected-vacuum-sql');
    const partialPath = match[1].replaceAll("''", "'");
    fs.writeFileSync(partialPath, 'partial snapshot');
    throw new Error('injected-vacuum-failure');
  }
  return originalExec.call(this, sql);
};
syncBuiltinESMExports();
try {
  createDatabaseBackup(database, destination);
  process.stdout.write(JSON.stringify({ ok: true }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, message: error.message }));
}
