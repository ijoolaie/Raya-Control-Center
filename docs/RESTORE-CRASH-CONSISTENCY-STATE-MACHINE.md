# Restore Crash-Consistency State Machine

Status: Phase 6 design and test-oracle artifact. This document describes the current application-level Restore implementation; it does not claim native filesystem guarantees and does not authorize automatic recovery.

## Scope and evidence boundary

The implementation described here is in `src/database-maintenance.js` (`createRestoreJournal`, `restoreDatabaseBackupUnlocked`) and its fault-injection coverage is in `test/database-maintenance.test.js` plus `test-support/restore-fault-worker.js`.

The current protocol uses path-based Node filesystem operations, SQLite reservation transactions, file hard links, file fsync, and directory fsync where supported. SQLite reservations coordinate cooperating Control Center processes only. Path checks and current file identity snapshots do not bind operations to retained native handles and do not exclude arbitrary external writers.

The state machine is therefore an application-level model for inspection, testing, and operator guidance. It is not a proof of power-loss atomicity on every filesystem, and it is not an authorization model for an automatic recovery executor.

## Artifact roles

For a destination database `D`, selected backup `S`, operation journal `J = D.restore-journal.json`, staged snapshot `T`, and rollback candidate `R`:

- `S`: selected backup; must be a regular file and pass snapshot validation.
- `J`: published intent record, version 1, containing source, destination, temporary, and rollback paths.
- `T`: private staged copy named beside `D`; it is validated and flushed before installation.
- `R`: no-replace hard-link name for the original destination, retained as rollback evidence after successful installation.
- `D`: live destination path.

The journal currently records paths and operation metadata, not stable native file identities, content digests, directory-entry identities, or an explicit durable phase field. Phase must not be inferred from journal presence alone.

## Forward state machine

| State | Operation / boundary | Expected artifacts | Crash or failure disposition |
|---|---|---|---|
| F0 â€” Preflight | Acquire ordered source/destination reservations; validate source, destination, parent path, WAL/SHM absence, no prior journal, and no orphan staged files | No new Restore artifacts | Abort before intent publication; preserve pre-existing evidence |
| F1 â€” Journal temporary | Create exclusive journal temp, write complete record, fsync file | Journal temp may exist; `D` unchanged | Unpublished temp is evidence; inspector inventories and preserves it |
| F2 â€” Intent published | Hard-link journal temp to `J`; sync parent directory; remove temp name and sync parent | `J` exists; `D` unchanged | A crash may leave both `J` and journal temp hard link; preserve both |
| F3 â€” Stage copy | Copy `S` to `T` with exclusive creation; compare source identity snapshot before/after | `J`, possibly partial or complete `T`; `D` unchanged | Preserve journal and any staged artifact; never infer validity from existence |
| F4 â€” Stage validated and flushed | Restrict permissions; validate exact `T`; fsync staged bytes | `J`, valid flushed `T`; `D` unchanged | Before live namespace mutation, an ordinary caught failure may remove owned `T` and `J`; process crash leaves evidence |
| F5 â€” Rollback name published | If `D` exists, hard-link `D` to unique `R` without replacement | `D`, `R`, `T`, `J` | Crash here leaves both `D` and `R`; authority is ambiguous; preserve all |
| F6 â€” Original name removed | Unlink `D`; sync parent directory | `R`, `T`, `J`; `D` absent | Original bytes remain at `R`; do not assume install is safe to retry without native identity and operation binding |
| F7 â€” New live name published | Hard-link `T` to `D` without replacement; sync parent directory | `D`, `R`, `T`, `J` | Crash after publication but before verification/cleanup leaves both live and rollback; treat as ambiguous |
| F8 â€” Temporary cleanup | Remove `T`; sync parent | `D`, `R`, `J` | Crash leaves installed live plus rollback and journal; preserve |
| F9 â€” Journal cleanup | Unlink `J`; sync parent | `D`, `R` | If journal removal or its directory sync fails, report cleanup warning; rollback remains retained |
| F10 â€” Returned success | Return metadata and retained rollback path | `D`, `R`; no `J` or `T` expected | A later crash can still expose filesystem-specific durability questions; success does not prove external writers were excluded |

If the destination did not exist at F0, the rollback publication/removal states are skipped; staged installation still uses no-replace publication. This branch does not weaken the requirement to preserve ambiguous artifacts.

## Caught-error compensation

The current function attempts compensation only while the current process is alive:

