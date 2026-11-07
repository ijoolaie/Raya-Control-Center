# Restore crash recovery runbook

## Scope

Use this procedure only when a Restore process terminated unexpectedly and the normal live database path is missing or a `.pre-restore-<uuid>` file remains. The application does **not** automatically recover these files. Each Restore now publishes an atomic intent record (its file contents are fsynced before publication) at `<database>.restore-journal.json` before moving or installing database files. A crash leaves this journal in place and blocks another Restore until an operator reviews it. This is intentional: a lock file alone cannot prove that its owner is dead, and selecting one of several rollback files automatically could overwrite valid data.

This procedure is for an operator who has verified that the Control Center server and every other process using this database are stopped. Do not use it while the server is running.

## 1. Identify the database and inspect artifacts

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

## Safety properties and limitations

- The application deliberately refuses to guess whether a lock is stale or which rollback file is authoritative. A pending Restore journal also blocks another Restore.
- Recovery requires a verified stopped server and explicit operator selection of the rollback file.
- The normal `db:restore` path revalidates the selected snapshot and uses the existing runtime and maintenance locks. The journal is an intent/evidence record for process-crash recovery, not an automatic recovery engine. File contents are fsynced, but directory-entry durability across sudden power loss is filesystem/platform dependent and is not claimed.
- This runbook is a manual recovery path, not automatic crash recovery. Automatic recovery remains deferred until journal-state interpretation, stale-owner verification, and the crash-state protocol are designed and tested across Windows filesystem semantics.
- Keep the original rollback file until a fresh backup has been created and verified.
