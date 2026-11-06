# Local Operations

## First launch

Open PowerShell in the repository root and run:

    npm test
    npm run check
    npm start

The first start creates a random operator token, stores only its SHA-256 hash in the SQLite settings table, and prints the plaintext token once. Copy it into a password manager. Do not put it in source control or share it in chat.

The server binds to 127.0.0.1:4317 by default.

## Subsequent launches

Set the token in the current PowerShell session before starting:

    $env:RAYA_CC_OPERATOR_TOKEN = 'PASTE_THE_SAVED_TOKEN_HERE'
    npm start

If the database already has an operator-token hash and the environment variable is absent or incorrect, startup fails closed.

## Rotate the operator token

1. Stop the running server.
2. Run:

       node src/rotate-operator-token.js

3. Save the new token from stdout in a password manager.
4. Set RAYA_CC_OPERATOR_TOKEN to the new token in PowerShell.
5. Restart with npm start.

The rotation command changes the database hash immediately. The old server process retains its in-memory token until stopped, so stop it before rotating.

## Configuration

- RAYA_CC_PORT ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â TCP port, default 4317.
- RAYA_CC_DATABASE ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â SQLite file path, default .data/control-center.sqlite.
- RAYA_CC_OPERATOR_TOKEN ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â operator token, minimum 32 characters.

The API is local-only. Do not expose it through a reverse proxy, tunnel, port forward, or wildcard bind. Remote ingress is explicitly outside the MVP.

## Data and backups

The database is application state and contains participant metadata, task payloads, leases, operator credential hash, and event history. Protect it as private data.

For a consistent simple backup, stop the server, copy the database file, then restart. WAL sidecar files may exist while the server is running; do not copy only the main database file during active writes.

## API smoke check

With the server running:

    Invoke-RestMethod http://127.0.0.1:4317/control/v1/health

Expected response:

    status api
    ------ ---
    ok     control/v1

## CLI

With the server running and RAYA_CC_OPERATOR_TOKEN set:

    npm run cli -- health
    npm run cli -- participant register --name local-worker --scope tasks:claim
    npm run cli -- task create --type example.job

For API clients, supply a stable `idempotencyKey` when creating a Task. If the response is lost, resend the same type, payload, priority, and key: the API returns the existing Task with HTTP 200 and `idempotentReplay: true`. A key reused with different task input is rejected with `409 conflict`.
    npm run cli -- task get TASK_ID
    npm run cli -- task cancel TASK_ID
    npm run cli -- events --limit 25
    npm run cli -- reconcile

The participant registration command displays its credential once. Treat stdout as secret-bearing output and save the token securely.

## SQLite backup and restore

Backups use SQLite VACUUM INTO to create a consistent snapshot, including committed data in the WAL. The backup command can run while the Control Center is active:

    npm run db:backup
    npm run db:backup -- D:/Backups/raya-control-center.sqlite

The default destination is a timestamped file under .backups. Existing destination files are never overwritten. Set RAYA_CC_DATABASE if the live database is not at the default path.

Restore is deliberately offline:

1. Stop the Control Center process and ensure no other process has the database open.
2. Confirm the target database has no -wal or -shm sidecars.
3. Run:

       npm run db:restore -- D:/Backups/raya-control-center.sqlite

The restore validates SQLite integrity, foreign-key consistency, and the schema version before replacing the target. The previous database file is retained beside it with a .pre-restore-<id> suffix for rollback. The command refuses to proceed when WAL sidecars exist; it does not try to delete or merge live WAL state. Start the server only after restore has completed successfully.

Backups contain credential verifier hashes, participant metadata, task payloads, and event history. Store them as sensitive application data and restrict access accordingly.
