# Restore crash recovery runbook

## Scope

Use this procedure only when a Restore process terminated unexpectedly and the normal live database path is missing or a `.pre-restore-<uuid>` file remains. The application does **not** automatically recover these files. This is intentional: a lock file alone cannot prove that its owner is dead, and selecting one of several rollback files automatically could overwrite valid data.

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

Keep every `.pre-restore-*` file. Each may be the only surviving copy of the pre-restore database. Do not delete or rename candidates until one has been selected and verified.

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

## 3. Recover when the live database path is absent

Choose one exact `.pre-restore-<uuid>` file from the listing. First verify that it opens as a valid Control Center database and has the expected schema/integrity. The supported restore command validates the candidate again before installing it:

```powershell
$Rollback = 'D:\absolute\path\control-center.sqlite.pre-restore-<uuid>'
$env:RAYA_CC_DATABASE = $Database
npm run db:restore -- $Rollback
```

Because the destination is absent, Restore installs the selected rollback database without replacing another live database. If the command reports a lock, path, or validation error, stop and preserve the files; do not work around the error by deleting additional files.

## 4. If a live database already exists

Do not restore over it as part of crash cleanup. The presence of a live database may mean the new snapshot was installed successfully before the crash. Preserve both the live database and every `.pre-restore-*` file. Inspect and compare them using copies in a separate recovery directory, and make a deliberate operator decision before any further restore.

## 5. Orphaned temporary files

A `.restore` temporary file is not a substitute for a rollback database. Leave it in place until the live database has been recovered, validated, and backed up. Only then may an operator remove a specifically identified orphaned `.restore` file after confirming no maintenance process is active.

## Safety properties and limitations

- The application deliberately refuses to guess whether a lock is stale or which rollback file is authoritative.
- Recovery requires a verified stopped server and explicit operator selection of the rollback file.
- The normal `db:restore` path revalidates the selected snapshot and uses the existing runtime and maintenance locks.
- This runbook is a manual recovery path, not automatic crash recovery. Automatic recovery remains deferred until a durable restore journal and crash-state protocol can be designed and tested across Windows filesystem semantics.
- Keep the original rollback file until a fresh backup has been created and verified.
