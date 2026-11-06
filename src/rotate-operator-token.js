import { openDatabase } from './db.js';
import { rotateOperatorToken } from './operator-auth.js';

const db = openDatabase(process.env.RAYA_CC_DATABASE || '.data/control-center.sqlite');
try {
  const token = rotateOperatorToken(db);
  process.stdout.write('New Raya Control Center operator token (save it now):\n' + token + '\n');
} finally {
  db.close();
}
