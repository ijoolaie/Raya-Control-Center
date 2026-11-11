import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';

const [mode, database, backup, uuidList] = process.argv.slice(2);
const uuids = JSON.parse(uuidList);
crypto.randomUUID = () => {
  if (!uuids.length) throw new Error('test-uuid-sequence-exhausted');
  return uuids.shift();
};
syncBuiltinESMExports();

try {
  const maintenance = await import('../src/database-maintenance.js');
  const result = mode === 'backup'
    ? maintenance.createDatabaseBackup(database, backup)
    : maintenance.restoreDatabaseBackup(backup, database);
  process.stdout.write(JSON.stringify({ ok: true, result }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, message: error.message }));
}
