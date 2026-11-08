# Restore crash recovery runbook

## Scope

Use this procedure only when a Restore process terminated unexpectedly and the normal live database path is missing or a `.pre-restore-<uuid>` file remains. The application does **not** automatically recover these files. Each Restore now publishes an atomic intent record (its file contents are fsynced before publication) at `<database>.restore-journal.json` before moving or installing database files. A crash leaves this journal in place and blocks another Restore until an operator reviews it. This is intentional: a lock file alone cannot prove that its owner is dead, and selecting one of several rollback files automatically could overwrite valid data.

Lock acquisition also follows a preserve-on-uncertainty rule. If writing or flushing a newly created lock fails, the acquisition closes its descriptor but deliberately leaves the lock path in place and attaches that exact path as `error.lockPath`. The file may be incomplete or may have been published without a confirmed directory flush; it must be inspected and treated as a possible active lock, not automatically deleted or retried around. Verify that every database user is stopped and compare the recorded PID/start time before an operator removes that exact file. This avoids a cleanup race in which a failed acquirer could unlink a replacement lock created by another owner.

This procedure is for an operator who has verified that the Control Center server and every other process using this database are stopped. Do not use it while the server is running.

## 1. Identify the database and inspect artifacts

Run the read-only inspection command first:

```powershell
$env:RAYA_CC_DATABASE = (Join-Path (Get-Location) '.data\control-center.sqlite')
npm run db:restore:inspect
```

The JSON report shows the live database, runtime and maintenance lock presence, journal validity, recorded paths, whether each recorded artifact exists, any unpublished journal temporary files in `journal.orphanedTemporaryFiles`, and a conservative `recovery.state` classification. The state model distinguishes absent or invalid journals, present locks, missing live or rollback files, and ambiguous live-plus-rollback combinations. It is an observation summary, not a recovery decision: it does not test whether a PID is alive, decide whether a lock is stale, validate a database snapshot, or choose an authoritative copy. When no valid journal exists, artifact paths that are not independently inspected are reported as null (unknown), not as absent. A remaining runtime or maintenance lock is classified separately as no-pending-restore-lock-present. `readOnly: true` means the command does not create, remove, rename, or modify files or locks. A malformed, invalid, or mismatched journal must be preserved for manual review.


Set the exact paths; do not use a wildcard as a deletion target:

```powershell
$Database = (Resolve-Path '.data\control-center.sqlite' -ErrorAction SilentlyContinue).Path
if (-not $Database) { $Database = [IO.Path]::GetFullPath('.data\control-center.sqlite') }
$Directory = Split-Path -Parent $Database
Get-ChildItem -LiteralPath $Directory -Force |
  Where-Object { $_.Name -like 'control-center.sqlite.pre-restore-*' -or $_.Name -like '.control-center.sqlite.*.restore' -or $_.Name -in @('control-center.sqlite.runtime.lock','control-center.sqlite.maintenance.lock') } |
  Select-Object Name, Length, LastWriteTime
```

Keep every `.pre-restore-*` file. Each may be the only surviving copy of the pre-restore database. Do not delete or rename candidates until one has been selected and verified. Read the exact journal named `<database>.restore-journal.json` as JSON; it records the operation PID/time and exact source, destination, temporary, and rollback paths. Treat those paths as evidence, not as permission to delete files.

## 2. Verify lock owners before removing stale locks

Inspect lock contents:

```powershell
foreach ($Suffix in @('.runtime.lock', '.maintenance.lock')) {
  $Lock = $Database + $Suffix
  if (Test-Path -LiteralPath $Lock) {
    "--- $Lock"
    Get-Content -LiteralPath $Lock
  }
}
```

For each reported PID, inspect the process and its start time:

```powershell
Get-Process -Id <PID> -ErrorAction SilentlyContinue |
  Select-Object Id, ProcessName, StartTime, Path
```

Compare the process start time with `startedAt` in the lock JSON. A missing PID or a mismatched start time is useful evidence but is not, by itself, proof that no other process has the database open. Confirm the server and all database clients are stopped before proceeding. If ownership is ambiguous, stop and preserve all files.

