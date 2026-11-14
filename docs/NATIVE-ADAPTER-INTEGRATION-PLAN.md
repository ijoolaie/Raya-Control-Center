# Native Adapter Integration Readiness

Status: Phase 6 planning artifact. No native binding is implemented, loaded, or enabled by this document.

## Decision

Do not connect the current Windows C++ prototype to production Restore yet. The prototype is a standalone executable compiled and run by a PowerShell script; it is not a Node addon, does not expose a stable C ABI, and does not return the contract's structured capability profile/result model to JavaScript. The production Restore path remains synchronous, path-based Node.js filesystem code. A thin wrapper around the current executable would not close the identity or race gaps and must not be represented as an adapter.

The next integration increment should be a separately built, opt-in Node-API addon behind an explicit adapter factory, initially exposing read-only operations only. Mutation methods remain unavailable until the read-only bridge, lifecycle, packaging, and adversarial tests are accepted.

## Current boundary observed in the repository

| Area | Production JavaScript | Windows prototype | Integration gap |
|---|---|---|---|
| Parent namespace | Paths, `resolve`, parent checks, directory names | Retained directory HANDLE and FileIdInfo | No opaque native context crosses into Node |
| Child open / identity | `lstat`, path reopen, device/inode snapshots | RootDirectory-relative native open; handle-derived volume/FileId | Production identity is not handle-bound |
| Enumeration | `readdirSync` plus path-based `lstat` and revalidation | `GetFileInformationByHandleEx`, bounded record parser, entry tokens | No native complete-inventory result consumed by Inspector |
| Read / hash | Path-based copy/read and JavaScript validation | Handle-bound bounded read and SHA-256 via CNG | No same-handle source-to-stage copy API in a Node binding |
| Flush | `syncDirectory` uses POSIX open/fsync; Windows returns unsupported | File FlushFileBuffers; directory flush probe observed on one host | Windows directory flush remains unsupported in production; prototype observation is not an accepted durability contract |
| Publish / unlink | Path-based hard links and unlink/rename helpers | Experimental NtSetInformationFile relative no-replace; identity-bound disposition | No supported user-mode API guarantee, no JS result semantics |
| Lifecycle | Synchronous JS functions | HANDLE ownership inside a standalone process | No Node-API lifetime/finalizer/exception/cancellation contract |
| Build / release | Package declares Node >=24.15, no native addon build/dependency | Manual MSVC compile in a PowerShell probe | No reproducible addon build, install packaging, ABI or CI artifact strategy |

Relevant production entry points include `inspectDatabaseRestore`, `buildRestoreArtifactInventory`, `readRestoreJournal`, and the internal Backup/Restore helpers in `src/database-maintenance.js`. `src/file-system-durability.js` currently reports Windows directory sync as unsupported. Current Backup/Restore call sites do not turn that unsupported result into a hard failure, which must be addressed before any durability claim.

The native prototype currently demonstrates a useful experimental surface: `openRoot`, `openChildReadOnly`, `enumerateChildren`, `readAndHash`, `flushFile`, `closeOwned`, `publishNoReplace`, `unlinkOwned`, and a directory-flush feasibility probe. The directory-flush probe is explicitly not an accepted durability guarantee. The native rename route uses a dynamically resolved NT syscall and remains experimental; the tested Win32 relative-root wrapper failed on the current host.

## Binding choice

Prefer Node-API (N-API) over direct V8 APIs or a subprocess protocol:

- N-API offers a stable C interface across supported Node releases and avoids binding directly to a particular V8 version.
- Keep all raw HANDLE values and native identity structures inside the addon. JavaScript receives opaque context/entry objects and immutable, bounded snapshots only.
- Use explicit `close()` and invalidation; finalizers are leak containment, not the correctness path.
- Do not allow JavaScript to manufacture or alter identity tokens.
- Expose synchronous calls for the first slice to match the current synchronous maintenance flow. If asynchronous work is introduced later, every await/cancellation boundary must revalidate context and reservation ownership.
- Return tagged result objects matching the contract: `ok`, `not-performed`, `conflict`, `unsupported`, `invalid-context`, `possibly-completed`, and `io-failure`. Preserve bounded raw platform status fields for diagnostics without exposing arbitrary OS strings to operational logs.
- The addon must not acquire SQLite locks. The caller acquires the full reservation set and passes an opaque, validated operation token; the addon checks that token before every protected action.

