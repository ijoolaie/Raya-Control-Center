# Windows Native Handle Adapter Prototype

Status: Phase 6 experimental prototype only. Not integrated into Backup/Restore and not eligible for automatic recovery.

## Implemented slice

Source: `experiments/windows-native-handle-adapter.cpp`.

The prototype currently demonstrates:

- opening a trusted directory handle with `FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT`;
- rejecting a root handle whose attributes indicate a reparse point or non-directory;
- opening a single child relative to the retained directory handle using `NtCreateFile` with `OBJECT_ATTRIBUTES.RootDirectory`, `FILE_OPEN_REPARSE_POINT`, and `FILE_NON_DIRECTORY_FILE`;
- rejecting child reparse points and directories;
- obtaining volume serial and 128-bit file identifier from the opened handle using `GetFileInformationByHandleEx(FileIdInfo)`;
- rechecking the retained root handle identity before returning the child handle;
- experimental `publishNoReplace` and `unlinkOwned` methods, described below;
- opaque ownership of the root handle within a small RAII context.

The child name is deliberately restricted to one path component. Empty names, dot components, separators, and colon are rejected.

## Local build and execution evidence

Host: Windows 11 Pro build 26300, NTFS, MSVC x64 toolset 14.51.36231.

Build flags: `/W4 /WX /EHsc /std:c++17`.

The original root-open/relative-child-open/parent-identity probe passed 3 checks in each of 10 consecutive runs (30 successful checks total).

The follow-on publication experiment compiled successfully, but runtime publication **did not pass**. Both legacy `FileRenameInfo` and extended `FileRenameInfoEx` return `ERROR_INVALID_PARAMETER (87)` when `RootDirectory` is supplied for a relative destination name. The buffer allocation was corrected to retain the complete fixed `FILE_RENAME_INFO` structure (including x64 tail padding) plus the variable filename; the failure persisted after that correction.

An isolated API matrix in `experiments/windows-rename-api-matrix.cpp` compared legacy/extended classes with relative and absolute destination names. Across five consecutive runs, both absolute-path variants succeeded, while both relative-`RootDirectory` variants failed with error 87. The matrix was also repeated with different directory-handle access masks and with the source in a separate staging subdirectory; the relative variants still failed. This narrows the issue to the relative-root-directory route on this host, but does not establish the underlying cause. Absolute-path success is diagnostic only and is not an approved fallback because it does not preserve the retained-parent namespace guarantee. The collision case in the original prototype left the existing target untouched, but this does not validate successful no-replace publication. No path-based fallback was added.

A follow-up native-system-call experiment in experiments/windows-nt-rename-api-probe.cpp, driven by scripts/windows-nt-rename-api-probe.ps1, dynamically resolves NtSetInformationFile from ntdll.dll and tests information classes 10 (FileRenameInformation) and 65 (FileRenameInformationEx). Unlike the Win32 wrapper matrix above, both classes successfully rename from a staging subdirectory into the retained root directory using a relative destination name and RootDirectory handle. Ten consecutive runs passed all four positive cases (legacy/extended, relative/absolute), with NTSTATUS=0x00000000 for each operation (40 successful operations). The probe also exercised no-replace collisions for both classes in all 10 runs: both returned STATUS_OBJECT_NAME_COLLISION (0xC0000035), the source entry remained present, and the pre-existing destination bytes remained unchanged (20 successful collision checks). Total: 60 successful assertions across 10 runs. This is strong local NTFS feasibility evidence for the direct NT call and the two no-replace forms, but it is not adversarial concurrency or cross-filesystem proof. The experiment uses unique temporary files only and makes no absolute-path fallback part of the adapter.

A separate race probe, experiments/windows-nt-rename-race-probe.cpp, races FileRenameInformationEx no-replace publication against a competing CREATE_NEW of the same destination. Across five initial runs (100 races each), all 500 races produced exactly one valid winner: either the rename installed the source bytes and the competing create lost, or the competing create installed its marker and rename returned STATUS_OBJECT_NAME_COLLISION while preserving the marker and source. The probe also renamed the retained parent directory, recreated a decoy at its former pathname, then published relative to the retained handle; in all five runs the new entry appeared in the moved original directory and not in the decoy. A further two-run cleanup verification passed another 200 races and two parent-path-swap checks; a subsequent three-run extension added 300 races and three combined parent/source-path replacement checks. Aggregate evidence: 1,000 concurrent no-replace races, 10 retained-parent path-swap checks, and three additional source-path substitution checks, all passing on this one NTFS host. In each of the three source-path substitution checks, the opened source entry was moved away from its original name, a decoy file was created at that original name, and the rename by the retained source handle moved the original bytes to the destination while leaving the decoy untouched. This does not cover hostile kernel/privileged actors, remote filesystems, or cross-volume moves.

A separate isolated probe, `experiments/windows-unlink-handle-probe.cpp`, independently tested identity-guarded handle disposition. On the same host, 10 consecutive runs passed setup, handle identity retrieval, refusal when the expected identity was deliberately wrong, deletion by the verified handle, and pathname-absence checks (50 successful assertions total). This is a narrow local NTFS result, not a race-proof or cross-filesystem guarantee.

The executable creates files only in a unique temporary directory under the host temp directory. It does not open the operational database.

## Compatibility and API contract review (2026-11-13)

Microsoft documentation review confirms the following structural facts:

- `FileRenameInformation` is information class 10; `FileRenameInformationEx` is class 65. Microsoft lists class 65 as available starting with Windows 10, version 1709. The Windows 11 build 26300 host used by the probes is newer than that documented floor.
- `FILE_RENAME_INFORMATION` defines a union whose first field is `BOOLEAN ReplaceIfExists` for class 10 and `ULONG Flags` for class 65. For class 65, zero flags do not request replacement; the documented `FILE_RENAME_REPLACE_IF_EXISTS` bit is 0x1.
- The same structure documents `RootDirectory` as a handle to the destination directory and a relative simple filename as the destination name. Microsoft also states that rename is within one volume and requires DELETE access to the source plus appropriate destination-directory access.
- Microsoft documents `NtSetInformationFile` with an input buffer, information-class value, and an `IO_STATUS_BLOCK` that receives final completion status. Its page notes that user-mode callers use the Nt-prefixed name rather than Zw-prefixed name.

Important compatibility boundary: the Microsoft `NtSetInformationFile` reference is a Windows driver DDI page, not a promise that dynamically resolving and calling the native export from an ordinary user-mode application is a supported, stable Win32 contract. The user-mode note clarifies naming, but does not establish an application compatibility guarantee for this adapter strategy. Dynamic export availability, ABI details, filesystem implementation behavior, servicing compatibility, and support policy remain unresolved. The public Win32 `SetFileInformationByHandle` route remains the preferred supported-API candidate, but its relative-root path failed with error 87 in the current prototype; no absolute-path fallback is allowed.

The local SDK inspection found Windows SDK 10.0.28000.0 and `winternl.h`, but no local WDK `ntifs.h`; therefore this host did not provide an independent WDK-header compile-time validation of the class/structure definitions. The prototype uses a locally declared layout and numeric class value, which is experimental and must not be mistaken for SDK-validated production ABI.

Required next gate before any production use:
1. Obtain and build against the applicable official WDK declarations, with compile-time `sizeof`/`offsetof` assertions for x64 and any supported architecture.
2. Decide whether this native user-mode call is an acceptable supported dependency at all; if not, replace it with a supported documented API or keep Windows automatic recovery ineligible.
3. Define a Windows-version and filesystem support matrix, then probe each declared combination, including unsupported-class behavior and error mapping.
4. Preserve both syscall return status and `IO_STATUS_BLOCK.Status` in diagnostics; never collapse an uncertain or possibly-completed operation into a generic failure.
5. Validate same-volume identity before rename and test access/share semantics under SQLite WAL/SHM and real concurrent actors.

Sources reviewed: Microsoft Learn, `NtSetInformationFile`; `FILE_RENAME_INFORMATION`; and `FILE_INFORMATION_CLASS`. This review narrows the compatibility questions but does not close them.

## Windows SDK ABI probe (2026-11-13)

Added `experiments/windows-rename-abi-sdk-probe.cpp` and `scripts/windows-rename-abi-sdk-probe.ps1`. The probe compiles against the installed Windows SDK 10.0.28000.0 public `WinBase.h` and `winternl.h` declarations, with compile-time assertions comparing the prototype's rename buffer to SDK `FILE_RENAME_INFO`, and checking `IO_STATUS_BLOCK` layout and documented rename flag constants.