Only after that verification, remove the exact stale lock file(s) shown by the inspection. Do not use wildcard deletion:

```powershell
Remove-Item -LiteralPath ($Database + '.runtime.lock') -ErrorAction Stop
Remove-Item -LiteralPath ($Database + '.maintenance.lock') -ErrorAction Stop
```

Run only the command for a lock file that actually exists and has been verified stale.

## 3. Resolve the reviewed Restore journal

After verifying that all database users are stopped, preserve a copy of the journal and inspect its recorded paths. If the journal is missing, malformed, references unexpected paths, or the filesystem state does not match the expected operation, stop and preserve all artifacts. Do not guess.

Once the operator has selected a recovery action, archive the exact journal so the normal Restore command can proceed. This does not delete it:

```powershell
$Journal = $Database + '.restore-journal.json'
$ReviewedJournal = $Journal + '.reviewed-' + (Get-Date -Format yyyyMMdd-HHmmss)
Move-Item -LiteralPath $Journal -Destination $ReviewedJournal -ErrorAction Stop
```

Keep the reviewed journal with the incident artifacts. Do not rename it until the locks are verified stale and the recovery choice is made.

## 4. Recover when the live database path is absent

Choose one exact `.pre-restore-<uuid>` file from the listing. First verify that it opens as a valid Control Center database and has the expected schema/integrity. The supported restore command validates the candidate again before installing it:

```powershell
$Rollback = 'D:\absolute\path\control-center.sqlite.pre-restore-<uuid>'
$env:RAYA_CC_DATABASE = $Database
npm run db:restore -- $Rollback
```

Because the destination is absent, Restore installs the selected rollback database without replacing another live database. If the command reports a lock, path, or validation error, stop and preserve the files; do not work around the error by deleting additional files.

## 5. If a live database already exists

Do not restore over it as part of crash cleanup. The presence of a live database may mean the new snapshot was installed successfully before the crash. Preserve both the live database and every `.pre-restore-*` file. Inspect and compare them using copies in a separate recovery directory, and make a deliberate operator decision before any further restore.

## 6. Orphaned temporary files

A `.restore` temporary file is not a substitute for a rollback database. Leave it in place until the live database has been recovered, validated, and backed up. Only then may an operator remove a specifically identified orphaned `.restore` file after confirming no maintenance process is active.


## Unpublished Restore journal temporary files

If the published journal is absent, inspection also enumerates exact sibling names matching `<database>.restore-journal.json.<uuid>.tmp` and reports their absolute paths in `journal.orphanedTemporaryFiles`. These files can remain if the Restore process terminated after writing and fsyncing its temporary journal but before publishing the journal name. The temporary file may contain useful intent evidence, but its presence alone does **not** establish whether Restore began, whether any database artifact was changed, or whether the record is complete and authoritative.

The inspector emits a warning to preserve these files for operator review. `readOnly: true` still applies: inspection does not read, rename, publish, or delete these temporary files. `recovery.automaticAction` remains `none`. The recovery state classifier is based on the published journal, locks, and inspected database artifacts; an orphaned journal temporary is an additional warning and does not itself create a pending-journal state. Therefore, even a `no-pending-restore` state must not be interpreted as permission to discard a reported journal temporary.

List the exact reported paths and preserve them with the incident evidence:

```powershell
$Report = npm run db:restore:inspect --silent | ConvertFrom-Json
$Report.journal.orphanedTemporaryFiles
```

Do not rename a temporary file to the published journal name, feed it to Restore, or delete it as routine cleanup. First verify that the server and every database client are stopped. Preserve a copy for manual examination; if its contents or the filesystem state are ambiguous, stop and escalate for an operator decision. Do not remove it merely because the published journal is absent or because the recovery classifier reports `no-pending-restore`.

Backup cleanup follows the same reporting rule. A successful createDatabaseBackup() result includes cleanupWarnings when the validated backup was published but its temporary hard link could not be removed. If snapshot creation fails and the partial temporary file also cannot be removed, the original error is thrown with cleanupWarnings attached; the warning identifies the preserved temporary path and filesystem error code/name. Do not treat a failed-backup temporary as a valid backup. If forensic inspection is needed, preserve a copy before retrying; a later backup removes matching stale UUID temporary files only after acquiring the source and destination maintenance locks. The backup CLI includes cleanupWarnings in successful JSON output and prints them on failure.

