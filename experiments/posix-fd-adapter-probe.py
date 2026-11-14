#!/usr/bin/env python3
"""Non-production POSIX dirfd/no-follow/no-replace feasibility probe.

Runs only inside a fresh TemporaryDirectory. It never opens project databases.
Linux-specific: requires libc renameat2(RENAME_NOREPLACE).
"""
from __future__ import annotations

import ctypes
import errno
import os
import platform
import stat
import tempfile
from pathlib import Path

O_CLOEXEC = getattr(os, "O_CLOEXEC", 0)
O_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
O_DIRECTORY = getattr(os, "O_DIRECTORY", 0)
RENAME_NOREPLACE = 1


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def main() -> None:
    require(platform.system() == "Linux", "Linux-only probe")
    require(O_NOFOLLOW and O_DIRECTORY, "required open flags unavailable")
    libc = ctypes.CDLL(None, use_errno=True)
    renameat2 = getattr(libc, "renameat2", None)
    require(renameat2 is not None, "libc renameat2 unavailable")
    renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int,
                          ctypes.c_char_p, ctypes.c_uint]
    renameat2.restype = ctypes.c_int

    assertions = 0
    with tempfile.TemporaryDirectory(prefix="raya-posix-adapter-") as temp:
        root = Path(temp)
        parent = root / "parent"
        parent.mkdir()
        parent_fd = os.open(parent, os.O_RDONLY | O_DIRECTORY | O_CLOEXEC)
        try:
            # 1. Create and flush an owned source entry relative to a retained dirfd.
            source_fd = os.open("source.bin", os.O_WRONLY | os.O_CREAT |
                                os.O_EXCL | O_NOFOLLOW | O_CLOEXEC,
                                0o600, dir_fd=parent_fd)
            os.write(source_fd, b"raya-posix-probe\n")
            os.fsync(source_fd)
            source_stat = os.fstat(source_fd)
            os.close(source_fd)
            os.fsync(parent_fd)
            assertions += 1

            # 2. Reopen without following symlinks; compare handle-derived identity.
            read_fd = os.open("source.bin", os.O_RDONLY | O_NOFOLLOW |
                              O_CLOEXEC, dir_fd=parent_fd)
            opened_stat = os.fstat(read_fd)
            require((opened_stat.st_dev, opened_stat.st_ino) ==
                    (source_stat.st_dev, source_stat.st_ino),
                    "reopened entry identity differs")
            require(stat.S_ISREG(opened_stat.st_mode), "source is not regular")
            require(os.read(read_fd, 128) == b"raya-posix-probe\n",
                    "source bytes mismatch")
            os.close(read_fd)
            assertions += 1

            # 3. A symlink entry must not be followed by openat(O_NOFOLLOW).
            os.symlink("source.bin", "link.bin", dir_fd=parent_fd)
            try:
                os.open("link.bin", os.O_RDONLY | O_NOFOLLOW | O_CLOEXEC,
                        dir_fd=parent_fd)
                raise AssertionError("O_NOFOLLOW unexpectedly followed symlink")
            except OSError as exc:
                require(exc.errno == errno.ELOOP, f"unexpected symlink error: {exc}")
            assertions += 1

            # 4. Retained directory descriptor remains bound after pathname swap.
            moved = root / "parent-original"
            os.rename(parent, moved)
            parent.mkdir()
            decoy_parent_fd = os.open(parent, os.O_RDONLY | O_DIRECTORY | O_CLOEXEC)
            try:
                decoy = os.open("decoy.bin", os.O_WRONLY | os.O_CREAT |
                                os.O_EXCL, 0o600, dir_fd=decoy_parent_fd)
                os.write(decoy, b"decoy")
                os.close(decoy)
            finally:
                os.close(decoy_parent_fd)
            anchored_fd = os.open("anchored.bin", os.O_WRONLY | os.O_CREAT |
                                  os.O_EXCL | O_NOFOLLOW, 0o600,
                                  dir_fd=parent_fd)
            os.write(anchored_fd, b"anchored")
            os.fsync(anchored_fd)
            os.close(anchored_fd)
            require((moved / "anchored.bin").read_bytes() == b"anchored",
                    "retained dirfd did not address original directory")
            require(not (parent / "anchored.bin").exists(),
                    "operation escaped retained directory anchor")
            assertions += 1

            # 5. Atomic no-replace publication; existing target remains unchanged.
            def rename_noreplace(old: bytes, new: bytes) -> None:
                rc = renameat2(parent_fd, old, parent_fd, new, RENAME_NOREPLACE)
                if rc != 0:
                    err = ctypes.get_errno()
                    raise OSError(err, os.strerror(err), new.decode())

            rename_noreplace(b"source.bin", b"published.bin")
            os.fsync(parent_fd)
            require((moved / "published.bin").read_bytes() == b"raya-posix-probe\n",
                    "published bytes mismatch")
            assertions += 1

            collision = os.open("occupied.bin", os.O_WRONLY | os.O_CREAT |
                                os.O_EXCL, 0o600, dir_fd=parent_fd)
            os.write(collision, b"keep")
            os.close(collision)
            try:
                rename_noreplace(b"published.bin", b"occupied.bin")
                raise AssertionError("RENAME_NOREPLACE overwrote destination")
            except OSError as exc:
                require(exc.errno == errno.EEXIST,
                        f"unexpected no-replace collision error: {exc}")
            require((moved / "occupied.bin").read_bytes() == b"keep",
                    "collision changed existing destination")
            require((moved / "published.bin").exists(),
                    "collision consumed source entry")
            assertions += 1

            # 6. A retained entry handle detects pathname replacement after open.
            identity_fd = os.open("identity.bin", os.O_RDWR | os.O_CREAT |
                                  os.O_EXCL | O_NOFOLLOW, 0o600,
                                  dir_fd=parent_fd)
            os.write(identity_fd, b"original-object")
            original_identity = os.fstat(identity_fd)
            os.rename("identity.bin", "identity-held.bin", src_dir_fd=parent_fd,
                      dst_dir_fd=parent_fd)
            replacement_fd = os.open("identity.bin", os.O_WRONLY | os.O_CREAT |
                                     os.O_EXCL | O_NOFOLLOW, 0o600,
                                     dir_fd=parent_fd)
            os.write(replacement_fd, b"replacement-object")
            replacement_identity = os.fstat(replacement_fd)
            os.close(replacement_fd)
            current_name_identity = os.stat("identity.bin", dir_fd=parent_fd,
                                            follow_symlinks=False)
            require((original_identity.st_dev, original_identity.st_ino) !=
                    (current_name_identity.st_dev, current_name_identity.st_ino),
                    "pathname replacement did not change entry identity")
            require(os.pread(identity_fd, 64, 0) == b"original-object",
                    "retained handle no longer refers to original object")
            require((replacement_identity.st_dev, replacement_identity.st_ino) ==
                    (current_name_identity.st_dev, current_name_identity.st_ino),
                    "replacement handle and current name identity differ")
            os.close(identity_fd)
            assertions += 1

            # 7. An already-open writer survives unlink and can still mutate its inode.
            writer_fd = os.open("preexisting-writer.bin", os.O_RDWR | os.O_CREAT |
                                os.O_EXCL | O_NOFOLLOW, 0o600,
                                dir_fd=parent_fd)
            os.write(writer_fd, b"before")
            writer_identity = os.fstat(writer_fd)
            os.unlink("preexisting-writer.bin", dir_fd=parent_fd)
            os.pwrite(writer_fd, b"after!", 0)
            os.fsync(writer_fd)
            require(os.fstat(writer_fd).st_nlink == 0,
                    "unlinked writer inode unexpectedly retained a directory link")
            require(os.pread(writer_fd, 64, 0) == b"after!",
                    "pre-existing writable descriptor could not mutate unlinked inode")
            require(writer_identity.st_ino == os.fstat(writer_fd).st_ino,
                    "writer descriptor identity changed")
            os.close(writer_fd)
            assertions += 1

            # 8. openat2 constrains multi-component resolution beneath the anchor.
            class OpenHow(ctypes.Structure):
                _fields_ = [("flags", ctypes.c_uint64),
                            ("mode", ctypes.c_uint64),
                            ("resolve", ctypes.c_uint64)]

            openat2 = getattr(libc, "openat2", None)
            require(openat2 is not None, "libc openat2 unavailable")
            openat2.argtypes = [ctypes.c_int, ctypes.c_char_p,
                                ctypes.POINTER(OpenHow), ctypes.c_size_t]
            openat2.restype = ctypes.c_int
            RESOLVE_NO_MAGICLINKS = 0x02
            RESOLVE_NO_SYMLINKS = 0x04
            RESOLVE_BENEATH = 0x08

            os.mkdir("nested", dir_fd=parent_fd)
            nested_fd = os.open("nested", os.O_RDONLY | O_DIRECTORY |
                                O_CLOEXEC, dir_fd=parent_fd)
            try:
                payload = os.open("payload.bin", os.O_WRONLY | os.O_CREAT |
                                  os.O_EXCL | O_NOFOLLOW, 0o600,
                                  dir_fd=nested_fd)
                os.write(payload, b"beneath")
                os.close(payload)
                os.symlink("/etc/passwd", "escape", dir_fd=nested_fd)
            finally:
                os.close(nested_fd)

            how = OpenHow(os.O_RDONLY | O_CLOEXEC, 0,
                          RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS |
                          RESOLVE_NO_MAGICLINKS)

            def open_beneath(path_bytes: bytes) -> int:
                fd = openat2(parent_fd, path_bytes, ctypes.byref(how),
                             ctypes.sizeof(how))
                if fd < 0:
                    err = ctypes.get_errno()
                    raise OSError(err, os.strerror(err), path_bytes.decode())
                return fd

            safe_fd = open_beneath(b"nested/payload.bin")
            try:
                require(os.read(safe_fd, 64) == b"beneath",
                        "openat2 safe beneath read mismatch")
            finally:
                os.close(safe_fd)
            assertions += 1

            try:
                open_beneath(b"../outside.bin")
                raise AssertionError("openat2 accepted parent traversal")
            except OSError as exc:
                require(exc.errno == errno.EXDEV,
                        f"unexpected beneath traversal error: {exc}")
            assertions += 1

            try:
                open_beneath(b"nested/escape")
                raise AssertionError("openat2 followed a symlink")
            except OSError as exc:
                require(exc.errno == errno.ELOOP,
                        f"unexpected no-symlink error: {exc}")
            assertions += 1

            # 7. Owned unlink relative to retained parent and parent fsync.
            os.unlink("published.bin", dir_fd=parent_fd)
            os.fsync(parent_fd)
            require(not (moved / "published.bin").exists(),
                    "unlinkat did not remove anchored entry")
            assertions += 1
        finally:
            os.close(parent_fd)

    print(f"PASS: {assertions} assertions; Linux dirfd/no-follow/identity/"
          "no-replace/parent-fsync probe")
    print("LIMIT: process-level probe only; not power-loss, privileged-writer, "
          "mount/reparse, full adapter, or Restore acceptance")


if __name__ == "__main__":
    main()
