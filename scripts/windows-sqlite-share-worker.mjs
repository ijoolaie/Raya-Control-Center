import { DatabaseSync } from 'node:sqlite';

const filename = process.argv[2];
if (!filename) throw new Error('database path required');

let db;
try {
  db = new DatabaseSync(filename);
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS share_probe (value INTEGER);');
  db.prepare('INSERT INTO share_probe(value) VALUES (?)').run(Date.now());
  const result = {
    state: 'READY',
    node: process.version,
    sqlite: process.versions.sqlite,
    database: filename,
    walExists: await import('node:fs').then(({ existsSync }) => existsSync(filename + '-wal')),
    shmExists: await import('node:fs').then(({ existsSync }) => existsSync(filename + '-shm'))
  };
  process.stdout.write(JSON.stringify(result) + '\n');
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    if (chunk.includes('CLOSE')) {
      try { db.close(); } finally { process.exit(0); }
    }
  });
} catch (error) {
  process.stdout.write(JSON.stringify({
    state: 'OPEN_ERROR',
    node: process.version,
    sqlite: process.versions.sqlite,
    code: error?.code ?? null,
    message: String(error?.message ?? error).slice(0, 300)
  }) + '\n');
  try { db?.close(); } catch {}
  process.exitCode = 23;
}
