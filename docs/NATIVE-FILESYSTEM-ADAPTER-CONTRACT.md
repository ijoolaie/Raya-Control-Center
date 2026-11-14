# Native Filesystem Adapter Contract

Status: Phase 6 design contract. No native adapter is implemented or enabled by this document.

## 1. Purpose and non-goals

The adapter is the platform boundary for Restore v2 filesystem evidence and namespace transitions. It must provide object identity and operations anchored to retained handles, not translate path-based Node.js calls into native calls while retaining path-based assumptions.

This contract does not authorize automatic Restore. The current JavaScript Restore remains operator-led. A platform/filesystem profile is ineligible until its implementation, adversarial tests, crash-consistency tests, and independent security review satisfy every applicable gate.

The adapter must not claim protection from privileged actors, kernel compromise, hardware failure, remote filesystem semantics, memory-mapped writers, or pre-existing external handles unless the exact threat is addressed by a separately demonstrated OS/filesystem contract.

## 2. Core invariants

1. Handle-derived identity: identities and metadata are obtained from opened handles, not inferred from path strings or a prior lstat.
2. Retained namespace anchors: every operation is relative to retained, verified parent handles. A parent replacement invalidates the context.
3. No-follow by construction: opening a source or child entry must not silently traverse symlinks, junctions, reparse points, or equivalent indirections.
4. Same-object continuity: validation, hashing, staging, and publication must refer to the same objects whose identities were recorded. Reopening a pathname is not continuity evidence.
5. Explicit external-writer capability: the adapter reports whether arbitrary external mutation is excluded for each operation interval. false or unknown means no automatic transition requiring that guarantee.
6. No-replace namespace changes: publication must fail on unexpected destination existence; replacement is a distinct operation with its own explicit preconditions.
7. Durability is explicit: file-data flush, metadata flush, directory/parent flush, and rename durability are separate capabilities. Unsupported or ambiguous durability is not success.
8. Conservative ambiguity: identity mismatch, sharing violation, unsupported object type, partial enumeration, uncertain syscall result, or lost handle invalidates the context and preserves evidence.
9. No hidden cleanup: the adapter never deletes or repairs artifacts as a side effect of open, inspect, failed acquisition, or recovery evaluation.
10. Bounded reporting: native errors are mapped to stable bounded codes; raw paths, file contents, and OS error strings are not emitted to operational logs.

## 3. Required capability profile

Every adapter instance returns an immutable profile tied to implementation version, OS build, filesystem type, mount/volume identity, and relevant mount options.

Required fields:

- adapterId, adapterVersion, protocolVersion
- platform, platformBuild, filesystemType, volumeIdentity
- handleIdentity
- parentHandleBinding
- noFollowOpen
- directoryEnumerationCompleteness
- externalMutationExclusion
- noReplacePublish
- atomicRename
- fileDataDurability
- directoryEntryDurability
- hardLinkIdentity (only if required and actually proven)
- supportedObjectKinds
- limitations (bounded stable codes)

Each capability is tri-state: supported, unsupported, or unknown, except descriptive identity/version fields. A capability may additionally state a narrow scope, such as only local ext4 on a tested kernel build. A generic platform label is never a sufficient scope.

The profile is immutable for one operation. Any observed platform, volume, mount, adapter, or capability drift invalidates the operation context.

## 4. Required operation context

openOperationContext(request) either fails without mutation or returns an opaque context containing:

- retained trusted parent handles for source and destination namespaces;
- retained source handle, when a source exists;
- handle-derived identities and object kinds;
- immutable capability profile and context UUID;
- operation-scoped reservation guard reference supplied by the caller;
- an invalidation state that is monotonic.

The context must not expose raw native handles or mutable identity structures to general application code. It exposes only narrow methods and immutable snapshots. Closing or invalidating the context permanently disables all methods other than safe diagnostic status and idempotent close.

The adapter must not acquire SQLite reservations itself. The application acquires the complete ordered reservation set first and passes a held guard/context token. This keeps database coordination and native filesystem evidence separate and auditable.

## 5. Required method semantics

The eventual binding may use different names, but it must implement equivalent semantics:

- openParent(path, policy): open one trusted directory anchor without following prohibited indirections; return handle-derived identity.
- openEntry(parent, name, policy): open a child relative to the retained parent; return an opaque handle and identity. Reject unsupported object kinds.
- statHandle(handle): return stable identity, type, size, link count where meaningful, and timestamps as supplemental metadata.
- enumerate(parent): return a complete bounded inventory tied to the retained parent. Partial enumeration is an error, never an empty/complete result.
- readAndHash(handle, algorithm): hash bytes from the retained object; detect read errors and identity/context invalidation.
- copyFromHandle(source, privateStage): copy from the exact retained source object into a privately created stage; return independently measured digest, length, and stage identity.
- flushFile(handle): flush file data and required metadata according to the declared profile.
- publishNoReplace(parent, staged, finalName): publish only if the destination entry is absent under the adapter's proven atomic primitive. Return published-durable, not-published, or possibly-published; never collapse uncertainty into success/failure.
- renameWithinParentNoReplace(...): perform a same-parent no-replace rename where supported, with explicit identity checks and durability result.
- unlinkOwned(parent, name, expectedIdentity): remove only the exact verified object under a separately authorized cleanup context. A name match is insufficient.
- syncParent(parent): flush the parent namespace where the platform/filesystem contract supports it; report unsupported distinctly.
- closeContext(context): invalidate first, then close every retained handle; aggregate bounded close outcomes and never report clean close if any handle outcome is uncertain.