1. Remove the staged temporary if this invocation created it.
2. If the original destination name was removed and installation was not published, recreate `D` from `R` using no-replace hard-link publication and sync the parent.
3. Remove the redundant `R` name only after the restored `D` name has been synced.
4. Remove `J` only when installation did not publish and rollback was either never published or was successfully restored.
5. If rollback fails, or a concurrent destination blocks restoration, preserve `R` and `J` and surface an error.

This compensation is not run after process termination or power loss. The `journalCreated` flag is set only after `createRestoreJournal` returns: if journal hard-link publication succeeds but its parent-directory sync (or subsequent journal-temp cleanup) throws inside that helper, the outer compensation does not consider the journal owned/created and may leave the published journal for inspection. After the flag is set, the catch path may remove the journal only when installation was not published and rollback was never published or was successfully restored. Silent cleanup failures are not evidence that cleanup succeeded. A failure after install publication must not trigger restoration of the old database by this catch path.

## Recovery classification crosswalk

The read-only inspector observes paths, journal parse/shape, artifact inventory, and SQLite lock state. It does not establish file authority or validate the live database as part of state classification.

A real child-process termination boundary now also exists immediately after the staged Restore file's `fsync` returns successfully: the worker calls the operating-system `fsync` on the staged file descriptor and exits without running JavaScript cleanup. The parent then runs the read-only Inspector against the same disposable directory and asserts the published journal, live database, and staged file remain inventoried, with `automaticAction: none`. This proves the process-level ordering on the test host; it does not prove persistence across power loss, controller caches, filesystem bugs, or storage-device failure.

Process-crash/Inspector integration is now asserted at the two previously less-directly-covered boundaries: (1) after the original live name is removed but before the staged snapshot is installed, the inspector reports `live-missing-rollback-present`, observes the rollback and staged temporary, and performs no action; (2) after the new live name is installed, the inspector reports `live-and-rollback-present-ambiguous`, observes both database copies and the staged temporary, and performs no action. Both tests snapshot every directory entry and its bytes before inspection and assert byte-for-byte and name-for-name preservation afterward. These are child-process termination tests on disposable local files, not power-loss or native-handle tests.

| Observed condition | Current classification family | Required disposition |
|---|---|---|
| No journal, no lock, complete inventory, no recovery artifacts | `no-pending-restore` | Informational only; not an integrity check |
| No journal but lock exists or lock inspection is unknown | `no-pending-restore-lock-*` | Warning; do not infer stale owner |
| No journal but rollback, staged file, or journal temp exists | `no-journal-recovery-artifacts-present` | Preserve; manual review |
| Journal missing/invalid/malformed/unreadable | `manual-review-invalid-journal` | Critical; preserve all artifacts |
| Valid journal and lock present/unknown | `blocked-lock-present` / `manual-review-lock-state-unknown` | Do not act until all users are independently verified stopped |
| Valid journal, complete inventory, but a recorded source/live/stage/rollback path cannot be inspected | `manual-review-artifact-state-unknown` | Preserve evidence; do not treat an unknown path as absent |
| Valid journal, incomplete or unstable inventory | `manual-review-artifact-inventory-incomplete` | Preserve evidence; do not infer that unlisted artifacts are absent |
| Valid journal, live absent, rollback present | `live-missing-rollback-present` | Preserve; validate a separate copy and require operator selection |
| Valid journal, live and rollback both present | `live-and-rollback-present-ambiguous` | Preserve and compare; do not infer authority |
| Valid journal, neither live nor rollback present | `live-and-rollback-missing` | Manual investigation |
| Valid journal, live present, rollback absent | `live-present-no-rollback` (or temporary-present variant) | Warning/critical context; verify a copy, do not infer unchanged or valid |

Every current classification has `automaticAction: 'none'`. Artifact presence, timestamps, PID, and SQLite lock paths are not sufficient to select a database or authorize namespace mutation.

## Fault-injection acceptance matrix

Existing isolated tests in `test/database-maintenance.test.js` and `test-support/restore-fault-worker.js` exercise these application-level boundaries:

