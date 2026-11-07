# Local Operations

## First launch

Open PowerShell in the repository root and run:

```powershell
npm test
npm run check
npm start
```

The first start creates a random operator token, stores only its SHA-256 hash in the SQLite settings table, and prints the plaintext token once. Copy it into a password manager. Do not put it in source control or share it in chat.

The server binds to `127.0.0.1:4317` by default.

## Subsequent launches

Set the token in the current PowerShell session before starting:

```powershell
$env:RAYA_CC_OPERATOR_TOKEN = 'PASTE_THE_SAVED_TOKEN_HERE'
npm start
```

If the database already has an operator-token hash and the environment variable is absent or incorrect, startup fails closed.

## Graceful shutdown

On Ctrl+C or a normal SIGTERM delivery, the server stops accepting new HTTP connections, closes idle connections, allows active requests up to 10 seconds to drain, then closes SQLite. If active connections remain after the drain timeout, they are closed before SQLite is closed. Do not forcibly terminate the process during normal operation; forced termination is reserved for recovery scenarios and SQLite WAL recovery is tested separately.

## Startup recovery and lease expiry

Before the HTTP listener begins accepting requests, startup reconciliation checks active leases against their expiry timestamps. Tasks whose leases have expired while claimed, running, or awaiting cancellation are moved to `blocked`, their leases are marked expired, and their assignment is cleared.

The server also repeats lease reconciliation every 15 seconds while running. This is a safety boundary, not an automatic retry mechanism: the Control Center cannot know whether an external side effect completed before a worker crashed or lost connectivity. Inspect the task and any external side effects before creating replacement work. Never automatically replay uncertain non-idempotent work.

## Configuration

- `RAYA_CC_PORT`: TCP port, default `4317`.
- `RAYA_CC_DATABASE`: SQLite file path, default `.data/control-center.sqlite`.
- `RAYA_CC_OPERATOR_TOKEN`: operator token, minimum 32 characters.

The API is local-only. Do not expose it through a reverse proxy, tunnel, port forward, or wildcard bind. Remote ingress is explicitly outside the MVP.

## Operator token rotation

Rotate the Operator credential through the running local API while the current token is still available:

```powershell
npm run cli -- operator rotate
```

The command returns the replacement token once. Save it securely before closing the terminal. The old token is invalidated immediately for subsequent requests; update the environment used to start the Control Center and all Operator CLI sessions to the new value before restarting or issuing more commands. Do not paste the token into tickets, chat, source files, or shell history. The token is returned in CLI standard output, so avoid transcript capture and redirected logs.

If the CLI loses the rotation response, or the saved token is otherwise unavailable, stop the server and recover a replacement locally:

~~~powershell
npm run operator:recover
~~~

For a custom database, pass its exact path:

~~~powershell
npm run operator:recover -- "D:/Data/raya-control-center.sqlite"
~~~

Recovery uses the same exclusive runtime lock as server startup. It refuses to run while a server using that database is active, rotates the stored credential hash, and prints the new token once. Set RAYA_CC_OPERATOR_TOKEN to the recovered value before restarting. It does not modify task, participant, or event data.

The lock file is next to the database with suffix .runtime.lock. A forced process termination can leave a stale lock behind. Never delete it merely to bypass an error: inspect its PID, verify that the process is no longer running and that no other Control Center instance uses the database, then remove only that exact lock file and retry recovery. Do not remove the lock while the server is running.

## Windows data-directory permissions

The database, WAL/SHM sidecars, and backups contain sensitive application state. On Windows, the default NTFS ACL inherited from a broadly writable parent directory may allow other local accounts to read or modify these files. Inspect the configured data directory and any separate backup directory before using the application with real data.

An opt-in helper is provided for a dedicated data directory. Stop the Control Center and all workers first, close any process using files in the directory, then run this from the repository root:

```powershell
.\scripts\secure-data-acl.ps1 -Path .\.data
```