Local result on Windows 11 Pro build 26300 / MSVC x64:

- `sizeof(FILE_RENAME_INFO)=24`; prototype structure size = 24.
- `RootDirectory` offset = 8; `FileNameLength` offset = 16; `FileName` offset = 20.
- `sizeof(IO_STATUS_BLOCK)=16`; `Information` offset = 8.
- SDK flags: `FILE_RENAME_FLAG_REPLACE_IF_EXISTS=0x1`; `FILE_RENAME_FLAG_POSIX_SEMANTICS=0x2`.
- All compile-time assertions passed and the probe exited successfully.

This validates the x64 buffer layout against the installed public Windows SDK declarations. It does not validate the native syscall's user-mode support contract, the numeric information-class value 65 through an SDK enum (the SDK's public `FILE_INFORMATION_CLASS` enum is intentionally sparse), other architectures, or filesystem behavior. No WDK `ntifs.h` was present, so this is not a WDK-header validation. The ABI probe is diagnostic only and does not call the native rename API.

Important remaining instrumentation issue: the earlier `renameNt` experimental helper returns `IO_STATUS_BLOCK.Status` when the immediate call satisfies `NT_SUCCESS`, and otherwise returns the immediate status. That helper therefore does not preserve both raw values for later classification. Production code must retain both independently and correctly handle pending/completion semantics; do not copy this helper's status handling into production.

## Proposed NTSTATUS classification (design only; not implemented)

The installed Windows SDK 10.0.28000.0 `shared/ntstatus.h` was inspected for symbolic names and numeric values. This is a mapping input, not a guarantee that every filesystem returns only these statuses.

| NTSTATUS | Value | Conservative adapter treatment |
|---|---:|---|
| `STATUS_SUCCESS` | `0x00000000` | Candidate success only after checking the completion status and postconditions. |
| `STATUS_OBJECT_NAME_COLLISION` | `0xC0000035` | Conflict; do not overwrite or retry blindly. Reinspect source and destination handles/names. |
| `STATUS_OBJECT_NAME_NOT_FOUND` / `STATUS_OBJECT_PATH_NOT_FOUND` | `0xC0000034` / `0xC000003A` | Conflict or invalid context; revalidate retained parent and source identity. |
| `STATUS_NOT_SAME_DEVICE` | `0xC00000D4` | Unsupported operation/profile; never fall back to copy-and-delete as if rename were atomic. |
| `STATUS_NOT_SUPPORTED` | `0xC00000BB` | Unsupported capability for this filesystem/operation; keep profile ineligible. |
| `STATUS_INVALID_PARAMETER` | `0xC000000D` | Invalid adapter request/ABI or unsupported parameter combination; fail closed and retain diagnostics. |
| `STATUS_ACCESS_DENIED` | `0xC0000022` | Policy/permission failure; no automatic privilege escalation or fallback. |
| `STATUS_SHARING_VIOLATION` | `0xC0000043` | External-handle conflict; no tight retry loop. Reinspect and return conflict. |
| `STATUS_DELETE_PENDING` / `STATUS_CANNOT_DELETE` | `0xC0000056` / `0xC0000121` | Conflict; preserve artifacts and require operator review if identity/state is ambiguous. |
| `STATUS_DISK_FULL` | `0xC000007F` | I/O failure; preserve evidence and inspect actual namespace before compensation. |
| `STATUS_MEDIA_WRITE_PROTECTED` | `0xC00000A2` | Unsupported/read-only profile or I/O failure; do not claim durability. |
| `STATUS_DEVICE_NOT_READY` / `STATUS_IO_TIMEOUT` | `0xC00000A3` / `0xC00000B5` | Potentially ambiguous I/O; classify as possibly-completed until handle and namespace postconditions are independently established. |
| `STATUS_PENDING` | `0x00000103` | Not success. Requires a correct completion/wait path; until implemented, return possibly-completed and retain the operation context. |
| `STATUS_CANCELLED` | `0xC0000120` | Cancellation does not prove no mutation; treat as possibly-completed and inspect before any recovery action. |
| `STATUS_INSUFFICIENT_RESOURCES` | `0xC000009A` | Resource failure; preserve evidence and inspect postconditions rather than assuming the operation had no effect. |

Implementation rules:
- Record the raw syscall return `NTSTATUS`, `IO_STATUS_BLOCK.Status`, `IO_STATUS_BLOCK.Information`, operation name, expected source/destination identities, and whether completion was observed.
- Do not treat `NT_SUCCESS(status)` alone as a complete application-level success signal; reconcile it with the completion block and handle-derived postconditions.
- Do not map every non-success status to a definite no-op. Only return `not-performed` when the adapter can prove no namespace mutation occurred; otherwise return `possibly-completed`.
- Never retry `possibly-completed` rename/delete, never run compensating cleanup based only on the status code, and never discard the retained context/evidence before inspection.
- This table is a conservative design proposal, not production code or a complete NTSTATUS catalogue. Every claimed filesystem profile needs observed status tests and an explicit mapping review.

## Important limitations

This is a proof-of-concept slice, not the complete adapter contract:

- `NtCreateFile` and `NtSetInformationFile` are NT native APIs obtained dynamically from ntdll; user-mode API/ABI compatibility, supported Windows build policy, and long-term stability need explicit review.
- The direct NtSetInformationFile rename route now passes local relative-root, no-replace collision, concurrent destination-creation race, and retained-parent path-swap probes on one NTFS host. It must not be treated as a supported production interface until compatibility, security, and filesystem behavior are reviewed. The Win32 wrapper relative RootDirectory failure remains documented; do not suppress or retry error 87 by falling back to path-based mutation.
- `unlinkOwned` passed an isolated positive/negative identity-mismatch probe on this host (10 runs), but has not passed adversarial pathname-replacement races, external-handle interaction, or cross-filesystem tests.
- The prototype does not implement stable volume/parent namespace policy, complete enumeration, stream/reparse-tag policy, hard-link policy, cancellation, or bounded error mapping.
- The isolated NT rename race probe is not the production adapter: the prototype has not yet integrated the rename route with retained-handle identity checks, cancellation, a complete context lifecycle, and structured possibly-completed errors. Directory-entry durability, close-uncertainty reporting, and crash failpoints remain unimplemented.
- Root reparse-point rejection is based on handle attributes after open; the final policy for volume mount points and all reparse tags remains to be specified and tested.
- The child share mode is permissive for this feasibility probe. It does not exclude pre-existing or later external writers.
- No SQLite WAL/SHM integration, full Restore, power-loss test, remote filesystem, privileged actor, or independent security review is covered.

## Gate decision

The prototype is useful evidence that a retained directory handle can be used as the root for a relative child open and that identity can be queried from the resulting handle on this host.

It does not yet satisfy the Native Filesystem Adapter Contract. The new direct-NT rename probe is a promising isolated capability, not an accepted adapter implementation; it must not be wired into production Restore. Automatic Restore remains disabled; Recovery Inspector remains read-only and operator-led; Phase 5 remains deferred.

## NTSTATUS and completion model experiment (2026-11-13)

Added `experiments/windows-ntstatus-completion-model.cpp` and `scripts/windows-ntstatus-completion-model.ps1`. This is a deterministic, injected-input state/classification model; it does not invoke `NtSetInformationFile`, issue real asynchronous I/O, wait on an event, or claim to model undocumented kernel scheduling behavior.

The record deliberately retains four independent facts: immediate syscall `NTSTATUS`, `IO_STATUS_BLOCK.Status`, `IO_STATUS_BLOCK.Information`, and whether completion was actually observed. The classifier fails closed:
- `STATUS_PENDING` is never success without an observed completion.
- A pending operation whose completion reports success is only a candidate success; production still must verify handle-derived and namespace postconditions.
- Cancellation, timeout, and unresolved pending states are `possibly-completed`, never retryable.
- Inconsistent syscall/IOSB combinations are `ambiguous`.
- A no-replace collision is a conflict.
- The one `not-performed` case is narrowly modeled as immediate `STATUS_ACCESS_DENIED` with an untouched, preinitialized IOSB and no completion. A real adapter must prove its call contract and IOSB initialization semantics before using this mapping.

