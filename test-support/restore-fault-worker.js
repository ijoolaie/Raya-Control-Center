import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { restoreDatabaseBackup } from '../src/database-maintenance.js';

const [mode, backup, destination] = process.argv.slice(2);
const originalLink = fs.linkSync;
const originalRename = fs.renameSync;
const originalCopy = fs.copyFileSync;
const originalRm = fs.rmSync;
const originalUnlink = fs.unlinkSync;

fs.linkSync = (source, target) => {
  if (target === destination && !['crash-after-install', 'crash-after-temp-cleanup', 'crash-after-journal-cleanup'].includes(mode)) throw new Error('injected-install-failure');
  const result = originalLink(source, target);
  if (mode === 'crash-after-journal' && target === destination + '.restore-journal.json') process.exit(77);
  return result;
};

if (mode === 'crash-after-stage') {
  fs.copyFileSync = (source, target, flags) => {
    const result = originalCopy(source, target, flags);
    if (target.endsWith('.restore')) process.exit(76);
    return result;
  };
} else if (mode === 'crash-before-original-move') {
  fs.renameSync = (source, target) => {
    if (source === destination && target.startsWith(destination + '.pre-restore-')) process.exit(75);
    return originalRename(source, target);
  };
} else if (mode === 'crash-after-original-move') {
  fs.renameSync = (source, target) => {
    originalRename(source, target);
    if (source === destination && target.startsWith(destination + '.pre-restore-')) process.exit(78);
  };
} else if (mode === 'crash-after-install') {
  fs.linkSync = (source, target) => {
    if (target === destination) {
      originalLink(source, target);
      process.exit(79);
    }
    return originalLink(source, target);
  };
} else if (mode === 'crash-after-temp-cleanup') {
  fs.rmSync = (target, options) => {
    const result = originalRm(target, options);
    const journal = JSON.parse(fs.readFileSync(destination + '.restore-journal.json', 'utf8'));
    if (target === journal.temporary) process.exit(80);
    return result;
  };
} else if (mode === 'crash-after-journal-cleanup') {
  fs.unlinkSync = target => {
    const result = originalUnlink(target);
    if (target === destination + '.restore-journal.json') process.exit(81);
    return result;
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
