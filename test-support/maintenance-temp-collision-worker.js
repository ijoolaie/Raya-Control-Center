import crypto from 'node:crypto';
import fs from 'node:fs';
import { dirname } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';

const [mode, database, backup, uuidList] = process.argv.slice(2);
const uuids = JSON.parse(uuidList);
crypto.randomUUID = () => {
  if (!uuids.length) throw new Error('test-uuid-sequence-exhausted');
  return uuids.shift();
};
if (mode === 'backup-unexpected-temp-entry') {
  const originalLink = fs.linkSync;
  fs.linkSync = (source, target) => {
    const result = originalLink(source, target);
    if (target === backup) fs.writeFileSync(dirname(source) + '/unexpected.bin', 'preserve-unexpected-entry');
    return result;
  };
}
if (mode === 'restore-stage-collision') {
  const originalCopyFile = fs.copyFileSync;
  fs.copyFileSync = (source, target, flags) => {
    fs.writeFileSync(target, 'preserve-staged-temp', { flag: 'wx' });
    return originalCopyFile(source, target, flags);
  };
}
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
