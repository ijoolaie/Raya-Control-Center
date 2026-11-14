# Windows Native Handle Feasibility Probe

Date: 2026-11-13

## Purpose

This isolated MSVC-built C++ probe exercises selected Win32 file-handle primitives relevant to the Native Filesystem Adapter Contract. It is experimental evidence only: it is not linked into Raya Control Center, is not used by Backup/Restore, and does not qualify a Windows filesystem for Automatic Restore.

Run from the repository root in PowerShell:

```powershell
.\scripts\windows-handle-adapter-probe.ps1 -Runs 10
```

The script compiles with the installed Visual Studio Build Tools x64 compiler, runs from a unique executable in the system temporary directory, and removes its executable/object outputs in a `finally` block. The C++ probe creates a unique temporary test directory and removes its test entries. It never opens project databases.

## Covered primitives

The local Windows 11 Pro build 26300 / NTFS host passed 14 assertions per run, repeated for 10 runs (140 assertions total):

1. Create an isolated file.
2. Write known bytes to the opened file.
3. Flush the opened file handle with `FlushFileBuffers`.
4. Obtain volume serial and 128-bit file identity through `GetFileInformationByHandleEx(FileIdInfo)`.
5. Rename the original pathname while retaining its handle.
6. Create a new file at the old pathname.
7. Obtain the replacement handle's FileId.
8. Prove the replacement pathname has a different identity from the retained original handle.
9. Prove the retained handle continues to identify the original file object after pathname replacement.
10. Write through the retained writable handle after rename and pathname replacement.
11. Reopen the renamed entry and verify it exposes the mutation made through the retained handle.
12. Create source and existing destination entries for publication collision testing.
13. Use `MoveFileExW` without `MOVEFILE_REPLACE_EXISTING` and require an existing destination to reject publication.
14. Verify the existing destination bytes remain unchanged after the collision.

The retained-writer checks demonstrate that renaming an entry and replacing its former pathname do not revoke a writable handle already opened to the original object. A restrictive future guard must therefore be acquired before the critical operation; a later pathname check cannot revoke pre-existing handles.

Separately, the probe opened the parent directory with `FILE_FLAG_BACKUP_SEMANTICS` and called `FlushFileBuffers`; this returned success on the tested host. Directory flush is reported as a capability observation, not counted as one of the 14 assertions.

The native source is `experiments/windows-handle-adapter-probe.cpp`; the reproducible build/run wrapper is `scripts/windows-handle-adapter-probe.ps1`.

## Evidence boundary and remaining work

The result proves only that these calls succeeded on this one Windows/NTFS host. In particular:

- Successful directory `FlushFileBuffers` is a useful host-specific capability observation, not proof of power-loss durability, storage-controller behavior, remote filesystem semantics, or every Windows filesystem/driver.
- `MoveFileExW` no-replace behavior here is a path-based publication check. It does not prove atomic publication relative to a retained parent handle or protection from hostile namespace races.
- `FileIdInfo` was read from open handles and distinguishes the tested original and replacement objects. The probe does not prove stable identity across reboot, volume remount, filesystem repair, or every filesystem.
- No reparse-point traversal, relative-to-directory-handle open, hostile parent replacement race, hard-link policy, access-control boundary, mapped I/O, privileged actor, remote redirector, or alternate filesystem was tested.
- Existing permissive handles and already-open writers are not revoked by later path checks. Share-mode coordination remains a separate capability and does not exclude every writer or privileged actor.
- No SQLite WAL/SHM coordination, Restore transition, crash injection, or native adapter integration was tested.

The existing `scripts/windows-share-mode-probe.ps1` remains separate evidence for share-mode ordering; the SQLite VFS probe remains separate evidence for the tested Node/SQLite runtime. None of these probes substitutes for handle-relative namespace operations and full Restore acceptance.

## Decision

The local toolchain is sufficient to compile and run focused Windows native experiments using MSVC 19.51.36248 and Windows SDK 10.0.28000.0. This removes the earlier assumption that no C/C++ compiler is available on the Windows host, but it does not provide a Linux compiler in WSL2 and does not itself supply Node addon headers or a production integration mechanism.

Proceed with a separately reviewed Windows adapter prototype only after its handle-relative namespace strategy is selected and tested. Do not treat the path-based primitives in this probe as a complete adapter. Automatic Restore remains disabled; Recovery Inspector remains read-only/operator-led; Phase 5 remains deferred.