Every method must check context validity and the held operation guard immediately before its protected action. Asynchronous gaps are prohibited unless the implementation revalidates after every await/cancellation boundary.

## 6. Result and error model

Use stable result categories:

- ok: requested operation completed and its stated postconditions were verified.
- not-performed: operation definitely did not occur.
- conflict: identity, name, sharing, or no-replace precondition failed before mutation.
- unsupported: capability is absent for this exact profile.
- invalid-context: guard, handle, parent identity, or profile was lost.
- possibly-completed: syscall/publication may have taken effect but durable outcome cannot be established.
- io-failure: operation failed with a known bounded failure class.

possibly-completed is terminal for the attempt. Preserve journal and all artifacts, invalidate the context, and require operator review. Never retry a namespace transition based only on a pathname check.

## 7. Platform-specific minimums

### POSIX

A Linux implementation must use directory file descriptors and descriptor-relative operations (for example openat-family operations with no-follow constraints) and compare handle-derived identities. The exact syscall set and filesystem support matrix must be reviewed per kernel/filesystem.

Advisory flock/fcntl locks do not establish exclusion of arbitrary non-cooperating writers. Therefore externalMutationExclusion remains unsupported or unknown unless a distinct, tested mandatory mechanism actually proves the required threat boundary. Rechecking inode, size, timestamps, or digest is detection, not exclusion.

### Windows

A Windows implementation must retain directory and file handles, define reparse-point handling, use handle-derived file identity, and explicitly test share modes against pre-existing and subsequent handles. Rename/delete behavior and directory-entry durability require separate evidence. FILE_SHARE_* behavior is bilateral: a restrictive open cannot retroactively revoke access granted by an existing permissive handle.

The current SQLite share-mode probe is compatibility evidence only. It does not establish stable identity, parent binding, no-replace publication, directory durability, or full Restore crash consistency.

A first Windows native prototype now demonstrates a retained directory handle, a child open relative to that handle via NtCreateFile/RootDirectory with FILE_OPEN_REPARSE_POINT, handle-derived FileIdInfo, and a parent identity recheck on one Windows 11 Pro/NTFS host. An isolated NtSetInformationFile experiment also passes relative RootDirectory no-replace publication and path-substitution/race probes on that host. Microsoft documents FileRenameInformationEx as class 65, available from Windows 10 version 1709, and documents the RootDirectory-relative filename contract; however, the NtSetInformationFile reference is a driver DDI and does not establish a stable supported user-mode application API contract. The local prototype has not been validated against installed WDK headers (no local ntifs.h). Treat this as experimental feasibility only; see docs/WINDOWS-NATIVE-ADAPTER-PROTOTYPE.md. It does not implement production publication, durability, full reparse policy, writer exclusion, or Restore.

## 8. Required adversarial and crash tests

Tests run against disposable directories and child processes on every claimed profile:

- replace source entry after opening while retained handle remains open;
- replace/rename parent after context creation;
- symlink, junction, reparse-point, hard-link, case-folding, and normalization attacks;
- pre-existing writer handle, later writer handle, mapped writer where applicable, and non-cooperating process;
- destination created between absence check and publication;
- staged file swapped between validation and publish;
- failure before syscall, during syscall, after namespace change but before flush, and after flush but before result delivery;
- process termination at every journal/stage/rollback/publish/cleanup boundary;
- disk-full, permission loss, sharing violation, handle-close failure, partial directory enumeration, and unsupported flush;
- power-loss simulation where the test platform can provide a meaningful durability harness.

For every injected failure, assert the exact permitted namespace states, preserved evidence, and absence of unauthorized cleanup. A mock adapter can test application state machines but cannot establish native OS/filesystem guarantees.

## 9. Enablement gates

No profile may be marked eligible until all are true:

- implementation and binding reviewed;
- capability profile scoped to exact OS build/filesystem/mount;
- handle identity and parent binding proven;
- no-follow and namespace race tests pass;
- external mutation threat boundary explicitly accepted or automatic transitions requiring it remain disabled;
- no-replace and durability semantics proven;
- every crash transition has deterministic recovery behavior;
- prior database preservation and rollback are proven;
- cross-process concurrency and fault injection pass;
- independent security review signs off.

