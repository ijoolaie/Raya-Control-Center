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

### Controlled manual recovery

A blocked task can be returned to `queued` only through the Operator-only requeue action. This does not prove that a Worker process has stopped or that an external side effect did not happen; the two required confirmations are explicit operator attestations. Do not use them as a formality.

1. Inspect the task (`npm run cli -- task get TASK_ID`) and its event history (`npm run cli -- events --entity-type task --entity-id TASK_ID`).
2. Confirm through the process supervisor/OS that the previous Worker is stopped and cannot continue its work.
3. Inspect the target external system using its own authoritative records. If the side effect may already have happened or its state is uncertain, do not requeue; resolve that uncertainty first.
4. Only after both checks, run:

   ```powershell
   npm run cli -- task requeue TASK_ID --reason "what was checked and why replay is safe" --confirm-worker-stopped --confirm-side-effects-reviewed
   ```

The reason is stored in the append-only `task.requeued` audit event. Requeue clears the old assignment, Lease reference, progress, result, and attempt timestamps but preserves the old Lease record and event history. The next eligible Worker receives a new Lease; the previous Lease token cannot heartbeat or complete the task. Repeating the requeue after it has left `blocked` is rejected. This action is a controlled replay of the same task payload, so it is appropriate only when the external state has been verified safe or the operation is independently idempotent.

## Configuration

- `RAYA_CC_PORT`: TCP port, default `4317`.
- `RAYA_CC_DATABASE`: SQLite file path, default `.data/control-center.sqlite`.
- `RAYA_CC_OPERATOR_TOKEN`: operator token, 32–1024 URL-safe ASCII characters (letters, digits, `_`, or `-`).

The API is local-only. Do not expose it through a reverse proxy, tunnel, port forward, or wildcard bind. Remote ingress is explicitly outside the MVP.

## Operator token rotation

Rotate the Operator credential through the running local API while the current token is still available:

```powershell
npm run cli -- operator rotate
```

The command returns the replacement token once. Save it securely before closing the terminal. The old token is invalidated immediately for subsequent requests. Requests to create Tasks or register Participants are authorized after their complete request body has arrived, so a body still in transit during rotation is checked against the new token and rejected if it uses the old one. Update the environment used to start the Control Center and all Operator CLI sessions to the new value before restarting or issuing more commands. Do not paste the token into tickets, chat, source files, or shell history. The token is returned in CLI standard output, so avoid transcript capture and redirected logs.

If the CLI loses the rotation response, or the saved token is otherwise unavailable, stop the server and recover a replacement locally:

~~~powershell
npm run operator:recover
~~~

For a custom database, pass its exact path:

~~~powershell
npm run operator:recover -- "D:/Data/raya-control-center.sqlite"
~~~

Recovery uses the same exclusive runtime lock as server startup. It refuses to run while a server using that database is active, rotates the stored credential hash, and prints the new token once. Set RAYA_CC_OPERATOR_TOKEN to the recovered value before restarting. It does not modify task, participant, or event data.

The runtime lock is a persistent SQLite sidecar next to the database with suffix `.runtime.lock`. Ownership is represented by an open `BEGIN IMMEDIATE` transaction, not by the sidecar file existing. The sidecar normally remains after shutdown; this is expected and it must not be deleted as routine cleanup. `npm run db:restore:inspect` reports `locks.runtime.active`: `true` means a process currently holds the lock, `false` means the sidecar is idle, and `null` means the artifact could not be validated (for example, a legacy JSON lock). Process termination releases the SQLite reservation automatically. Preserve and manually review any unrecognized legacy artifact before moving it aside.

## Credential safety after Restore

A database Backup is a point-in-time snapshot of the complete SQLite state. It includes the Operator token hash, Participant token hashes and statuses, active/revoked Lease records, and task assignments. Restoring an older snapshot therefore also rolls credential state back: an Operator token rotated after the snapshot can become valid again, a Participant revoked after the snapshot can become active again, and a previously active Lease token can become usable again if it has not expired. This is expected snapshot behavior, not a failure of the live revocation endpoints.

