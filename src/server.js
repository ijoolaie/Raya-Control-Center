import { startControlCenter } from './server-runtime.js';

const port = Number(process.env.RAYA_CC_PORT || 4317);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('RAYA_CC_PORT must be an integer between 1 and 65535');
}

const runtime = await startControlCenter({ port });
if (runtime.operatorTokenCreated) {
  process.stderr.write('\nRaya Control Center operator token (save it now; it will not be shown again):\n');
  process.stderr.write(runtime.operatorToken + '\n\n');
}
process.stdout.write('Raya Control Center listening on http://127.0.0.1:' + runtime.server.address().port + '/control/v1\n');

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  runtime.shutdown().then(
    () => process.exit(0),
    () => { process.stderr.write('Raya Control Center shutdown failed; inspect local database health.\n'); process.exit(1); }
  );
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