A child-process JSON bridge is not an acceptable production substitute: it would add serialization and process-lifecycle failure modes, make retained HANDLE ownership awkward, and still require a carefully versioned protocol. It may be used for test orchestration only.

## Staged implementation plan

### Stage A — binding skeleton, no filesystem mutation

1. Add a small N-API addon target and deterministic local build script for the supported Windows toolchain.
2. Export only `getBuildInfo()` and a conservative capability profile; all mutation capabilities must be `unsupported` or `unknown`.
3. Add an explicit opt-in loader. Normal application startup and existing Backup/Restore/Inspector behavior must not load the addon.
4. Test Node 24 and 26 on Windows CI, addon load failure, wrong architecture, missing binary, repeated load/unload, and bounded error reporting.
5. Do not include the compiled binary in source control. Decide later whether release packaging builds per target or publishes prebuilt binaries.

Exit gate: reproducible clean build and test matrix; no production behavior change.

### Stage B — read-only retained-handle slice

Expose only:
- open trusted parent;
- enumerate bounded children;
- open one enumerated child token;
- return handle-derived identity and kind;
- read/hash through the retained child handle;
- close/invalidate context.

Add tests for parent rename/replacement, child path replacement, malformed enumeration, duplicate names, partial enumeration, symlink/reparse handling, handle leaks, context reuse after close, and concurrent namespace churn. Inspector may consume this result only behind an explicit opt-in diagnostic flag, while retaining its current path-based report and clearly distinguishing native evidence from path observations.

Exit gate: all read-only tests pass on each claimed OS/filesystem profile; capability profile remains scoped to exact host evidence. No cleanup or namespace transition is exposed.

### Stage C — staged copy and file durability

Add exclusive private-stage creation, copy-from-retained-handle, independent stage hashing, file flush, and explicit close outcomes. Test disk-full, short writes, read failures, same-size concurrent source writes, handle-close failure injection, and process termination at each boundary. A successful hash must be bound to the exact source and stage handles used by the operation.

Exit gate: source/stage identity and digest continuity proven; no live database mutation.

### Stage D — namespace mutation primitives, still not wired to Restore

Only after independent review, expose no-replace publication and identity-bound unlink as separate operations with conservative ambiguity. Do not ship the experimental NT syscall as a supported production primitive without a documented compatibility/security decision. Do not substitute path-based Win32 rename or copy-delete fallback. Parent namespace durability must have a separately accepted platform/filesystem contract; a successful local probe alone is insufficient.

Exit gate: deterministic pre-/post-syscall fault injection, cross-process races, exact ambiguity classification, and accepted durability evidence.

### Stage E — application integration proposal

Refactor Backup/Restore behind an injected filesystem adapter interface only after Stages A-D pass. Keep current path-based adapter explicitly marked non-eligible for automatic recovery. Native adapter must be selected by exact capability profile, not merely `process.platform`. Every unsupported/unknown capability fails closed. Inspector remains read-only; automatic executor stays disabled until all Phase 6 acceptance gates and independent security review pass.

## Immediate next task

Implement Stage A only: a minimal N-API build/load proof that reports build metadata and an all-disabled capability profile. Before coding, verify the installed Node 24/26 headers/toolchain and choose a build approach that can run in CI without adding a runtime dependency. Keep the native filesystem methods out of the binding until Stage B. If the local environment cannot reproduce the build, add the CI build first and do not claim local validation.

## Non-goals and safety boundary

- No Automatic Restore enablement.
- No mutation methods exposed during Stages A or B.
- No path-based fallback for native operations.
- No assumption that Windows 11/NTFS behavior generalizes to other Windows builds, filesystems, SMB, cloud-sync folders, or storage devices.
- No power-loss durability claim from process-crash tests or successful local FlushFileBuffers probes.
- No commit, push, Phase 5 work, or destructive cleanup is authorized by this plan.