**Do not reconnect workers or adapters immediately after Restore.** Use this sequence every time an older Backup is installed:

1. Stop the Control Center and every Worker, adapter, and other client that can use Participant or Lease credentials.
2. Restore the selected Backup using npm run db:restore -- <backup-file>.
3. Before starting the server, rotate the restored Operator credential offline using npm run operator:recover (or pass the exact database path as documented above). Save the one-time token securely.
4. Start the server using the recovered RAYA_CC_OPERATOR_TOKEN.
5. Before restarting any Worker or adapter, list all active Participants with npm run cli -- participant list --status active and revoke every restored active Participant using npm run cli -- participant revoke <PARTICIPANT_ID>. Revocation also invalidates its active Leases and blocks affected nonterminal tasks.
6. Re-register the required Participants and distribute their newly issued tokens only to their intended processes. Reassess blocked tasks and external side effects before creating replacement work.

The blanket revocation is intentional: the restored database cannot identify which active Participant credentials were revoked or rotated after the Backup was taken. Re-registering all active Participants is the reliable way to ensure those stale credentials do not survive recovery. Keep all clients stopped until this sequence is complete.
## Windows data-directory permissions

The database, WAL/SHM sidecars, and backups contain sensitive application state. On Windows, the default NTFS ACL inherited from a broadly writable parent directory may allow other local accounts to read or modify these files. Inspect the configured data directory and any separate backup directory before using the application with real data.

An opt-in helper is provided for a dedicated data directory. Open an elevated PowerShell session (Run as administrator), stop the Control Center and all workers, and close any process using files in the directory before running this from the repository root:

```powershell
.\scripts\secure-data-acl.ps1 -Path .\.data
```

For a custom RAYA_CC_DATABASE path, pass its containing directory instead. Run the helper separately for a backup directory if backups are stored elsewhere. The helper refuses reparse points, files with multiple hard links, and open files, supports -WhatIf, disables inherited ACLs on the selected tree, and grants Full Control only to the current Windows user, SYSTEM, and local Administrators. It snapshots existing ACLs in memory and attempts to restore them if an ACL update fails. It does not change parent directories, other project files, or system-wide permissions.

This is an explicit administrative operation; the application does not modify ACLs automatically. Review the target path carefully before running it. The helper has been tested against a disposable directory tree in Windows CI and was also applied to this workstation's repository .data directory on 2026-11-11. Post-run verification confirmed that the directory and all four files present at that time had protected DACLs granting Full Control only to the current Windows user, SYSTEM, and local Administrators; no other allow entries remained. No separate backup directory existed at verification time. If a separate backup directory is created later, secure it with the same helper before storing real backups. Do not run it against a directory shared by unrelated applications or data.

## Data and backups

The database is application state and contains participant metadata, task payloads, leases, operator credential hash, and event history. Protect it as private data.

On POSIX systems, the main database, existing WAL/SHM sidecars, newly created backup snapshots, and restored database files are restricted to mode 0600 before publication/installation. Backup snapshots are generated inside a destination-local temporary directory restricted to mode 0700 before SQLite writes any snapshot bytes. On Windows, Node's portable chmod does not establish restrictive NTFS ACLs: the staging directory inherits the destination parent ACL, so use the opt-in ACL helper to restrict both the data directory and any separate backup directory before creating real backups. Existing directories and their parent ACLs remain the operator's responsibility. The application also rejects database paths that currently traverse symbolic links or Windows directory junctions, and rejects an existing database path that is not a regular file. These are pre-open checks; portable Node SQLite APIs cannot eliminate a hostile path-replacement race between validation and SQLite open. Keep the database parent directory writable only by trusted application/operator principals.

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
npm run cli -- task requeue TASK_ID --reason "verified external state" --confirm-worker-stopped --confirm-side-effects-reviewed
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

