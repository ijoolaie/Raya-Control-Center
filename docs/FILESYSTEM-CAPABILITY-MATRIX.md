# Restore filesystem capability matrix

Status date: 2026-11-14

This matrix records experimental evidence and production gaps for the Phase 6 Restore workstream. It is not an enablement approval. **No platform/filesystem profile is eligible for Automatic Restore.** The production JavaScript Inspector remains read-only and operator-led.

| Capability / requirement | Linux WSL2, ext4 (experimental probe) | Windows 11 Pro build 26300, NTFS (experimental native prototype) | Production Node Restore path |
|---|---|---|---|
| Retained parent namespace anchor | PASS: dirfd-relative operations | PASS: retained directory HANDLE in prototype | NOT IMPLEMENTED as native handle context |
| Handle-derived file identity | PASS: `fstat(st_dev, st_ino)` | PASS: `FileIdInfo` / volume identity in prototype | NO: pathname/lstat observations only |
| No-follow child open | PASS: `openat(O_NOFOLLOW)` | EXPERIMENTAL PASS: `NtCreateFile`, `RootDirectory`, open-reparse-point | PARTIAL pathname checks; no native handle guarantee |
| Parent path substitution resistance | PASS in retained-dirfd probe | PASS in retained-HANDLE prototype | NO native namespace anchor |
| No-replace publication | PASS: Linux `renameat2(RENAME_NOREPLACE)` | EXPERIMENTAL PASS: `NtSetInformationFile`, FileRenameInformationEx class 65 | Uses path-based hard-link publication; not native adapter contract |
| Identity-bound unlink | Not accepted as production adapter behavior | EXPERIMENTAL PASS: handle identity check + disposition | Path-based cleanup only |
| Parent-directory durability primitive | `fsync(dirfd)` exercised; not power-loss proof | Directory `FlushFileBuffers` observed to succeed on this host, but no stable documented contract accepted; Node helper reports unsupported | POSIX helper attempts fsync; Windows reports unsupported and callers currently ignore it |
| Exclusion of arbitrary external writers / pre-existing writable handles | NO: advisory locks do not prove this | NO: share modes cannot revoke pre-existing permissive handles; mapped/privileged writers not excluded | NO |
| Snapshot-consistent content reads under concurrent writes | NOT ESTABLISHED | NO: same-size concurrent/mapped writes not excluded | NO |
| Crash / power-loss durability | Process-level tests only; no power-loss or storage-cache proof | Process termination tests only; no power-loss, controller-cache, or filesystem-crash proof | No cross-platform proof |
| Production integration | NO | NO | Existing path-based implementation only |

## Evidence scope

### Linux WSL2 / ext4

The Linux dirfd probe passed 12 assertions in each of 10 consecutive runs (120 assertions total). It exercised retained directory descriptors, descriptor-relative open/unlink, `O_NOFOLLOW`, handle-derived `(st_dev, st_ino)` identity, path substitution, `openat2` resolution constraints, `renameat2(RENAME_NOREPLACE)`, collision preservation, and parent-directory `fsync`.

This is a Python/ctypes syscall feasibility probe on one WSL2 Linux kernel and ext4 virtual disk. It is not a production adapter, does not establish arbitrary external-writer exclusion, and is not power-loss evidence. It does not cover hostile mount/bind-mount or namespace scenarios, full recursive traversal, metadata policy, SQLite WAL/SHM lifecycle, or full Restore transitions.

### Windows 11 Pro / NTFS

The experimental C++ prototype passed three consecutive full runs in the latest verification. It exercises retained directory handles, handle-derived FileIdInfo, relative child opens, no-replace publication through the experimental native API, identity-bound unlink, bounded enumeration and malformed-record rejection, multi-process publication, namespace churn, and four process-termination boundaries.

The Win32 `SetFileInformationByHandle(FileRenameInfoEx)` relative-RootDirectory probe failed with `ERROR_INVALID_PARAMETER` on this host; no path-based fallback was accepted. The alternative `NtSetInformationFile` call is experimental and does not establish a stable supported user-mode application API contract. Directory-handle `FlushFileBuffers` succeeded in local probes, but this is not treated as a documented cross-version/filesystem durability guarantee. Node's production `syncDirectory` remains unsupported on Windows.

### Other profiles

Other Windows versions, non-NTFS filesystems, SMB/network shares, cloud-synced folders, removable media, other Linux distributions/filesystems, macOS, and other POSIX systems are untested and remain unsupported/unknown for Automatic Restore.

## Enablement decision

- Automatic Restore remains disabled on every profile.
- The Inspector remains read-only; recovery remains operator-led.
- No profile may be marked eligible until the native adapter is integrated, its external-mutation threat boundary is explicitly accepted, no-follow and identity guarantees are validated, no-replace and durability semantics are supported, all crash transitions are tested, and independent security review is complete.
- A successful local probe is feasibility evidence only; it does not override any missing capability above.
