import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { syncBuiltinESMExports } from 'node:module';
import { createDatabaseBackup } from '../src/database-maintenance.js';

const [database, destination, mode] = process.argv.slice(2);
const originalExec = DatabaseSync.prototype.exec;
const originalLink = fs.linkSync;
DatabaseSync.prototype.exec = function (sql) {
  if (mode !== 'destination-race' && sql.startsWith('VACUUM INTO ')) {
    const match = sql.match(/^VACUUM INTO '((?:''|[^'])*)'$/);
    if (!match) throw new Error('unexpected-vacuum-sql');
    const partialPath = match[1].replaceAll("''", "'");
    fs.writeFileSync(partialPath, 'partial snapshot');
    throw new Error('injected-vacuum-failure');
  }
  return originalExec.call(this, sql);
};
if (mode === 'destination-race') {
  fs.linkSync = (source, target) => {
    if (target === destination) fs.writeFileSync(target, 'concurrent destination');
    return originalLink(source, target);
  };
}
syncBuiltinESMExports();
try {
  createDatabaseBackup(database, destination);
  process.stdout.write(JSON.stringify({ ok: true }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, message: error.message }));
}