## Restore cleanup warnings

A successful restoreDatabaseBackup() result includes cleanupWarnings (an empty array when cleanup succeeds). If removal of the staged .restore link or the published .restore-journal.json fails after the new database has been installed, the Restore operation still reports the validated installation result and includes the affected artifact path and filesystem error code/name in cleanupWarnings. This distinction is deliberate: a post-install cleanup failure does not undo a valid installation and must not trigger rollback of the newly installed database.

Treat every reported cleanup warning as outstanding maintenance, not as permission to delete the artifact. In particular, a retained journal blocks another Restore until an operator inspects the live database, rollback copy, staged file, and journal, verifies that all database clients are stopped, and resolves the evidence deliberately. A retained staged hard link is also preserved; do not remove it until the installed database has been verified and a separate backup exists. Cleanup warnings report filesystem failure details without including file contents.

The destination-publication race tests also create a competing file after preflight validation but immediately before the atomic hard-link operation. Backup must fail without replacing that file and must release both maintenance locks. Restore must leave the competing destination untouched and preserve the original database at its rollback path together with the published journal; it does not overwrite the competing file or infer that the rollback is no longer needed.
Backup and Restore now inject an fsync failure after snapshot validation. Backup must refuse to publish the unflushed file; Restore must leave the original live database untouched and remove the unpublished staged copy and journal. These tests validate application behavior when the file flush reports failure; they do not simulate a real storage-device power loss.
The concurrent-WAL snapshot test runs VACUUM INTO in a separate process while another SQLite connection commits a transaction that updates every probe row in one atomic transaction. The resulting backup must pass integrity_check and contain either the complete pre-commit generation or the complete post-commit generation; a mixture is not accepted. Which side of the commit appears depends on when SQLite establishes the snapshot, so the test does not require a backup to include writes committed after that snapshot boundary.

## Restore recovery state model

The recovery.state field is deliberately conservative:

| State | Meaning of observed paths | Required posture |
| --- | --- | --- |
| no-pending-restore | No journal or lock at the expected paths | Normal operation may continue; this is not an integrity check |
| no-pending-restore-lock-present | No journal, but a runtime or maintenance lock remains | Verify all database users are stopped; do not infer stale ownership |
| manual-review-invalid-journal | Journal malformed, invalid, or unreadable | Preserve all artifacts; no retry |
| blocked-lock-present | A valid journal and at least one lock path exists | Verify all database users are stopped; do not infer stale ownership |
| live-missing-rollback-present | Live path absent, rollback path present | Validate a separate copy; operator must choose explicitly |
| live-and-rollback-present-ambiguous | Both paths present | Preserve and compare copies; do not infer which is authoritative |
| live-and-rollback-missing | Neither live nor rollback path exists | Stop; investigate all remaining artifacts |
| live-present-temporary-present-no-rollback | Live and staged temporary paths present, rollback absent | Preserve; do not infer the live file is unchanged |
| live-present-no-rollback | Live path present, rollback absent, temporary absent | Preserve and verify a copy; no automatic cleanup |

Every state returns automaticAction: none. A temporary file can be incomplete, a live file can be newly installed, and a lock can be stale or active; this model does not distinguish those cases. It maps observed presence to a safe operator posture only.

## Crash-state simulation coverage

The automated child-process crash suite currently terminates a Restore worker at these operation boundaries and then inspects the actual on-disk artifacts:

| Injected boundary | Expected files at termination | What the test establishes |
| --- | --- | --- |
| Immediately after journal publication | Live database and valid journal; no staged temporary or rollback | The intent record is published before staging begins; inspection reports the pending operation without mutation |
| Immediately after staged copy | Live database, valid journal, and staged temporary; no rollback | A crash during the staging-to-validation gap leaves the original live path intact and preserves the staged artifact |
| After staged-copy validation, before moving the original | Live database, valid journal, and staged temporary; no rollback | The pre-move boundary remains distinguishable from the later move/install windows by observed paths only |
| Immediately after moving the original | Valid journal, staged temporary, and rollback; live path absent | The original database remains available at the recorded rollback path |
| Immediately after installing the new database | Valid journal, live installed database, and rollback | Both database copies remain available and inspection does not choose between them |
| After temporary-file cleanup, before journal cleanup | Valid journal, live installed database, and rollback; no temporary | The new live database and original rollback remain; the journal still records the unfinished operation |
| Immediately after journal cleanup, before lock release | No journal; live installed database and rollback; both locks remain | Inspection reports the residual lock instead of treating the operation as an entirely clear state |

