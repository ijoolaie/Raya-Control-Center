# POSIX Experimental dirfd Probe

Date: 2026-11-13

## Purpose

This is an isolated Linux feasibility experiment for selected primitives in the Native Filesystem Adapter Contract. It is not production code, is not imported by the application, and is never called by Backup or Restore. It creates all test data under a fresh Python TemporaryDirectory and does not open project databases.

Run from Windows/WSL2:

```powershell
wsl.exe -d Ubuntu --exec /usr/bin/env TMPDIR=/home/thelord /usr/bin/python3 /mnt/d/Work/project/Raya-Control-Center/experiments/posix-fd-adapter-probe.py
```

The probe uses TMPDIR=/home/thelord, which is on the WSL2 distro's virtual-disk-backed ext4 filesystem, not /mnt/d (a Windows-mounted filesystem) and not /tmp (tmpfs).

## Covered primitives

The current Linux/WSL2 host passed 12 assertions:

1. Create a file relative to a retained directory descriptor; fsync file and parent.
2. Reopen with openat semantics and O_NOFOLLOW; compare (st_dev, st_ino) from fstat.
3. Reject a symlink entry with O_NOFOLLOW.
4. Rename the directory pathname, create a decoy directory at the old pathname, and prove operations through the retained directory descriptor still target the original directory object.
5. Publish with Linux renameat2(RENAME_NOREPLACE) and fsync the retained parent.
6. Prove a pre-existing destination is not overwritten and the source remains present on EEXIST.
7. Resolve a multi-component path using `openat2` with `RESOLVE_BENEATH`, `RESOLVE_NO_SYMLINKS`, and `RESOLVE_NO_MAGICLINKS`.
8. Reject `..` traversal outside the retained directory anchor.
9. Reject a symlink that would escape the retained directory anchor.
10. Replace a pathname after opening the original file; compare the retained descriptor identity with the replacement entry and prove the descriptor still addresses the original object.
11. Keep a writable descriptor open, unlink its directory entry, then write and fsync through the descriptor; the inode remains mutable with link count zero.
12. Unlink relative to the retained directory descriptor and fsync the parent.

Host: WSL2 kernel 6.18.33.2-microsoft-standard-WSL2, Python 3.14.4, distro root on a virtual-disk-backed ext4 filesystem (`df -T` reports ext4; `statfs` reports ext2/ext3 magic). Result on 2026-11-13: **PASS, 12 assertions in each of 10 consecutive runs (120 assertions total)**. The `openat2` checks also establish that this kernel/libc exposes the required beneath/no-symlink resolution flags; a production adapter must report unsupported and fail closed on kernels/filesystems where the required semantics are unavailable. This exercises ordinary ext4 namespace and fsync calls, but it is not a power-loss, host-crash, controller-cache, or physical-storage durability test.

## Evidence boundary and remaining work

This is a Python/ctypes syscall probe, not a native adapter implementation. It does not establish:

- Power-loss or storage-controller durability, filesystem journal behavior, or fsync guarantees under faults.
- Exclusion of arbitrary external writers or privileged actors. The probe explicitly demonstrates the opposite for an already-open writable descriptor: unlinking its pathname does not revoke write access to the inode.
- Safe traversal through hostile mount points, bind mounts, namespaces, or filesystem-specific edge cases.
- Complete descriptor-relative recursive traversal, ownership validation, hard-link policy, metadata preservation, or SQLite WAL/SHM coordination.
- Windows behavior, cross-platform ABI behavior, crash-safe Restore transitions, or production integration.
- Correct classification of syscall completion when a later close or result-delivery step fails.

The retained-dirfd experiment demonstrates namespace anchoring for this specific operation sequence. It is not a security boundary against an actor with sufficient privileges or access to the retained directory object.

## Decision

The experiment supports continuing a Linux native-adapter prototype, subject to review and broader adversarial tests. It does **not** qualify any platform/filesystem profile for Automatic Restore. Automatic Restore remains disabled; recovery remains operator-led/read-only; Phase 5 remains deferred.

A production implementation still needs a reviewed native module, exact filesystem support matrix, explicit external-writer threat boundary, deterministic transition failpoints, fresh-process crash verification, and separate durability/security acceptance.