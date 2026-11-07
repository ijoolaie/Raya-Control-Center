import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { restoreDatabaseBackup } from '../src/database-maintenance.js';

const [mode, backup, destination] = process.argv.slice(2);
const originalLink = fs.linkSync;
const originalRename = fs.renameSync;
fs.linkSync = () => { throw new Error('injected-install-failure'); };
if (mode === 'crash-after-original-move') {
  fs.renameSync = (source, target) => {
    originalRename(source, target);
    process.exit(78);
  };
} else if (mode === 'crash-after-install') {
  fs.linkSync = (source, target) => {
    originalLink(source, target);
    process.exit(79);
  };
} else if (mode === 'rollback-failure') {
  let renameCount = 0;
  fs.renameSync = (source, target) => {
    renameCount += 1;
    if (renameCount === 2) throw new Error('injected-rollback-failure');
    return originalRename(source, target);
  };
}
syncBuiltinESMExports();
try {
  restoreDatabaseBackup(backup, destination);
  process.stdout.write(JSON.stringify({ ok: true }));
} catch (error) {
  process.stdout.write(JSON.stringify({
    ok: false,
    name: error.name,
    message: error.message,
    errors: error.errors?.map(item => item.message) ?? []
  }));
}