| Fault point | Existing test evidence | Required invariant |
|---|---|---|
| Before journal publication / journal temp crash | Unpublished fsynced journal temp test | Live database unchanged; temp preserved and inventoried |
| Immediately after journal publication | Journal publication crash test | Journal remains valid; any temp hard link is inventoried |
| After stage copy / before original move | Crash-boundary tests | Live database unchanged; staged bytes are not silently discarded |
| Rollback link published | Rollback-link crash test | Original and rollback names both remain; state is ambiguous |
| After original name removed, before install | Crash-gap test | Original bytes remain at rollback path; retry blocked by journal |
| Install publication | Post-install crash test | New live and old rollback both remain; no automatic selection |
| Temporary and journal cleanup | Cleanup crash-boundary tests | Rollback retained; orphan artifacts inventoried |
| Rollback compensation fails | Rollback-failure test | Original rollback bytes and journal remain discoverable |
| Concurrent destination appears | Destination-race test | Never overwrite the concurrent destination; preserve original rollback and journal |
| File fsync fails before live mutation | Staged-copy fsync test | Original live database remains unchanged |
| Directory fsync failures | Directory-sync boundary tests (POSIX-only in current suite) | Outcome follows the observed boundary; no false success claim |
| Journal/temp cleanup fails after install | Cleanup-failure test | Report warnings and retain rollback evidence |

These tests use disposable fixtures and injected process-level faults. They do not simulate real power removal, storage-controller cache loss, filesystem journal replay, kernel bugs, remote filesystem semantics, or arbitrary concurrent native handles.

## Gaps before native recovery can be considered

- Journal v2 must bind an operation identifier, artifact roles, stable identities, sizes/digests, and explicit phase/transition evidence to the same native operation context.
- Every path operation must be replaced or constrained by a native adapter using retained parent/file handles, no-follow semantics, same-object checks, no-replace publication, and explicit durability results.
- The adapter must define external writer capability and fail closed when required exclusion cannot be proven.
- Crash testing must cover native transitions and power-loss/reboot behavior on each explicitly supported OS/filesystem/volume profile.
- Recovery evaluation must be read-only, one-shot, bound to fresh evidence and reservation/handle context, and invalidated by any changed observation.
- Unknown, stale, conflicting, or possibly-completed outcomes remain operator-led. No automated deletion, rename, rollback selection, or journal cleanup is permitted.

## Current decision

This state machine and its crosswalk are documentation/test-oracle work only. The existing inspector remains read-only. Automatic Restore Recovery remains disabled and ineligible on all currently tested profiles. Phase 5 remains deferred. No production database or operational data is modified by this document.

## Transition-to-durability matrix (source review, 2026-11-13)

This matrix describes the current Node implementation, not the proposed native adapter.

| Transition | File-content flush | Namespace operation | Parent-directory flush | Error / ambiguity behavior |
|---|---|---|---|---|
| Journal temp creation and write | Journal descriptor is fsync'ed before close | Exclusive create (wx) | None yet | Write/fsync/close errors abort; temp may remain and is treated as evidence |
| Journal publication | Already-flushed temp inode | linkSync(temp, J) (no replace) | syncDirectory(parent) | POSIX flush error throws after J may already exist; helper finally tries to unlink temp and flush parent again. On Windows supported:false is returned and ignored |
| Journal temp-name cleanup | Not applicable | unlinkSync(temp) | syncDirectory(parent) | A non-ENOENT unlink/flush error escapes helper; caller journalCreated remains false even if J was published |
| Stage creation/copy | copyFileSync, validation, then syncFileContents(T) (fsync on opened file) | Exclusive destination creation | None at stage creation | File flush failure occurs before live namespace mutation; Windows file fsync does not imply directory-entry durability |
| Rollback-name publication | No additional content flush; hard link references existing destination inode | linkSync(D, R) | Not immediately after link | Crash before later parent sync can leave D and R; caller flag is set after link returns |
| Original live-name removal | No additional content flush | unlinkSync(D) | One syncDirectory(parent) after rollback link and unlink | POSIX sync error enters compensation after namespace may already have changed. Windows directory flush is skipped |
| New live-name installation | Stage bytes were previously fsynced | linkSync(T, D), no replace | syncDirectory(parent) | POSIX sync failure occurs after D may exist; installPublished is already true, so old DB is not automatically restored. Windows proceeds without directory flush |
| Stage-name cleanup | Not applicable | rmSync(T) | syncDirectory(parent) | Cleanup failure becomes a warning; installed live and rollback evidence are retained |
| Journal-name cleanup | Not applicable | unlinkSync(J) | syncDirectory(parent) | Failure becomes a cleanup warning; journal may remain after installation completed |
| Compensation: restore D from R | Original bytes remain in rollback inode | linkSync(R, D) | syncDirectory(parent) | If link or flush fails, compensation throws and preserves rollback evidence |
| Compensation: remove redundant R | Not applicable | unlinkSync(R) | No immediate parent-directory flush in current code | Later journal cleanup attempts a parent flush only if reached; this is not a dedicated durability boundary for rollback removal |
| Compensation: remove J | Not applicable | unlinkSync(J) | syncDirectory(parent) | Errors are swallowed; cleanup success is not established |