The default destination is a timestamped file under `.backups`. After acquiring the maintenance lock, backup and restore remove only stale temporary artifacts matching their exact destination-specific UUID naming pattern and expected type/content. Backup staging directories are also cleaned only when their exact UUID name and expected empty-or-single-snapshot contents match; unexpected contents, symbolic links, and unrelated directories are preserved. Restore cleanup does not remove directories or .pre-restore-* rollback files. If a process is forcibly terminated, SQLite releases its maintenance reservation automatically. Leave the persistent `.maintenance.lock` sidecar in place; rerun maintenance to clean abandoned temporary files after verifying `active: false` in the restore-inspection report. Existing destination files are never overwritten. Set `RAYA_CC_DATABASE` if the live database is not at the default path.

Restore is deliberately offline. It acquires the same per-database runtime lock used by server startup, so an active Control Center is rejected before the database can be replaced. It also acquires the maintenance lock to exclude a simultaneous backup:

1. Stop the Control Center process and ensure no other process has the database open.
2. Confirm the target database has no `-wal` or `-shm` sidecars.
3. Run:

   ```powershell
   npm run db:restore -- D:/Backups/raya-control-center.sqlite
   ```

The restore validates SQLite integrity, foreign-key consistency, and the schema version before replacing the target. The previous database file is retained beside it with a `.pre-restore-<id>` suffix for rollback. The command refuses to proceed when the runtime lock or maintenance lock is held, or when WAL sidecars exist; it does not try to delete or merge live WAL state. Lock files are coordination metadata and are never included in the SQLite backup snapshot. Start the server only after restore has completed successfully.

Backups contain credential verifier hashes, participant metadata, task payloads, and event history. Store them as sensitive application data and restrict access accordingly.

## Local operator dashboard

With the Control Center server running, open:

```text
http://127.0.0.1:4317/
```

Paste the saved Operator token into the dashboard's session field and select **Connect**. The dashboard reads the latest 100 Tasks, Participants, and Events using the existing Operator-authenticated read endpoints. Status/type/entity filters are available; use **Refresh** to reload data.

The dashboard does not create or cancel Tasks, register or revoke Participants, or run lease reconciliation. It provides two narrowly scoped Operator mutations: **Participant capability updates** and **controlled requeue of a blocked Task**. In the Participant inspector, the capability editor previews the exact sorted before/after diff and requires an explicit acknowledgement plus final confirmation. The API accepts updates only for active Participants, records the change in the append-only audit history, and applies new capabilities to future claims without changing existing Leases. For task recovery, select **Inspect / recover** on a blocked Task to load its current Task metadata and up to 50 events for that Task. Payloads, results, Participant tokens, Lease tokens, and credential hashes are never rendered.

The recovery form is shown only when the Task is still `blocked` and its newest event is exactly `task.lease_expired_blocked` or `task.participant_revoked_blocked`. Before enabling **Confirm requeue**, the Operator must enter a reason and separately attest that (1) the previous Worker has stopped and (2) external side effects have been reviewed. The API revalidates the Task state and history; the dashboard's eligibility check is not an authorization or safety boundary. A rejection requires refreshing and inspecting the current Task before another attempt. Requeue is never automatic. Do not requeue when an external operation may already have succeeded or its outcome is unknown.

The Operator token is kept only in the page's JavaScript memory. It is not persisted in localStorage, sessionStorage, cookies, or URL parameters. Reloading the page or selecting **Disconnect** clears the session and closes the inspector. Use the dashboard only on the local machine; the server continues to bind to loopback only.

Static dashboard assets are served with a restrictive Content Security Policy, no-store caching, no-referrer policy, frame denial, and MIME sniffing protection. Dashboard HTML/assets are not an authentication boundary; all operational reads and mutations remain protected by the Operator-authenticated API.