Local result: MSVC x64 strict-warning build passed; the initial model had 11 assertions. The follow-up policy extension now passes 14 deterministic assertions, 0 failed. It explicitly checks that `ambiguous` and `possibly-completed` outcomes never authorize retry or automatic cleanup, and that a no-replace conflict never authorizes destructive cleanup. The policy helper currently authorizes no automatic mutation for any modeled classification. The executable and object were created under `%TEMP%` and removed in `finally`.

Evidence boundary: this validates only the pure classification logic and regression cases. It does not validate real syscall/IOSB timing, APC/event completion, cancellation races, IOSB lifetime, status mappings for other failures, native API support, or filesystem postconditions. It is not a production completion implementation. The existing `renameNt` helper remains unsuitable and unchanged. No production Restore code was modified; Automatic Restore remains disabled, Recovery Inspector remains read-only/operator-led, and Phase 5 remains deferred.

## Native NTSTATUS capture probe (2026-11-13)

Added \`experiments/windows-nt-rename-status-capture.cpp\` and \`scripts/windows-nt-rename-status-capture.ps1\`. Unlike the pure classifier above, this isolated experiment calls \`NtSetInformationFile\` with \`FileRenameInformationEx\` class 65 and records the immediate syscall return, \`IO_STATUS_BLOCK.Status\`, \`IO_STATUS_BLOCK.Information\`, and whether the preinitialized IOSB changed as separate values. It uses only unique temporary files/directories and does not open the operational database.

On Windows 11 Pro build 26300 / NTFS / MSVC x64, ten consecutive runs passed both cases (20 case executions):
- Successful relative no-replace rename: immediate status \`0x00000000\`, IOSB status \`0x00000000\`, IOSB changed, source pathname absent, destination contains the original bytes.
- Existing-destination collision: immediate status \`0xC0000035\` (\`STATUS_OBJECT_NAME_COLLISION\`), while IOSB status and Information remained at their \`0xCC\` sentinel values. Source remained present and destination bytes remained unchanged.

This is an important observed boundary: an immediate failure can return its useful status directly while leaving the supplied IOSB untouched. Do not require IOSB.Status to mirror the immediate status, and do not classify an untouched IOSB as a completion result. Production instrumentation must preserve the raw immediate status and IOSB bytes/initialized-state independently. The probe observed only synchronous completion on this host; it did not produce \`STATUS_PENDING\`, wait for an event/APC, test cancellation, or establish asynchronous completion semantics.

The result is narrow local NTFS evidence, not a supported user-mode API contract, complete adapter, durability proof, or cross-platform/filesystem guarantee. No production Restore code was modified. Automatic Restore remains disabled; Recovery Inspector remains read-only/operator-led; Phase 5 remains deferred.

## Async-handle rename probe (2026-11-13)

Added `experiments/windows-nt-rename-async-probe.cpp` and `scripts/windows-nt-rename-async-probe.ps1`. The probe creates and flushes a unique temporary source using a synchronous seed handle, then reopens it with `FILE_FLAG_OVERLAPPED` and invokes the experimental `NtSetInformationFile` class-65 relative no-replace rename. It records immediate status, IOSB status/information, IOSB mutation, whether `STATUS_PENDING` was returned, whether a wait was attempted, and whether completion was observed. The pending branch uses a bounded 10-second wait on the file handle; it does not claim that branch is validated merely because it compiles.

On Windows 11 Pro build 26300 / NTFS / MSVC x64, ten runs passed. All ten returned immediate `STATUS_SUCCESS`, IOSB `STATUS_SUCCESS`, and correct namespace/content postconditions. None returned `STATUS_PENDING`; consequently the wait branch was not entered and no asynchronous completion behavior was empirically exercised.

This is evidence only that the tested rename completed synchronously on this host even when the source handle was opened with `FILE_FLAG_OVERLAPPED`. It does not establish whether another filesystem/driver/version can return Pending, whether waiting on the file handle is the correct completion contract for all supported cases, or how cancellation/APC/IOCP paths behave. Before production use, the pending path needs a controlled test that actually observes Pending and validates IOSB visibility only after a documented completion signal. Automatic Restore remains disabled; no production Restore code changed.
## Genuine Windows overlapped Pending/completion control (2026-11-13)

Added `experiments/windows-overlapped-pending-completion-probe.cpp` and `scripts/windows-overlapped-pending-completion-probe.ps1`. This control uses a local named pipe with an overlapped server read. The read is deliberately issued before the client writes, so it must pend; the test then waits on the OVERLAPPED event and calls `GetOverlappedResult` to retrieve the completed byte count and payload.

On Windows 11 Pro build 26300, ten consecutive runs each observed `ReadFile` returning `FALSE` with `ERROR_IO_PENDING` (997), then event wait `WAIT_OBJECT_0`, successful `GetOverlappedResult`, 28 bytes, and exact payload match. All ten runs passed.

This validates the Windows overlapped event + wait + result-retrieval mechanism under a genuinely Pending operation. It is a control experiment using ReadFile/named pipes; it does not prove that `NtSetInformationFile(FileRenameInformationEx)` can pend, nor that a file-handle wait is its correct completion contract. The separate rename probe still completed synchronously in all observed runs. Together, the results establish that our test environment can produce real Pending I/O, while this specific rename operation did not do so. No production Restore code changed.
## Integrated handle-relative no-replace prototype slice (2026-11-13)

The experimental experiments/windows-native-handle-adapter.cpp now uses the direct NtSetInformationFile class-65 route inside the same NativeContext that retains the destination directory handle and validates the stage handle's FileIdInfo before and after publication. The earlier SetFileInformationByHandle(FileRenameInfoEx) relative-root attempt is no longer used for this operation; its observed ERROR_INVALID_PARAMETER remains documented as a rejected route. No absolute-path fallback was added.

The prototype initializes IOSB fields to sentinels and preserves four distinct observations: immediate syscall status, IOSB status, IOSB information, and whether IOSB changed. It treats STATUS_PENDING as not-completed (returns false; no automatic retry or hidden fallback), and only reports publish success after synchronous success, IOSB success, stable parent identity, and unchanged stage-handle identity.

New runner: scripts/windows-native-handle-adapter-prototype.ps1. It builds with MSVC /W4 /WX and executes only in uniquely named %TEMP% directories. Ten runs passed on Windows 11 Pro build 26300 / NTFS. Each run verified:
- retained root open and relative child open;
- parent handle identity remained stable;
- stage publication by retained stage handle succeeded without replacement;
- publication success returned immediate 0x00000000 and IOSB 0x00000000, with IOSB changed;
- destination collision returned immediate 0xC0000035 while IOSB remained at the initialized 0xCCCCCCCC sentinels;
- collision did not overwrite the already-published target;
- owned-handle unlink succeeded and the target name disappeared;
- a deliberately corrupted 128-bit expected identity was refused by `unlinkOwned`, and the published target remained present after refusal; only the exact observed handle identity was accepted. A second observer handle remained readable with the same FileIdInfo after disposition was requested and the owner handle closed; the name disappeared only after the observer also closed. Five consecutive full-prototype reruns passed the identity-refusal, outstanding-handle lifetime, and final-name-absence checks.

This is now a coherent experimental slice rather than a separate rename-only probe. It is still not production-ready: direct Nt* user-mode compatibility, complete reparse/volume policy, external-writer boundary, recursive traversal and stable enumeration semantics, async/cancellation semantics, durability/close uncertainty, crash failpoints, SQLite WAL/SHM interaction, and independent security review remain open. No production Restore path was changed.
## Handle-based bounded read and SHA-256 experiment (2026-11-13)

The integrated `experiments/windows-native-handle-adapter.cpp` prototype now adds `NativeContext::readAndHash` for an already-open child handle. It verifies the caller-supplied FileIdInfo before reading, rejects directories and reparse points, checks the initial file size against a caller-supplied maximum, reads through the handle in 64 KiB chunks, computes SHA-256 with Windows CNG, and rechecks handle identity, final size, exact byte count, and retained-parent identity before returning a digest. Any failed check clears the digest and reports failure. The runner links the inbox Windows `bcrypt.lib`; no new package was installed.

The unique temporary fixture contains the 20-byte payload `handle-relative-open`. Its digest is checked against a fixed known SHA-256 value. Ten consecutive MSVC x64 `/W4 /WX` runs passed: root open, relative child open, parent identity, bounded handle read/hash (20 bytes and expected digest), no-replace publication, collision preservation, owned-handle unlink, and target absence. Temporary executable/object and fixture files are removed by the runner/probe.

Evidence boundary: this exercises a single regular file on Windows 11 Pro build 26300 / NTFS. It is not a complete directory enumerator, does not test concurrent in-place mutation (size and identity checks do not prevent same-size content races), does not exclude pre-existing writable handles or mapped writers, and does not establish a snapshot-consistent read. Mutation exclusion, reparse/volume policy, asynchronous I/O, durability, crash consistency, SQLite WAL/SHM, supported user-mode Nt* API compatibility, and independent security review remain open. This prototype is not wired into production Backup/Restore. Automatic Restore remains disabled; Recovery Inspector remains read-only/operator-led; Phase 5 remains deferred.

## Handle-relative directory enumeration experiment (2026-11-13)

The experimental `NativeContext::enumerateChildren` enumerates directory entries through the retained root HANDLE using `GetFileInformationByHandleEx` with `FileIdExtdDirectoryRestartInfo` for the first batch and `FileIdExtdDirectoryInfo` for continuation. It uses a fixed 64 KiB aligned buffer, validates record offsets and UTF-16 name lengths, requires each filename to fit within its own record boundary, omits `.` and `..`, rejects path separators in returned names, enforces a caller-supplied maximum entry count, and clears partial results on any failure or overflow. Each record carries the complete 128-bit `FILE_ID_128` and retained root volume serial; `openEnumeratedChildReadOnly` later opens relative to the retained root with no-follow semantics and compares the opened handle identity to that token.

The fixture contains one regular file and one child directory. Ten consecutive MSVC x64 `/W4 /WX` runs passed: both names discovered, entry cap of one correctly refused the two-entry directory without returning partial results, opening the directory as a regular-file child was rejected, and the existing handle-read/SHA-256, no-replace publication, collision and owned-unlink checks remained green. A file-symlink fixture was also attempted with and without the unprivileged-create flag, but this host returned `ERROR_PRIVILEGE_NOT_HELD` (1314) both times; symlink-specific assertions therefore report `SKIP` on this host and are not counted as evidence.

Evidence boundary: one Windows 11 Pro build 26300 / NTFS host and a tiny two-entry directory. This is not a recursive walker and does not establish a stable directory snapshot under concurrent namespace mutation. The identity token detects a changed object at a later open, but does not freeze namespace state between enumeration batches. Behavior on remote or alternate filesystems is untested. The implementation checks reparse attributes at child-open validation, but the host did not permit creating a symlink fixture, so that branch remains unverified here. Production adapter, full volume/mount policy, external writer exclusion, durability, crash consistency, SQLite WAL/SHM, asynchronous completion and independent security review remain open. No production Backup/Restore path was changed; Automatic Restore remains disabled and Recovery Inspector remains read-only/operator-led.

### Windows native handle adapter regression rerun (2026-11-13)

- Rebuilt the integrated handle adapter prototype with MSVC `/W4 /WX` and ran it 10 consecutive times on Windows 11 Pro build 26300 / NTFS. All 10 runs passed the existing enumeration, bounded-result, directory rejection, 20-byte SHA-256 read, retained-parent identity, no-replace publication, collision, and handle-unlink assertions.
- Re-ran the independent NT rename race probe three times: 300 concurrent no-replace races total, zero failures; all three retained-parent/source-path substitution checks passed (303 assertions total).
- These reruns strengthen repeatability only. The later extended-ID experiment now binds each enumerated name to a full 128-bit ID and volume serial before accepting a subsequent open, and deterministic stale-name/high-byte/volume-token mismatch tests fail closed. This does not provide snapshot enumeration: namespace changes between batches remain possible. External writers, durability, supported native API policy, and independent security review remain open.
- Full project validation rerun on 2026-11-13: `npm run check` passed; `npm test` passed (187 pass, 4 skipped, 0 fail); `git diff --check` passed. Local Node is v22.23.2 while the project declares Node >=24.15.0, so this is exploratory local evidence; supported-runtime CI remains required. No commit or push was performed. Automatic Restore remains disabled; Recovery Inspector remains read-only/operator-led; Phase 5 remains deferred.

### Windows enumeration identity binding experiment (2026-11-13)

- Directory enumeration now returns structured records containing the filename, FILE_ID_EXTD_DIR_INFO complete 128-bit file ID, retained root volume serial, and attributes instead of names alone.
- Added openEnumeratedChildReadOnly, which opens relative to the retained directory with existing no-follow checks and compares the opened handle's volume serial and complete 128-bit FILE_ID_INFO against the enumeration token. Directory/reparse records are rejected before open.
- Added a deterministic replacement test: enumerate probe.bin, move the original to another name, create a different file at probe.bin, then attempt to open using the stale enumeration record. The helper rejects the replacement and returns no handle. The independently retained original handle remains valid for subsequent content verification.
- Ten consecutive MSVC /W4 /WX runs passed, including exact 128-bit identity binding, deliberate high-order full-ID mismatch rejection, volume-token mismatch rejection, stale-name replacement rejection, and all existing bounded enumeration, hash, publication, collision, and unlink checks.
- The installed Windows SDK 10.0.28000.0 declares `FILE_ID_EXTD_DIR_INFO`, `FileIdExtdDirectoryInfo`, and `FileIdExtdDirectoryRestartInfo`; the host NTFS probe successfully exercised these classes. The adapter fails closed if extended-ID enumeration is unavailable or fails. This closes the prior 64-bit truncation gap on this tested host only; it does not establish support on every Windows version or filesystem.
- This remains a one-host Windows 11 Pro build 26300 / NTFS experiment. It does not provide snapshot enumeration, arbitrary external-writer exclusion, durability or power-loss guarantees, supported native user-mode API policy, SQLite WAL/SHM validation, or independent security review. Automatic Restore remains disabled; Recovery Inspector remains read-only/operator-led; Phase 5 remains deferred.
## Concurrent namespace churn experiment (2026-11-13)

Added a bounded stress case to `experiments/windows-native-handle-adapter.cpp`. A background thread repeatedly creates, flushes, closes, and deletes `race-entry.bin` while the main thread performs 250 handle-relative directory enumerations. Whenever an enumeration returns the racing entry, the test attempts `openEnumeratedChildReadOnly` using the captured 128-bit ID and volume token. A successful open must match that exact token; an entry that disappears or is replaced is allowed to fail as a conflict. The test does not treat transient absence or a failed token open as data corruption.

Ten consecutive MSVC x64 `/W4 /WX` runs passed on Windows 11 Pro build 26300 / NTFS. Aggregate evidence: 2,500 successful enumeration calls, 1,595 successful create/flush cycles, 66 stale/disappeared-entry open conflicts, and zero accepted identity mismatches. Each run reported `safe=yes`. The count of conflicts is expected under concurrent deletion and is not a failure; the safety property is that no later open is accepted unless its handle identity equals the enumerated token.

Evidence boundary: one local NTFS host, one mutating thread, one file name, and bounded best-effort scheduling. This is not a snapshot guarantee, exhaustive race proof, multi-writer/privileged-writer test, cross-volume test, or production adapter validation. Enumeration can still reflect a changing namespace and may fail conservatively. Symlink fixture creation remains unavailable on this host (`ERROR_PRIVILEGE_NOT_HELD` 1314). No production Backup/Restore path changed; Automatic Restore remains disabled, Recovery Inspector remains read-only/operator-led, and Phase 5 remains deferred.

### Concurrent namespace churn and no-replace race rerun (2026-11-13)

- Rebuilt and reran `scripts/windows-native-handle-adapter-prototype.ps1 -Runs 10` on Windows 11 Pro build 26300 / NTFS. All 10 runs passed; each performed 250 enumeration calls (2,500 total). The create/flush mutator completed 1,721 cycles; 37 stale/disappeared-name opens failed closed; no enumerated identity mismatch was accepted.
- Re-ran `scripts/windows-nt-rename-race-probe.ps1 -Runs 5`: 500 concurrent no-replace races, zero failures, plus five retained-parent/source-path substitution checks (505 assertions total).
- The churn test still has one mutator thread and one enumerator thread, a single filename, and bounded scheduling. It is not a multiprocess/multiwriter proof or snapshot guarantee. The race probe separately exercises competing destination creation. One Windows 11/NTFS host only; no production adapter or Automatic Restore acceptance follows.
- Symlink fixture remains skipped (`ERROR_PRIVILEGE_NOT_HELD`, 1314). No production Restore code changed; Automatic Restore remains disabled, Recovery Inspector remains read-only/operator-led, and Phase 5 remains deferred.

### Independent multi-process namespace churn (2026-11-13)

- Added `scripts/windows-multiprocess-namespace-churn.ps1`. It launches four independent Windows PowerShell worker processes against one unique temporary directory. Each worker performs 500 unique create-new, write, file-flush, rename, and delete iterations while the parent independently enumerates names and attempts reads.
- Five consecutive runs passed: 20 worker-process executions and 10,000 total worker iterations. Across runs: 843 parent enumeration passes, 6,117 successful entry reads, 1,171 expected read/open conflicts caused by concurrent rename/delete, and zero invalid payloads. The harness observed 81 residual entries across the five runs before its final cleanup; all were removed successfully, with zero cleanup errors and zero remaining entries.
- This is a separate process-level namespace stress test using .NET/PowerShell path-based APIs. It does not invoke `NativeContext::enumerateChildren` or `openEnumeratedChildReadOnly`, does not verify FileIdInfo token binding, and is not evidence of native-adapter multiprocess correctness. It does demonstrate that independent processes can churn the same NTFS directory while the observer sees only complete, well-formed payloads or expected open conflicts.
- One Windows 11 Pro build 26300 / NTFS host only. No power-loss, remote filesystem, privileged actor, or production Restore acceptance follows. Automatic Restore remains disabled; Recovery Inspector remains read-only/operator-led; Phase 5 remains deferred.

### Direct native API multi-process exercise (2026-11-13)

- Extended `experiments/windows-native-handle-adapter.cpp` with a worker mode and parent process launcher. The prototype now starts four independent instances of the same native executable against one retained-root directory.
- Each worker opens its own `NativeContext`/root HANDLE and repeats 100 times: create a unique stage file, write and `FlushFileBuffers`, capture `FileIdInfo`, publish through `NativeContext::publishNoReplace` using the retained parent handle, enumerate through `NativeContext::enumerateChildren`, locate its own directory-entry token, open it through `openEnumeratedChildReadOnly`, compare the complete volume/File ID identity, then delete the original object through `unlinkOwned` on its retained handle.
- Five consecutive full-prototype runs passed: 20 independent worker-process executions and 2,000 successful native publish → enumerate → token-open → identity-compare → handle-owned-unlink sequences. All workers returned zero; the parent observed no missing own-entry token, identity mismatch, failed publication, or failed owned unlink. Existing single-process native tests also passed in each run.
- This is direct multi-process exercise of the prototype's native handle-relative API surface on one Windows 11 Pro build 26300 / NTFS host. It remains a bounded controlled workload: unique per-worker names, four workers, 100 iterations, no hostile/privileged actor, no injected process kill between native transitions, no cross-volume/remote filesystem, no power-loss durability proof, and no independent security review. It does not establish a supported user-mode contract for undocumented `NtCreateFile`/`NtSetInformationFile` usage.
- Automatic Restore remains disabled; Recovery Inspector remains read-only/operator-led; Phase 5 remains deferred. No production Restore path was modified.

### Native process-termination and operator-recovery probe (2026-11-13)

- Added an explicit `--native-crash-worker` mode to the C++ prototype. The parent launches a separate process for each failpoint and waits for its deliberate `ExitProcess` termination, ensuring the worker's open handles are closed by process teardown rather than by its normal cleanup path.
- Three boundaries are exercised in isolated directories: (1) after stage data is written and `FlushFileBuffers` succeeds but before publication; (2) immediately after handle-relative no-replace publication; (3) after enumeration and token-based open/identity verification but before owned unlink.
- After each child terminates with its expected failpoint exit code, a fresh `NativeContext` inspects the directory. It requires exactly the expected stage or published entry, reopens it using the enumerated full identity token, reads and validates the known payload, then separately obtains a DELETE-capable handle relative to the retained parent, verifies the same identity, and performs operator-led `unlinkOwned`. A final enumeration must be empty.
- Five consecutive full-prototype runs passed all three failpoints: 15 deliberate child-process terminations, 15 successful post-termination inspections, payload checks, identity checks, and operator-led cleanup operations. No unexpected directory entries remained after each recovery.
- The first harness iteration intentionally exposed an access-right distinction: the read-only enumeration handle cannot perform disposition-based deletion. The recovery path was corrected to acquire a separate DELETE-capable, no-follow, parent-relative handle and revalidate identity before unlink. This is a harness/prototype capability finding, not a production Recovery Inspector change.
- Evidence boundary: process termination only, not power loss, storage-controller cache loss, kernel crash, or filesystem corruption. Three controlled failpoints do not cover every instruction/transition or SQLite WAL/SHM restore sequence. Single Windows 11 Pro build 26300 / NTFS host; no hostile/privileged writer, remote filesystem, or independent security review. Automatic Restore remains disabled.

### Cross-process unlink against pathname substitution (2026-11-14)

- Added a deterministic two-process probe to `experiments/windows-native-handle-adapter.cpp`. The parent opens `unlink-target.bin` through `NativeContext::openChildForDelete`, retaining a DELETE-capable handle and its full volume/File ID identity. A separate child process then renames that original directory entry to `original-moved.bin` and creates a new `unlink-target.bin` containing the distinct `replacement-decoy` payload.
- Only after the child exits successfully does the parent call `unlinkOwned` using the original retained handle and expected identity. The probe verifies that the replacement at the original pathname remains readable with its exact decoy bytes, while the moved original name disappears after the retained handle is closed. The child and parent use independent processes; the sequence is deterministic rather than timing-dependent.
- Five consecutive full native prototype runs passed: five independent child-process pathname substitutions, five successful handle-owned disposition requests, five preserved replacement objects, and five removed original objects. Each full run also retained the existing four-worker × 100-iteration native publish/enumerate/token-open/identity-check/unlink workload and three process-termination recovery cases.
- This demonstrates the tested synchronous `SetFileInformationByHandle(FileDispositionInfo)` behavior on one Windows 11 Pro build 26300 / NTFS host. It does not prove behavior for pending/ambiguous disposition completion, mapped views, remote or alternate filesystems, privileged interference, power loss, or every concurrent interleaving. The prototype still relies on dynamically resolved `NtCreateFile`/`NtSetInformationFile` for other handle-relative operations; supported user-mode API policy and independent security review remain unresolved. No production Restore code changed; Automatic Restore remains disabled, Recovery Inspector remains read-only/operator-led, and Phase 5 remains deferred.

### Cross-process delete with an outstanding observer handle (2026-11-14)

- Added `runNativeDeleteWithObserverProbe` and a separate `--native-delete-observer-worker` process mode to `experiments/windows-native-handle-adapter.cpp`.
- The parent opens an observer handle to a fixture file with read access and `FILE_SHARE_DELETE`. A child process independently opens the same entry through the retained directory handle, validates its FileIdInfo, requests handle-owned disposition, and closes its DELETE-capable handle.
- While the parent's observer handle remains open, the parent rechecks the same full file identity and reads the original payload successfully. A fresh open by the original pathname must fail with the expected delete-pending outcomes (`ERROR_ACCESS_DENIED` or `ERROR_FILE_NOT_FOUND`). After the observer handle closes, the original pathname must be absent with `ERROR_FILE_NOT_FOUND`.
- Five consecutive full prototype runs passed: five child-process delete requests, five surviving/readable observer handles, five expected name-unavailable checks, and five final name-absence checks. Each run also passed the pathname-substitution unlink probe, four-process native publication/enumeration/token-open/unlink workload, three process-termination recovery points, and the bounded namespace churn probe.
- This is synchronous disposition behavior observed on one Windows 11 Pro build 26300 / NTFS host. It does not validate pending/ambiguous completion, mapped views, remote/alternate filesystems, privileged interference, power-loss durability, or a production Restore path. Symlink fixture remains skipped because the host returned `ERROR_PRIVILEGE_NOT_HELD (1314)`. No production Restore code changed; Automatic Restore remains disabled and Recovery Inspector remains read-only/operator-led.

### Unlink refusal diagnostics and conservative completion state (2026-11-14)

- Extended the experimental `NativeContext::unlinkOwned` result evidence. It now records the exact Win32 error for precondition/identity refusal and `SetFileInformationByHandle` failure, and exposes a separate `lastUnlinkMayHaveCompleted` flag when disposition succeeded but the subsequent retained-parent check failed.
- A deliberately mismatched 128-bit identity is rejected before mutation with `ERROR_INVALID_DATA` (13), and the probe confirms this is not classified as possibly-completed. A read-only handle without `DELETE` access is rejected by the OS with `ERROR_ACCESS_DENIED` (5); the object remains available and the failure is classified as not possibly-completed.
- Five consecutive MSVC `/W4 /WX` runs passed the integrated native suite and observed the exact expected `ERROR_ACCESS_DENIED` result in every run.




### Same-name concurrent publication race (2026-11-14)

- Added a two-process barrier test: both processes create and flush distinct stage files, then attempt `publishNoReplace` to the exact same destination name.
- On the Windows 11 Pro build 26300 / NTFS host, one process returned synchronous success and the other returned `STATUS_OBJECT_NAME_COLLISION`. The destination content matched one complete contender payload; the losing stage was removed only through its own retained handle and verified identity. Both stage names were absent at completion.
- Five consecutive full prototype runs passed (one same-name race per run). This validates the tested local NTFS no-replace race, not cross-volume, remote, alternate filesystem driver, crash/power-loss durability, or privileged interference. It does not establish production user-mode support for `NtSetInformationFile`.

### No-replace publication ambiguous-result fault injection (2026-11-14)

- Added a probe-only deterministic failpoint after `NtSetInformationFile(FileRenameInformationEx)` returns synchronous success and before retained-parent/identity postconditions are accepted. `publishNoReplace` returns failure while exposing `lastPublishMayHaveCompleted=true` and preserving the raw immediate/IOSB statuses.
- On the Windows 11 Pro build 26300 / NTFS host, the immediate and IOSB statuses were both `STATUS_SUCCESS`; the stage pathname was absent and the destination pathname existed with the exact same volume/FileId identity as the original stage handle. The probe made no retry, overwrite, fallback rename, or cleanup attempt. This directly demonstrates why a failed postcondition cannot be interpreted as proof that publication did not happen.
- Five consecutive full native prototype runs passed after integration. Existing no-replace collision behavior remained `STATUS_OBJECT_NAME_COLLISION` with the IOSB sentinel unchanged. The wrapper also now marks `STATUS_PENDING` as possibly-completed rather than treating it as a safe retry; no actual pending rename completion was observed or tested here.
- The failpoint injects a postcondition failure; it is not a genuine kernel failure, asynchronous completion, crash/power-loss, or durability test. `NtSetInformationFile` user-mode supportability remains unresolved. No production Restore code changed; Automatic Restore remains disabled and Recovery Inspector remains read-only/operator-led.
### Post-disposition ambiguous-result fault injection (2026-11-14)

- Added a probe-only deterministic failpoint immediately after `SetFileInformationByHandle(FileDispositionInfo)` succeeds and before the retained-parent postcondition is accepted. The injected post-check failure returns failure with `ERROR_INVALID_HANDLE` (6) and `lastUnlinkMayHaveCompleted=true`.
- On Windows 11 Pro build 26300 / NTFS, the file remains delete-pending while the disposition handle is open: reopening the path is refused with `ERROR_ACCESS_DENIED` (5). After closing the last handle, the name is absent. This is an important distinction: pathname metadata visibility during delete-pending is not proof that the object remains safely reopenable.
- The caller receives a possibly-completed outcome and the probe performs no retry or fallback cleanup. The fixture confirms the resulting namespace after the handle closes. The failpoint is an injected postcondition failure, not a real kernel/driver failure or power-loss test.
- This validates the prototype's conservative ambiguity signaling only. It does not establish asynchronous disposition semantics, crash durability, remote filesystem behavior, or production adapter acceptance. No production Restore code changed; Automatic Restore remains disabled and Recovery Inspector remains read-only/operator-led.

- This does not create a production-grade completion model: a failure after the disposition API succeeds is conservatively flagged possibly-completed, but no injected post-call parent failure, asynchronous disposition, cancellation, power-loss, mapped-view, remote-filesystem, or privileged-interference test has been completed. No production Restore code changed; Automatic Restore remains disabled and Recovery Inspector remains read-only/operator-led.

### Windows handle-relative publication versus deletion race (2026-11-14)

- Added a synchronized two-process probe to `experiments/windows-native-handle-adapter.cpp`. The fixture starts with a pre-existing target. One child retains a flushed, identity-checked stage handle and attempts no-replace publication; the other independently opens the original target relative to its retained parent handle with `DELETE` access and calls `unlinkOwned` against the captured full identity. Both wait on a shared event before proceeding.
- Five consecutive MSVC `/W4 /WX` runs passed. In all five observed schedules, the publisher returned immediate `STATUS_OBJECT_NAME_COLLISION` (`0xC0000035`), the IOSB remained at its sentinel (`0xCCCCCCCC`, unchanged), and `lastPublishMayHaveCompleted` remained false. The deleter returned success with `ERROR_SUCCESS` (0), `possibly-completed=false`; the final target name was absent and the publisher's stage was removed only through its own identity-checked handle. No unexpected publication or overwrite was observed.
- Interpretation is deliberately narrow: the start barrier synchronizes readiness, not the exact kernel operation order. These five runs observed the collision-before-final-removal outcome; they do not establish every possible interleaving, nor demonstrate a delete-first schedule followed by successful publication into the now-vacant name. A future test should add deterministic operation-order gates and retain raw statuses/postconditions for both orderings.
- One Windows 11 Pro build 26300 / NTFS host only. This is experimental race evidence, not snapshot isolation, arbitrary external-writer exclusion, power-loss durability, stable user-mode API support, security review, or production Restore acceptance. No production Restore code changed; Automatic Restore remains disabled, Recovery Inspector remains read-only/operator-led, and Phase 5 remains deferred.

### Deterministic publication/deletion orderings (2026-11-14)

- Added `runOrderedPublishDeleteProbe` to the Windows native experimental adapter. Unlike the two-process race, these cases deliberately sequence the kernel operations so both orderings are covered without scheduler assumptions.
- Publish-first case: with the original target present and identity-bound, no-replace publication returned `STATUS_OBJECT_NAME_COLLISION`; `lastPublishMayHaveCompleted=false`. Identity-checked deletion of the original then succeeded; the target name was absent. The stage was separately removed through its retained identity-checked handle.
- Delete-first case: identity-checked deletion of the original target completed and its handle was closed before publication. No-replace publication then succeeded; immediate and IOSB statuses were `STATUS_SUCCESS`, ambiguity was false, and reopening the target verified both the expected stage FileId/volume identity and exact payload bytes.
- Five consecutive full native prototype runs passed both deterministic orderings (10 ordered scenarios total), alongside the synchronized two-process race in each run. This establishes the expected namespace outcomes for these two explicitly ordered sequences on this host; it is not a proof for all possible concurrent interleavings.
- Evidence remains limited to one Windows 11 Pro build 26300 / NTFS host and the experimental direct `NtSetInformationFile` path. It does not establish a supported stable user-mode API contract, remote or alternate filesystem behavior, arbitrary external-writer exclusion, power-loss durability, or production Restore acceptance. Automatic Restore remains disabled; Inspector remains read-only/operator-led; no production Restore logic was changed.

### Conservative native publication failure classification (2026-11-14)

- Tightened the experimental `publishNoReplace` result policy: once `NtSetInformationFile` has actually been issued, the result defaults to `possibly-completed`. The only native failure currently classified as a proven non-publication is the observed no-replace `STATUS_OBJECT_NAME_COLLISION` (`0xC0000035`).
- Other failing immediate NTSTATUS values, `STATUS_PENDING`, and non-success IOSB outcomes remain possibly-completed. This avoids the earlier unsafe assumption that every negative immediate NTSTATUS necessarily proves the namespace was untouched. Raw immediate/IOSB status and IOSB-change evidence remain captured.
- Preflight failures that occur before the native call (invalid context/identity/name or missing entry point) remain not-performed. The policy is intentionally conservative; a future platform profile may narrow definite-no-mutation statuses only with authoritative API semantics and tests.
- Five consecutive full native prototype runs passed, including no-replace collision (still `possibly-completed=false`), successful publication, injected postcondition ambiguity, both deterministic publish/delete orderings, multiprocess and crash probes. `npm run check`, `npm test` (zero failures), and `git diff --check` passed; temporary residue count was zero.
- This did not test an actual kernel/driver failure status or pending rename completion; it verifies the existing success/collision paths remain intact after hardening the classification. One Windows 11 Pro build 26300 / NTFS only. Experimental adapter only; no production Restore change, no Automatic Restore enablement.

### Conservative native disposition failure classification (2026-11-14)

- Hardened experimental unlinkOwned: all preflight refusals (invalid context/parent, identity mismatch, or failed identity lookup) remain not-performed. Immediately before the SetFileInformationByHandle(FileDispositionInfo) boundary, the flag is set to possibly-completed.
- A FALSE return from SetFileInformationByHandle now preserves possibly-completed; the prototype does not infer that a Win32 error proves no disposition occurred. In particular, the read-only-handle fixture still reports ERROR_ACCESS_DENIED (5), but is now conservatively marked possibly-completed. The target was observed preserved in that fixture; this observation is not elevated into a general API guarantee.
- Added a synthetic uncertain-result failpoint (ERROR_GEN_FAILURE, 31) at the disposition boundary. It intentionally does not issue the OS disposition call; it verifies only that an indeterminate result is surfaced as possibly-completed and that the harness does not auto-retry or clean up. The target remained present.
- Existing wrong-identity refusal remains ERROR_INVALID_DATA (13), not-performed, with target preserved. Existing successful disposition and post-disposition failpoint remain passing; the latter reports possibly-completed and the name disappears after the final handle closes.
- Five consecutive full native prototype runs passed, including the synthetic uncertain-result case, post-disposition failpoint, observer lifetime, cross-process tests, deterministic publish/delete orderings, and crash probes. One Windows 11 Pro build 26300 / NTFS only.
- This does not establish that a real SetFileInformationByHandle failure can mutate the namespace; it deliberately avoids claiming the opposite without an authoritative platform contract. No genuine API-failure injection, pending disposition, power-loss, remote filesystem, or production adapter acceptance was tested. No production Restore code changed; Automatic Restore remains disabled and Inspector remains read-only/operator-led.

### MoveFileEx write-through and no-replace probe (2026-11-14)

- Added `experiments/windows-move-write-through-probe.cpp` and `scripts/windows-move-write-through-probe.ps1`. Each run creates a unique temporary directory, creates/flushes disposable files, tests a collision and a successful same-volume rename, and removes only its own fixtures.
- Five consecutive runs passed. With `MOVEFILE_WRITE_THROUGH` and without `MOVEFILE_REPLACE_EXISTING`, an existing destination caused failure `ERROR_ALREADY_EXISTS` (183); both source and original destination contents remained unchanged. A non-collision same-volume rename succeeded; source name disappeared and destination bytes matched. Cleanup passed every run.
- This establishes observed Win32 pathname-based collision behavior and content/name postconditions on the local Windows 11 Pro / NTFS host. It is not a race-free proof against arbitrary namespace mutation, not handle-relative publication, and not a power-loss durability test.
- Microsoft documents `MOVEFILE_WRITE_THROUGH` as waiting for the move to complete on disk; the explicit flush guarantee is described for copy-and-delete moves. The flag is not evidence that a same-volume namespace rename plus parent directory metadata is durably committed under every filesystem/driver/power-loss scenario. Keep it as a candidate only; do not replace the current native handle-relative no-replace operation.
- Native `FileRenameInformationEx` with `FILE_RENAME_REPLACE_IF_EXISTS` clear remains the better semantic match for handle-relative no-replace publication; its use through dynamically resolved NtSetInformationFile remains an experimental implementation, not a documented stable Win32 application API guarantee.

### Windows directory-flush API contract cross-check (2026-11-14)

- Added `experiments/windows-directory-flush-contract-probe.cpp` and `scripts/windows-directory-flush-contract-probe.ps1` to compare three real CreateFileW access masks against FlushFileBuffers on a disposable temporary directory. The probe removes its directory in all normal paths and does not touch project/application data.
- On the local Windows 11 Pro build 26300 / NTFS host: the prototype's directory mask (`FILE_LIST_DIRECTORY | FILE_ADD_FILE | FILE_DELETE_CHILD | FILE_READ_ATTRIBUTES | SYNCHRONIZE`) flushed successfully (ERROR_SUCCESS); `FILE_READ_ATTRIBUTES | SYNCHRONIZE` opened but FlushFileBuffers failed with ERROR_ACCESS_DENIED (5); `GENERIC_WRITE` opened and flushed successfully. Temporary directory cleanup passed.
- The read-only case is a genuine OS-reported access failure, not a synthetic failpoint. It validates that the adapter must preserve and classify the actual Win32 error; it does not simulate media failure, a failed disk flush, or power loss.
- Contract review against Microsoft Learn: FlushFileBuffers documents a GENERIC_WRITE requirement, while the Directory Handles page documents the supported consumers of directory handles and does not list FlushFileBuffers. The successful prototype-mask call is therefore an observed host behavior, not sufficient evidence of a documented/stable application contract. Do not mark directory flush as supported for the Windows acceptance matrix based on this observation.
- `MoveFileExW(MOVEFILE_WRITE_THROUGH)` is documented to wait for the move to complete on disk; its explicit guarantee is strongest for copy-and-delete moves. It does not document the complete parent/ancestor namespace crash-durability contract needed by Restore, nor does it provide the handle-relative no-replace semantics required by the current adapter design. It is a research candidate, not an approved replacement.
- No production change. Native directory flush remains experimental and is not wired into Restore. Automatic Restore remains disabled; Inspector remains read-only/operator-led; Phase 5 remains deferred.

### Windows retained-directory-handle flush probe (2026-11-14)

- Extended the experimental `NativeContext` with `flushParentDirectoryForProbe`, which invokes `FlushFileBuffers` on the already-retained directory HANDLE and revalidates the same directory FileId before and after the call. The operation records the Win32 error and marks the result possibly-completed from the syscall boundary until synchronous success plus postcondition validation.
- On Windows 11 Pro build 26300 / local NTFS, `FlushFileBuffers(rootDirectoryHandle)` returned success (`ERROR_SUCCESS`, 0) in five consecutive complete native prototype runs. In each run, a second call immediately after successful handle-relative no-replace publication also succeeded; a third call immediately after identity-checked unlink/disposition succeeded. All 15 directory-handle flush calls succeeded.
- The directory handle was opened with the prototype's existing `FILE_LIST_DIRECTORY | FILE_ADD_FILE | FILE_DELETE_CHILD | FILE_READ_ATTRIBUTES | SYNCHRONIZE` access mask and `FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT`. This is a local feasibility observation, not proof that every Windows filesystem/driver honors directory-entry durability or that the call flushes all relevant metadata/controller caches.
- This does not establish a supported/stable user-mode durability contract, power-loss behavior, storage-controller behavior, remote/SMB/cloud-sync filesystem behavior, or crash-replay guarantees. No forced machine reset or power cut was performed. The production Node `syncDirectory` still reports unsupported on Windows and callers still ignore that result; this experimental native path has not been integrated into production Restore.
- The probe remains experimental. Automatic Restore stays disabled; Recovery Inspector stays read-only/operator-led; Phase 5 remains deferred.

### Win32 FileRenameInfoEx relative-root API probe (2026-11-14)

- Added `experiments/windows-file-rename-info-ex-probe.cpp` and `scripts/windows-file-rename-info-ex-probe.ps1`. The probe compiles against the installed Windows SDK 10.0.28000.0 declarations for `FILE_RENAME_INFO`, `FileRenameInfoEx`, and `FILE_RENAME_FLAG_REPLACE_IF_EXISTS`; it uses only uniquely named disposable files under the host temp directory.
- On Windows 11 Pro build 26300 / NTFS, ten consecutive runs showed `SetFileInformationByHandle(source, FileRenameInfoEx, ...)` with `Flags=0`, a retained directory `RootDirectory` handle, and a relative single-component destination consistently failed with `ERROR_INVALID_PARAMETER` (87). The same failure occurred when the destination name already existed.
- Each run verified that rejected calls left the source file and existing collision target unchanged. No path-based fallback was attempted; cleanup removed only the probe's uniquely created fixtures.
- Interpretation: the public SDK exposes the enum, structure, and flags, but the documented Win32 wrapper still does not provide the required relative-`RootDirectory` behavior on this tested host. This does not justify replacing the current experimental native call. The direct `NtSetInformationFile` route remains experimental and lacks a stable documented Win32 application compatibility guarantee.
- Evidence is one Windows 11 Pro build 26300 / NTFS host and ten repetitions; it does not establish behavior on other Windows versions/filesystems or explain the underlying error. No production Restore code changed. Automatic Restore remains disabled; Recovery Inspector remains read-only/operator-led; Phase 5 remains deferred.


### Windows native flush/close boundary probes (2026-11-14)

- Added an experimental handle-bound flush operation. It validates the retained parent and expected FileId before FlushFileBuffers, marks the operation possibly-completed at the syscall boundary, and clears ambiguity only after synchronous success plus identity/parent postconditions.
- Added synthetic pre-call-boundary failure (ERROR_GEN_FAILURE) and post-success postcondition failure (ERROR_INVALID_HANDLE). Both report possibly-completed. The post-success case executes a real FlushFileBuffers first; the failpoint then simulates loss of successful result acceptance. This is not a simulated storage/controller failure.
- Added a tracked close wrapper for the probe. A synthetic uncertain close result leaves the handle value untouched and reports possibly-completed; the subsequent real close succeeds and invalidates the caller handle. Successful close is reported separately from flush durability.
- Five consecutive full native prototype runs passed all flush/close boundary assertions, including preflight identity binding, uncertain outcomes, successful flush, uncertain close, and final successful close. The fixture remained present until explicitly removed by the probe.
- Important semantics: successful FlushFileBuffers is the only flush-success signal in this slice; successful CloseHandle does not substitute for a flush. A CloseHandle failure is tracked as handle-lifetime/result uncertainty, not misreported as proof that a preceding flush failed or succeeded. The synthetic close failure did not call CloseHandle.
- Evidence is limited to one Windows 11 Pro build 26300 / NTFS host. No power-loss, controller-cache, filesystem crash, real FlushFileBuffers failure, genuine CloseHandle failure, remote filesystem, or production Restore integration was tested. This is experimental adapter evidence only; no production Restore code changed, Automatic Restore remains disabled, and Inspector remains read-only/operator-led.

### Native process crash after stage-handle close (2026-11-14)

- Extended the child-process crash probe with `after-stage-close`: after writing and successfully flushing the stage file, the worker captures its FileId, closes the stage handle through `NativeContext::closeOwned`, and terminates immediately with exit code 84 before publication. The parent then opens a fresh context, enumerates the directory, binds the surviving `crash.stage` entry to its full identity, reads it through the handle, computes SHA-256, checks the expected byte count, and performs explicit identity-checked operator cleanup. The current assertion does not compare the computed digest with a precomputed expected digest.
- Five consecutive full prototype runs passed this new point. Each observed the expected `crash.stage` entry, matching identity, expected byte count/content validation, successful operator-led cleanup, and an empty directory afterward. The existing after-flush, after-publish, and after-token-open crash points also passed in every run (20 crash/recovery scenarios total across four failpoints × five runs).
- This is process-termination evidence after a successful `CloseHandle`, not a machine crash, power-loss, filesystem journal replay, storage-cache durability proof, or test of a genuine CloseHandle failure. It demonstrates that a closed, flushed stage can be rediscovered and handled by identity in this tested local NTFS scenario; it does not prove the stage directory entry is power-loss durable. One Windows 11 Pro build 26300 / NTFS host only. Experimental prototype; no production Restore changes and Automatic Restore remains disabled.

### Windows native adapter input-boundary hardening (2026-11-14)

- Tightened the experimental adapter's single-component name validation shared by child-open, delete-open, and no-replace publication. Names must be non-empty, at most `USHORT_MAX / sizeof(WCHAR)` UTF-16 code units before conversion to `UNICODE_STRING.Length`, contain no slash, backslash, colon/alternate-stream delimiter, or embedded NUL, and must not be `.` or `..`.
- This closes a truncation/overflow gap: the prior child-open methods cast `name.size() * sizeof(wchar_t)` directly to `USHORT`, allowing oversized caller-supplied strings to wrap before the native relative-open call. The native prototype now rejects them before constructing the NT object name.
- Hardened directory enumeration record parsing to reject nonzero `NextEntryOffset` values not aligned to `alignof(FILE_ID_EXTD_DIR_INFO)`, in addition to existing bounds and filename-length checks, before advancing and interpreting the next record.
- Added negative cases for empty name, dot, dot-dot, path separator, alternate-stream colon, embedded NUL, and a component exceeding the UNICODE_STRING length ceiling; also verifies delete-open rejects the overlong case.
- Five consecutive MSVC `/W4 /WX` full native prototype runs passed. All new name-validation cases passed on every run, along with the existing multi-process publication, crash-point, enumeration churn, identity, hash, flush/close ambiguity, and unlink tests. Symlink creation was skipped by the host with `ERROR_PRIVILEGE_NOT_HELD` (1314); the no-follow/token-rejection paths remained covered by the existing conditional logic only when a symlink fixture is available.
- Evidence is limited to the experimental C++ prototype on one Windows 11 Pro build 26300 / NTFS host. This does not add external-writer exclusion, snapshot-consistent hashing, power-loss durability, or a supported production Win32 adapter contract. No production Restore code changed. Automatic Restore remains disabled; Recovery Inspector remains read-only/operator-led; Phase 5 remains deferred.

### Windows directory enumeration malformed-buffer tests (2026-11-14)

- Extracted the `FILE_ID_EXTD_DIR_INFO` record validation into a bounded parser used directly by `NativeContext::enumerateChildren`; the parser clears partial results on any malformed record and enforces the caller's aggregate entry ceiling.
- Added synthetic aligned-buffer tests for: valid single record; truncated fixed header; odd UTF-16 byte length; oversized filename length; `NextEntryOffset` before the filename payload; offset beyond the supplied buffer; unaligned offset; aligned next record with truncated fixed header; embedded NUL; path separator; empty component; zero entry budget; valid two-record chain; aggregate entry-limit overflow; and terminal filename payload truncated at the supplied boundary.
- The native prototype was rebuilt with MSVC `/W4 /WX`; five consecutive full runs passed, including the malformed-buffer matrix on each run, in addition to existing native namespace/concurrency/crash/identity tests. The symlink fixture remains skipped on this host (`ERROR_PRIVILEGE_NOT_HELD`, 1314).
- The production enumeration API does not expose a byte-count output for `GetFileInformationByHandleEx`; its parser therefore bounds reads against the actual allocated 64 KiB buffer, while synthetic tests pass explicit shorter byte counts to exercise truncation boundaries. Kernel-returned metadata is still treated as untrusted for structural parsing, and this does not establish a snapshot of a concurrently mutating directory.
- Evidence remains one Windows 11 Pro build 26300 / NTFS experimental prototype. No production Restore code or platform eligibility changed. Automatic Restore remains disabled; Recovery Inspector remains read-only/operator-led; Phase 5 remains deferred.

### Windows enumeration cross-batch consistency guard (2026-11-14)

- `enumerateChildren` now parses each returned native buffer into a temporary batch, then appends it only if the accumulated result contains no repeated exact entry names and the aggregate `maxEntries` ceiling remains satisfied. Any malformed batch, repeated name, or aggregate overflow clears the complete result and fails closed.
- Duplicate-name validation covers duplicates within one native buffer and across successive `GetFileInformationByHandleEx` calls. It intentionally compares exact UTF-16 names rather than case-folding because Windows directories can be configured as case-sensitive. Distinct names sharing a File ID are not rejected because hard links may legitimately exist.
- Empty batches are allowed: an empty directory or a batch containing only filtered `.` / `..` entries must not be mistaken for corruption. This behavior was caught during crash-recovery regression tests and corrected before acceptance.
- Synthetic tests cover distinct successive batches, repeated name across batches, duplicate names within a batch, aggregate-limit overflow, and empty batches; failed appends leave the previously accumulated result unchanged.
- Five consecutive MSVC native-prototype runs passed, including four process-termination recovery boundaries and 250 concurrent namespace-churn enumeration attempts per run. These tests demonstrate conservative rejection and identity-bound opens on this Windows 11 Pro build 26300 / NTFS host; they do not provide a directory snapshot, guarantee completeness under concurrent mutation, or prove behavior on other filesystems/drivers.
- No production Restore implementation or platform eligibility changed. Automatic Restore remains disabled; Recovery Inspector remains read-only/operator-led; Phase 5 remains deferred.