Until then, the application must report automatic recovery as unavailable and keep all Restore recovery operator-led.

## 10. Concrete transition fault-injection protocol

The native-adapter test harness must expose deterministic failpoints around each syscall boundary. A failpoint is identified by operation UUID, transition name, and occurrence index; it must never depend on timing or sleeps. Each case runs in a fresh disposable directory and records a before/after inventory by handle-derived identity and content digest.

| Failpoint | Injected condition | Required assertion |
|---|---|---|
| journal-temp-open-before | exclusive create denied | no journal/live mutation; error is not-performed |
| journal-file-flush-before/after | flush fails, or succeeds then close fails | no live mutation; distinguish known flush failure from close-uncertain; retain any temp evidence |
| journal-publish-before | no-replace conflict | existing journal unchanged; no cleanup of unowned entry |
| journal-publish-after-before-parent-flush | link succeeded, parent flush fails/unsupported | possibly-completed; journal and temp evidence preserved; no stage/live mutation |
| stage-copy-midway | read/write/disk-full failure | live and rollback unchanged; partial stage retained or removed only if exact owned identity is proven |
| stage-file-flush-after | file flush succeeded but handle close/result fails | no live namespace mutation; classify stage durability as uncertain; preserve journal/evidence |
| rollback-link-after | rollback link succeeded before parent flush | both original and rollback names may exist; do not unlink either on uncertainty |
| original-unlink-after | original unlink succeeded before parent flush | rollback identity and journal remain; destination absence is not treated as durable |
| live-publish-after | staged link succeeded before parent flush | live and rollback may both exist; possibly-completed; no automatic rollback selection |
| stage-unlink-after | stage unlink succeeded before parent flush | preserve journal/rollback; report cleanup ambiguity, not completed cleanup |
| rollback-unlink-after-compensation | redundant rollback unlink succeeded before parent flush | restored live identity is verified; compensation durability remains uncertain until parent flush succeeds |
| journal-unlink-after | journal unlink succeeded before parent flush | operation result remains possibly-completed; never recreate or silently assume durable journal removal |
| parent-flush-close-after-fsync | directory fsync succeeds but closing its handle fails | report a distinct close/cleanup uncertainty; do not flatten into a generic durable success |

For each row, run (a) injected syscall failure before mutation, (b) successful namespace mutation followed by flush failure, (c) successful flush followed by result-delivery/process termination, and (d) unsupported capability. Verify the resulting state with a fresh process and fresh handles. The oracle must distinguish namespace visibility from crash durability.

### Current Node implementation caveat

The existing syncDirectory helper's POSIX finally-close can itself throw after fsync returned successfully. In that case callers receive an exception although the namespace flush syscall completed; this is another possibly-completed outcome that the current helper does not encode. On Windows it returns unsupported rather than throwing, and the current Backup/Restore call sites do not inspect the result. Backup temporary-directory removal helpers also call syncDirectory and inherit the same platform limitation. These are explicit adapter migration items, not evidence of a tested durability guarantee.

### Windows native publication result policy

For an issued native rename call, default to possibly-completed. Clear that classification only for a precisely documented and tested result that proves no namespace mutation; the current experimental Windows prototype recognizes only STATUS_OBJECT_NAME_COLLISION as such. All other immediate failures, pending results, and non-success completion statuses remain ambiguous until a fresh handle-based inventory proves the state. Preflight rejection before issuing the syscall is not-performed. Never infer not-performed merely from a negative NTSTATUS without a platform-specific guarantee.


### Windows native disposition result policy

For SetFileInformationByHandle(FileDispositionInfo), retain not-performed only for failures detected before the disposition API boundary (including invalid context, parent mismatch, identity mismatch, and handle validation failure). Once the API call is about to be issued, default to possibly-completed; a FALSE return and its GetLastError() value are diagnostic evidence, not an automatic retry or cleanup grant. Narrow this only when the exact supported API/filesystem profile has authoritative semantics proving a particular error is non-mutating and a corresponding test. The current prototype intentionally recognizes no post-boundary Win32 error as definitely not-performed. A successful call followed by failed postconditions is also possibly-completed. Preserve the handle and journal/evidence for operator review; never retry by pathname alone.

### Windows native flush and close result policy

A handle-bound FlushFileBuffers operation must validate the expected object identity before issuing the flush. Once the flush API is issued, default to possibly-completed; a failed return or failed postcondition is not a retry/cleanup grant. Clear ambiguity only after a successful API return and the required postconditions. Preserve the raw Win32 error and identity evidence. A successful CloseHandle is a resource-lifetime event, not a durability primitive; it cannot replace FlushFileBuffers. A failed CloseHandle is tracked separately as handle-lifetime uncertainty and must not be conflated with the result of an earlier flush. Do not infer power-loss durability from a successful FlushFileBuffers on one host/filesystem; the accepted durability profile still requires platform/filesystem-specific evidence and crash testing.