The first three boundaries are exercised by the `restore crash simulation classifies journal publication and staging boundaries` test. The move/install boundaries are exercised by the adjacent crash-gap and post-install tests. These are child-process forced exits at instrumented filesystem-operation boundaries; they are not power-loss tests, kernel-crash tests, storage-controller tests, or proof of directory-entry durability. The lock files left by forced exits are expected, and the state model conservatively reports `blocked-lock-present` until an operator verifies ownership and stopped database users. The final temporary-file and journal-cleanup windows are exercised by the restore cleanup crash-boundary test. The tests do not enable automatic recovery.

## Safety properties and limitations

- The application deliberately refuses to guess whether a lock is stale or which rollback file is authoritative. A pending Restore journal also blocks another Restore.
- Recovery requires a verified stopped server and explicit operator selection of the rollback file.
- The normal `db:restore` path revalidates the selected snapshot and uses the existing runtime and maintenance locks. The journal is an intent/evidence record for process-crash recovery, not an automatic recovery engine. Backup explicitly sets SQLite PRAGMA synchronous = FULL, validates the generated snapshot, and fsyncs the snapshot file before publishing its hard link. Restore validates the staged copy and fsyncs that file before moving the live database. An fsync failure aborts publication or installation; fault-injection tests verify that the previous live database is retained and no failed backup is published. These file-content flushes do not make parent-directory changes durable: hard-link publication, rename, and unlink directory entries can still have filesystem/platform-specific power-loss behavior. In particular, this implementation does not claim directory-entry durability on Windows or universal power-loss safety.
- This runbook is a manual recovery path, not automatic crash recovery. Automatic recovery remains deferred until journal-state interpretation, stale-owner verification, and the crash-state protocol are designed and tested across Windows filesystem semantics.
- Keep the original rollback file until a fresh backup has been created and verified.
## Directory-entry durability and platform boundary

The durability helper flushes a parent directory after lock creation/removal, Restore Journal publication/removal, Backup hard-link publication, and Restore rename/link/cleanup operations on POSIX platforms where Node.js can open and fsync a directory descriptor. A directory-fsync error is propagated; it is not silently treated as a successful durable transition. If Backup has already linked its destination when that flush fails, the error reports publishedArtifact; preserve and inspect that artifact rather than assuming publication was rolled back. Restore preserves its journal and rollback evidence when installation has been published but the directory flush fails.

On Windows, the helper explicitly reports directory flushing as unsupported because portable Node.js filesystem APIs do not provide a supported directory-handle FlushFileBuffers operation. The application continues to flush file contents and performs the same atomic filesystem operations, but does not claim durable directory-entry ordering on Windows. The Windows CI tests exercise the explicit unsupported branch and simulated POSIX helper behavior. The Linux CI job runs the real directory-fsync integration test on the hosted Ubuntu filesystem for each supported Node.js CI version; this is an integration check on that runner filesystem, not coverage of every POSIX filesystem or storage stack.

Even on POSIX, successful directory fsync is not a guarantee against faulty storage hardware, controller caches, virtualized storage behavior, or filesystems that do not honor flush requests. These changes improve ordering and error visibility; they are not a universal power-loss guarantee.

The POSIX-only Restore fault-injection suite also forces directory-fsync errors at four distinct boundaries: journal publication, the original-database move (including automatic rollback), new-database installation, and journal cleanup. It verifies which database remains readable, whether the journal and rollback evidence are retained, and whether runtime/maintenance locks are released. These tests run on the Linux CI matrix; they are skipped on Windows because directory fsync is explicitly unsupported there. Fault injection verifies application error handling, not physical power-loss behavior.