### Platform interpretation and review findings

- On POSIX, syncDirectory opens the directory read-only, calls fsync on that descriptor, and closes it. Open/fsync errors throw (close is attempted in finally). The suite has injected-failure coverage and a real disposable-directory check on non-Windows hosts; this Windows host cannot execute the real POSIX check.
- On Windows, the helper returns supported:false without opening or flushing a directory handle. Current Restore and Backup callers ignore the return value. Their control flow therefore does not distinguish a successful directory flush from an unsupported one. The Windows share-mode probes do not test or remedy this gap.
- File fsync of the journal and staged database is distinct from persistence of their directory entries. Neither a successful file flush nor successful Win32 share-mode exclusion proves that a new link, unlink, or rename survives power loss.
- Rollback publication and original-name removal currently have no separate directory flush between the two namespace operations; one flush follows both. A crash in between is an intermediate state, not a transaction.
- Compensation flushes the restored destination name before removing the rollback name, but does not explicitly flush the parent immediately after removing that rollback name. This is a concrete ordering gap for a future durability contract.
- The implementation does not return a structured possibly-completed outcome for a namespace syscall that succeeds but whose following directory flush fails. Callers infer progress from in-memory booleans set after namespace syscalls; process crash or uncertain native results are outside that model.
- Since unsupported directory flush is non-fatal, current Windows behavior is directory-entry durability unverified, not a successful durable Restore. Do not use the current Node path implementation as evidence for Windows automatic recovery.

### Journal temporary before publication: newly covered crash boundary

A child-process test now exits after the journal temporary file has been written, file-flushed, and closed, but before its no-replace link to the published journal path. In this state the live database remains in place, the published journal is absent, and a UUID-named journal `.tmp` artifact remains. The read-only Inspector inventories that artifact and classifies the directory as `no-journal-recovery-artifacts-present`; it does not infer that no recovery evidence exists.

The regression test initially found that a subsequent Restore attempt checked orphaned staged database files but did not block on orphaned journal temporary files. The preflight now rejects those UUID-shaped journal `.tmp` entries without deleting them. This is a fail-closed guard, not a recovery action. It closes the tested retry gap but does not prove file/directory power-loss durability or protect against non-cooperating external namespace mutation.

### Required native-adapter follow-up

1. Make every namespace mutation return an explicit operation result plus durability result (durable, unsupported, failed, or possibly-completed); callers must not silently ignore unsupported.
2. Give rollback publication and original unlink separate explicit parent-directory durability boundaries, or use a single native transaction primitive with documented and tested crash semantics.
3. Flush the parent after removing the redundant rollback name, before declaring compensation complete or removing its journal.
4. Treat a successful namespace syscall followed by failed/unsupported parent flush as ambiguous and preserve all evidence; do not report durable success.
5. Add platform-specific tests for file and directory handles, reboot/crash recovery, and storage durability on each supported filesystem profile. Unit tests and process-exit tests remain necessary but insufficient.

### Crash-boundary classifier crosswalk regression (2026-11-14)

Added a table-driven test in `test/database-maintenance.test.js` mapping documented Restore crash boundaries to the current intentionally coarse diagnostic classifier. The cases include unpublished journal temporary, published journal with temporary alias, staged copy, rollback publication, original-name removal, install publication, stage cleanup, journal cleanup, destination-missing branch, source missing, incomplete inventory, unknown/present locks, and malformed journal.

Every row asserts its expected coarse state, non-empty operator guidance, and `automaticAction: none`. This test is a consistency check between the documented state machine and the current classifier; it does not make the classifier a complete crash-boundary recognizer, prove artifact identity/inventory completeness, or authorize any recovery operation.

### Journal v2: explicit operation and artifact identifiers

New Restore operations now publish Journal schema version 2. One immutable `operationId` is reused as the filename token for the Journal temporary, staged file, and rollback artifact. The record also carries explicit `journalTemporaryId`, `temporaryId`, and `rollbackId` fields; the Inspector requires all three to equal `operationId` and verifies the staged/rollback path tokens against it. This establishes exact logical name correlation for newly created artifacts, but not native object identity, complete directory inventory, or proof of ownership. Version 1 journals remain inspectable under their legacy shape rules so existing interrupted operations are not stranded.

The Restore crash-boundary tests now assert that emitted v2 journal identifiers are well-formed and that the staged and rollback artifact names match their role-specific IDs. This is metadata binding only: it does not prove native file identity, artifact contents, namespace continuity, or durability, and it does not authorize recovery. The Inspector remains read-only and every classification retains `automaticAction: none`.