For a custom RAYA_CC_DATABASE path, pass its containing directory instead. Run the helper separately for a backup directory if backups are stored elsewhere. The helper refuses reparse points and open files, supports -WhatIf, disables inherited ACLs on the selected tree, and grants Full Control only to the current Windows user, SYSTEM, and local Administrators. It snapshots existing ACLs in memory and attempts to restore them if an ACL update fails. It does not change parent directories, other project files, or system-wide permissions.

This is an explicit administrative operation; the application does not modify ACLs automatically. Review the target path carefully before running it. The helper has been tested against a disposable directory tree in Windows CI; the repository actual .data directory has not been modified. Do not run it against a directory shared by unrelated applications or data.

## Data and backups

The database is application state and contains participant metadata, task payloads, leases, operator credential hash, and event history. Protect it as private data.

For a consistent simple backup, stop the server, copy the database file, then restart. WAL sidecar files may exist while the server is running; do not copy only the main database file during active writes.

## API smoke check

With the server running:

```powershell
Invoke-RestMethod http://127.0.0.1:4317/control/v1/health
```

Expected response:

```text
status api
------ ---
ok     control/v1
```

## CLI

With the server running and `RAYA_CC_OPERATOR_TOKEN` set:

```powershell
npm run cli -- health
npm run cli -- participant register --name local-worker --scope tasks:claim
npm run cli -- task create --type example.job
npm run cli -- task get TASK_ID
npm run cli -- task cancel TASK_ID
npm run cli -- events --limit 25
npm run cli -- reconcile
```

The participant registration command displays its credential once. Treat stdout as secret-bearing output and save the token securely.

For API clients, supply a stable `idempotencyKey` when creating a Task. If the response is lost, resend the same type, payload, priority, and key: the API returns the existing Task with HTTP 200 and `idempotentReplay: true`. A key reused with different task input is rejected with `409 conflict`.

## SQLite backup and restore

Backups use SQLite `VACUUM INTO` to create a consistent snapshot, including committed data in the WAL. The backup command can run while the Control Center is active:

```powershell
npm run db:backup
npm run db:backup -- D:/Backups/raya-control-center.sqlite
```

The default destination is a timestamped file under `.backups`. Existing destination files are never overwritten. Set `RAYA_CC_DATABASE` if the live database is not at the default path.

Restore is deliberately offline:

1. Stop the Control Center process and ensure no other process has the database open.
2. Confirm the target database has no `-wal` or `-shm` sidecars.
3. Run:

   ```powershell
   npm run db:restore -- D:/Backups/raya-control-center.sqlite
   ```

The restore validates SQLite integrity, foreign-key consistency, and the schema version before replacing the target. The previous database file is retained beside it with a `.pre-restore-<id>` suffix for rollback. The command refuses to proceed when WAL sidecars exist; it does not try to delete or merge live WAL state. Start the server only after restore has completed successfully.

Backups contain credential verifier hashes, participant metadata, task payloads, and event history. Store them as sensitive application data and restrict access accordingly.

## Read-only dashboard

With the Control Center server running, open:

```text
http://127.0.0.1:4317/
```

Paste the saved Operator token into the dashboard's session field and select **Connect**. The dashboard reads the latest 100 Tasks, Participants, and Events using the existing Operator-authenticated read endpoints. Status/type/entity filters are available; use **Refresh** to reload data.

The dashboard is deliberately read-only. It does not create or cancel Tasks, register or revoke Participants, or run lease reconciliation. It does not display Task payloads, Task results, Participant tokens, lease tokens, or credential hashes.

The Operator token is kept only in the page's JavaScript memory. It is not persisted in localStorage, sessionStorage, cookies, or URL parameters. Reloading the page or selecting **Disconnect** clears the session. Use the dashboard only on the local machine; the server continues to bind to loopback only.

Static dashboard assets are served with a restrictive Content Security Policy, no-store caching, no-referrer policy, frame denial, and MIME sniffing protection. Dashboard HTML/assets are not an authentication boundary; all operational data remains protected by the Operator-authenticated API.
