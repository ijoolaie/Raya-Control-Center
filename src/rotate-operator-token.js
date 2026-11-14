import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openDatabase } from './db.js';
import { rotateOperatorToken } from './operator-auth.js';
import { acquireDatabaseRuntimeLock } from './database-runtime-lock.js';
import { createOperationalLogger, safeOperationalErrorCode } from './operational-logger.js';

export function recoverOperatorToken(databasePath = process.env.RAYA_CC_DATABASE || '.data/control-center.sqlite') {
  if (databasePath === ':memory:' || !existsSync(databasePath)) {
    throw new Error('An existing on-disk Control Center database is required for token recovery.');
  }
  const releaseLock = acquireDatabaseRuntimeLock(databasePath);
  let db;
  try {
    db = openDatabase(databasePath);
    const existing = db.prepare("SELECT value FROM settings WHERE key = 'operator_token_hash'").get();
    if (!existing) throw new Error('The database has no initialized Operator credential; recovery was not performed.');
    return rotateOperatorToken(db);
  } finally {
    try { db?.close(); } finally { releaseLock(); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const logger = createOperationalLogger();
  try {
    const token = recoverOperatorToken(process.argv[2] || process.env.RAYA_CC_DATABASE || '.data/control-center.sqlite');
    logger.emit('operator.token_recovery_completed');
    process.stdout.write('Operator token recovered. Save this value securely; it is shown only once:\n' + token + '\n');
  } catch (error) {
    logger.emit('operator.token_recovery_failed', { errorCode: safeOperationalErrorCode(error) });
    process.stderr.write(error.message + '\n');
    process.exitCode = 2;
  }
}
