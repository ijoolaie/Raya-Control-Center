# Phase 6 Ã¢â‚¬â€ Deferred Capability Closure: Acceptance Plan

**Status:** In progress; operator authorization received 2026-11-12. Workstream 1 (Structured Operational Logs) is Verified; Workstream 2 (Automatic Restore Recovery) is in design/feasibility review.
**Parent plan:** `docs/ROADMAP.md`.
**Boundary:** Phase 5 remains Deferred. This plan does not authorize remote binding, tunnels, proxies, port forwarding, external repository changes, or arbitrary code execution.

Phase 6 closes the Deferred inventory recorded when it was added. A workstream is closed only when its design, implementation, regression/failure-mode tests, and operator documentation are complete. Re-labeling an item is not closure.

## 1. Structured operational logs (carried from Phase 2)

### Current baseline
- The application currently emits a small number of human-readable startup, shutdown, lease-reconciliation, and maintenance messages.
- CLI JSON/stdout responses and one-time credential displays are command interfaces, not operational logs; they must remain separate.
- No shared structured operational event schema was established at Phase 6 start; the initial implementation is tracked below.

### Required design
- Use a versioned schema with a fixed event-name allowlist and per-event field allowlists.
- Minimum envelope: schema version, event name, UTC timestamp, severity, process instance identifier, and a bounded correlation/operation identifier where available.
- Event-specific fields must be typed, bounded, and non-sensitive. Prefer counts, enums, durations, and opaque operation identifiers over user-controlled strings.
- Never log Operator/Participant/Lease tokens, credential hashes, authorization headers, request bodies, Task payloads/results, raw exception objects, arbitrary URLs/userinfo, or unrestricted filesystem contents.
- Error reporting must map failures to bounded error codes/categories. Do not serialize stack traces or error messages unless a separately reviewed sanitizer proves they contain no secrets or user data.
- Define output destination, encoding, maximum event size, behavior when the sink fails, and operator retention/rotation responsibilities. Logging failure must not silently change task/lease/authorization outcomes; security-critical failure behavior must be explicit.
- Keep CLI contract output and one-time secret output out of the operational logger.

### Initial implementation (2026-11-12)
- `src/operational-logger.js` implements schema version 1 with a fixed event allowlist, exact per-event field allowlists, typed values, UTC timestamps, severity, process-instance UUID, and event UUID.
- Events cover server start/startup failure/shutdown, lease reconciliation, Backup/Restore completion/failure/inspection, and Operator token recovery outcomes. Event fields are restricted to a listener port, bounded counts/schema version, booleans, fixed journal-status enums, or bounded error codes; raw error messages and exception objects are never serialized.
- Records are UTF-8 NDJSON written to stderr and capped at 2 KiB. The logger accepts at most 100 events per event name and 1,000 events per process. Invalid, unknown, or over-limit events are dropped.
- Sink write exceptions are contained and events dropped; logging does not change task, lease, authorization, or shutdown outcomes. CLI stdout/JSON and one-time token display remain separate.
- Retention and rotation belong to the local process supervisor/terminal capture policy. The application creates no log files and performs no rotation. Protect captured stderr as operational data; avoid transcript capture of the separate one-time credential display.
- Completion verification (2026-11-12): focused logger/maintenance CLI tests pass; aggregate process and per-event ceilings, maximum record size, malformed values, allowlist rejection, secret sentinels, sink/clock failures, and real child-process behavior are covered. Full suite: 177 passed, 4 skipped, 0 failed. npm run check and git diff --check pass. GitHub CI and security scans pass on Node 24/26 Windows/Linux, CodeQL, and Gitleaks for commit 078e63a11046e0ced158157e9c3d5bd84d038f46.

### Acceptance evidence
- Unit tests reject unknown event names and unknown fields.
- Redaction tests inject token-shaped values, authorization headers, task payload/result sentinels, URL userinfo, and exception messages; none may appear in emitted records.
- Bounds tests cover oversized strings, invalid enums, excessive event frequency/cardinality, and malformed values.
- Child-process tests verify startup/shutdown and lease-reconciliation events without leaking the bootstrap token.
- Documentation specifies schema evolution, destination, retention, sink failure behavior, and how operators collect diagnostics safely.

## 2. Automatic Restore Recovery (carried from Phase 2)

**Workstream status:** Design/feasibility review in progress. Do not enable a recovery executor or automatic file/lock action until the feasibility and acceptance gates below pass; current inspector remains read-only and all states remain operator-led.

### Current baseline
- Restore publishes a versioned intent journal atomically and refuses a second Restore while the journal exists.
- A read-only inspector inventories journal, lock, live, temporary, and rollback artifacts and classifies observed combinations.
- Runtime/maintenance ownership uses SQLite `BEGIN IMMEDIATE` reservations; a persistent sidecar's existence alone does not prove a live owner.
- Crash-injection coverage already exercises journal publication, staging, rollback publication/original move, installation, temporary cleanup, and journal cleanup.
- The current classifier intentionally returns `automaticAction: none` for every state. It is diagnostic, not a recovery executor.

### Source-derived crash transition matrix (design baseline; not an implementation authorization)

The current Restore sequence in `src/database-maintenance.js` is ordered as follows. The table describes the durable names that may be observed after process death; it does not assert that any observed file is authoritative or safe to install.

| Boundary / operation | Possible observed names after interruption | Required recovery interpretation |
|---|---|---|
| Journal temp created/written/flushed, before journal hard-link publication | Journal absent; UUID `.tmp` may be absent or present, possibly partial | No published intent is proven. Preserve any temp file; do not infer that Restore did or did not proceed from its absence. Manual review if any unexpected artifact exists. |
| Journal hard link published, before temp unlink | Journal and journal `.tmp` both present; both names may refer to the same file object | Published intent exists if the journal independently validates. Preserve both names; only remove the temp alias after identity is verified and exclusive ownership is proven. |
| Journal temp unlink and directory sync complete | Journal present; journal temp absent | Intent is published. No staged database is implied yet. |
| Staged copy created, while copy is in progress | Journal present; temporary `.restore` may be partial or absent | Preserve staged file. Never install it based on path existence. Validate exact staged bytes and match them to a durable content identity before any continuation. |
| Staged copy completed, source identity rechecked, SQLite validation and file flush complete | Journal + staged file; live destination may still exist; rollback absent | Candidate is prepared, but this state alone does not authorize replacement. Recheck source/staged identity, integrity, trusted paths, and exclusive ownership. |
| Rollback hard link published, before original destination unlink | Journal + staged file + live destination + rollback name | Live and rollback may be two names for the same original file object. Do not treat this as an already-moved original or delete either name without identity proof. |
| Original destination unlinked, before directory sync | Journal + staged file + rollback; live destination absent | Rollback name should preserve the original object, but the namespace transition's durability may be uncertain. Verify rollback identity/content and filesystem durability semantics; otherwise manual review. |
| Original removal and directory sync complete | Journal + staged file + rollback; live absent | This is the intended pre-install state. Install only if staged bytes and rollback identity match the journal and destination remains absent under exclusive ownership. |
| Staged hard link published at destination, before directory sync | Journal + staged file + rollback + live destination | Live and staged may be the same file object. Publication durability is uncertain until the directory sync succeeds. Do not repeat publication blindly; verify identities and fail closed if uncertain. |
| Install directory sync complete | Journal + live destination + rollback; staged name may still exist | New destination publication completed at the API level. Verify live bytes against the staged object and preserve rollback until cleanup policy is proven. |
| Temporary unlink, before/after directory sync | Journal + live + rollback; staged name may be present or absent | Cleanup may be incomplete or durability uncertain. Cleanup is not permission to delete rollback. |
| Journal unlink, before/after directory sync | Journal may be present or absent; live and rollback may remain | Journal absence is not proof that rollback is disposable. Verify installed database and preserve rollback according to the documented retention/backup policy. |
| Exception path before installation, with rollback not published or safely restored | Journal may be removed; live may remain; staged temp may be removed | A caught exception path is distinct from process-crash recovery. If journal removal or cleanup failed, inspect all artifacts; never assume cleanup succeeded. |
| Exception path after rollback publication where original cannot be safely restored | Journal retained; rollback present; live may be absent or concurrently occupied | Manual review. Preserve journal and every candidate; no automated overwrite or rollback rename. |

Additional interpretation constraints:

- The journal currently records version, operation, PID, timestamp, and four paths. It does **not** record a cryptographic digest, stable file-object identity, source/staged content binding, or a durable transition marker. The current schema is therefore insufficient to authorize automatic continuation or rollback.

### Journal v2 evidence contract (proposed; design only)

Journal v2 should be an immutable intent record published before any destructive namespace transition. Its minimum logical content should be:

| Field group | Required evidence | Purpose and limits |
|---|---|---|
| Envelope | Exact schema version, operation identifier (UUID), operation kind, UTC creation timestamp | Reject unknown versions/operations; operation ID binds all artifact names to one attempt. PID is diagnostic only, never an ownership proof. |
| Paths | Canonical absolute source, destination, staged, and rollback paths; expected parent identity/trust boundary | Prevent path substitution and cross-directory ambiguity. Re-resolve and revalidate every path at recovery time; stored paths are not authority. |
| Source content | Digest algorithm identifier (initially SHA-256), byte length, digest of source bytes captured from a stable opened file | Binds the requested backup content. Capture from an opened handle and verify file identity/metadata before and after hashing; abort if it changes. |
| Staged content | Expected byte length and digest, equal to the validated source content digest | Proves the exact staged bytes match the selected source. Re-hash staged bytes during recovery; SQLite integrity/schema checks remain separate requirements. |
| Original/rollback content | Whether a live destination existed at intent time; if so, its byte length and SHA-256 digest captured before publishing the rollback name | Distinguishes the original database from the staged replacement by content. If no original existed, record that fact explicitly; do not infer it from a later missing path. |
| File-object observations | Best-effort platform file identity for source, staged, destination, and rollback (device/inode where meaningful, or platform-specific file ID if safely available); observed link count where available | Supplemental evidence for hard-link relationships and path replacement. Never treat inode/device values alone as portable or durable across reboot, volume remount, or filesystems. |
| Parent and platform | Platform identifier, filesystem capability profile, and validated parent-directory identity/ACL assumptions | Recovery must refuse automatic actions when the runtime platform or filesystem is outside the tested support matrix. |
| Integrity envelope | Bounded record size, strict field allowlist, canonical serialization rules, and checksum over the serialized record | Detect accidental truncation/corruption and reject unknown fields. A checksum is not authentication: same-privilege modification of both record and checksum remains possible. Trusted directory permissions remain essential. |

Evidence capture and ordering requirements:

1. Acquire the existing runtime/maintenance reservations before inspecting or hashing mutable database files. Prove exclusive ownership using the established reservation protocol; do not use PID liveness or sidecar existence as a substitute.
2. Open each candidate without following symlinks/reparse points where the platform API permits. Validate regular-file type and trusted parent components. If safe handle-based identity cannot be obtained, mark the platform/filesystem combination unsupported for automatic recovery.
3. Hash the source and any pre-existing live destination from opened handles. Compare handle identity and relevant metadata before and after hashing; any change aborts before destructive work.
4. Publish the complete immutable intent record with no-replace semantics and the documented file/directory durability sequence. Only after publication may staging begin.
5. Copy the source to the staged path using exclusive creation. Flush it, hash it from an opened handle, validate SQLite integrity/foreign keys/schema, and require its size and digest to match the intent before publishing rollback or changing the live name.
6. Before rollback publication and before install publication, revalidate the relevant file-object identity and content digest, parent trust, destination absence/presence expectation, and exclusive reservation. Any mismatch or collision is manual review.
7. File-object IDs are correlation evidence, not content proof. Content digests are content proof, not provenance/authentication. Both are required for the narrow hard-link transitions; neither alone authorizes recovery.
8. Do not put credentials, task data, user-controlled strings, or raw exception messages in the journal. The journal is operational metadata and must have restrictive permissions/ACLs and bounded size.

A mutable `phase` field is deliberately **not** part of the initial v2 proposal. Updating a journal in place introduces its own torn-write, replacement, and durability protocol and can create a second source of truth. Prefer deriving a candidate transition from immutable intent plus verified file identities/content and exclusive ownership. If later evidence shows that derivation is insufficient, design an append-only, checksummed transition ledger as a separate versioned protocol; do not add ad-hoc phase writes.

An append-only transition ledger is **optional, not a baseline prerequisite** for Automatic Restore Recovery. The evaluator may safely automate only those crash states for which immutable intent and the complete live evidence prove exactly one next transition; every ambiguous state, including simultaneous plausible staged-install and rollback candidates, remains manual-review. This conservative boundary satisfies the safety requirement without adding a second durable protocol. A ledger becomes necessary only if a future product requirement explicitly demands automatic resolution of one of those otherwise ambiguous states. Until that requirement is approved, do not design or implement the ledger, and do not weaken manual-review to increase recovery coverage.

The SHA-256 digest and checksum do not protect against a malicious actor who can rewrite both the journal and its artifacts. This design assumes the database parent and journal are protected by the documented trusted-user/administrator boundary. A stronger adversarial local-user threat model would require a separately protected signing key or OS-backed integrity boundary and is outside this proposal.
- The process-local booleans `temporaryCreated`, `rollbackPublished`, `movedOriginal`, and `installPublished` are not persisted and disappear on process death. They cannot be reconstructed from the journal's current fields alone.
- A successful `linkSync` followed by a failed or interrupted `unlinkSync` can leave two names for one file object. Conversely, path presence alone cannot prove that two names still identify the same object after external mutation.
- The current inspector checks path kind/existence and journal shape, but does not hash database contents or prove object identity between journal artifacts. Its output is evidence for an operator, not an authority decision.
- The current implementation removes the journal after install cleanup, but retains the rollback file on successful Restore. A later policy for rollback retention/deletion must be explicit and must not be inferred from journal absence.
- Any uncertainty about active handles, SQLite reservations, directory-sync completion, hard-link identity, or concurrent path replacement maps to manual review. A PID value or persistent lock sidecar alone is not proof of liveness or staleness.

### Source implementation feasibility gate (2026-11-12)

**Decision: automatic recovery execution is not yet eligible on any platform.** The current code is a conservative read-only classifier plus an operator-led Restore transaction; the Phase 6 authorization does not waive the evidence requirements below.

- `src/database-maintenance.js` currently uses path-based `lstatSync`, `readFileSync`, `copyFileSync`, `linkSync`, `unlinkSync`, and `rmSync`. The checks are useful diagnostics, but the code does not retain trusted parent-directory handles or prove that a path still names the same opened object immediately before each destructive transition. A check-then-use race remains possible under a concurrent path replacement.
- The current journal v1 contains paths and process metadata, not source/staged/rollback byte lengths and SHA-256 digests bound to opened file handles. It cannot authorize continuation or rollback.
- `src/file-system-durability.js` explicitly reports directory flush as unsupported on Windows. POSIX directory fsync is implemented, but directory durability alone does not prove no-follow path resolution, stable file identity, or exclusion of non-cooperating mutation.
- The current runtime/maintenance reservations coordinate cooperating Control Center processes. They do not prove that an unrelated process has no open handle or cannot mutate a candidate file.
- The current Restore inspector/classifier returns `automaticAction: none`; that fail-closed behavior is correct and must remain unchanged until all adapter and state-matrix gates pass.

**Implementation prerequisite:** introduce a narrowly scoped, reviewed filesystem adapter with retained parent/file handles, no-follow leaf opens, handle-derived object identity, parent-relative no-replace namespace operations, tested external-mutation exclusion, and explicit file/directory durability outcomes. The adapter must expose a capability profile and return `unsupported/unknown` rather than emulate a missing guarantee with path checks. Windows requires a native, testable directory-flush and file-identity implementation before any Windows state can become eligible. POSIX also requires race-resistant parent-relative operations; successful directory fsync alone is insufficient.

Until that adapter exists and passes the crash-injection matrix, the supported automatic-recovery set is empty: all v1 journals, v2 journals without proven adapter capabilities, unsupported filesystems, and ambiguous states resolve to manual review. Do not implement an executor that merely applies the existing path-based classifier decisions.
### Required design before implementation
- Specify a transition table for every crash boundary, including journal-temp publication, journal publication, staged-copy completion, rollback-link publication, original-name removal, installed-name publication, temporary cleanup, and journal cleanup.
- Record sufficient durable evidence to identify the exact intended source, destination, staged bytes, and rollback object. A path name or artifact-presence observation alone is not proof of file identity, content validity, or authority.
- Define how a recovery process obtains exclusive runtime and maintenance ownership and how it proves the relevant process/database handles are no longer active. Never infer staleness from a persistent lock sidecar or PID alone.
- Permit automatic actions only for states whose intended transition is unambiguous, whose files are verified regular files in trusted non-aliased parents, whose identities/content match the journal, and whose operation is protected by exclusive ownership.
- Every publication/removal must be atomic and no-replace where applicable, followed by the platform-supported durability operation. A failed durability operation must leave enough evidence for inspection and must not be reported as successful recovery.
- Preserve malformed/unknown journals, unrecognized files, legacy lock artifacts, collisions, and ambiguous live/rollback combinations. These states must fail closed for operator review.
- Recovery must be idempotent: repeating startup after any successful recovery step must converge to the same verified state without deleting unrelated files or overwriting an existing destination.
- Document supported filesystems/platforms and explicitly state durability limits where directory synchronization is unavailable. Do not promise power-loss guarantees that the platform API cannot provide.

### Acceptance evidence
- Before any future evaluator is enabled, a written state/transition matrix must map every supported v2 journal/artifact/lock combination to exactly one bounded result: eligible continuation, eligible rollback, or manual review. Until the evaluator and executor are implemented and accepted, every current state remains manual/operator-led with no automatic action. No implicit/default action is allowed.
- Child-process crash injection occurs immediately before and after every durable transition, then runs recovery repeatedly and verifies the same final result.
- Tests cover path replacement, symlink/junction parents, hard-link and identity changes, malformed/truncated journals, unknown fields/versions, source mutation, destination collisions, stale-looking and active locks, unreadable directories, disk-full/permission/fsync failures, and unsupported filesystem behavior.
- Windows CI verifies actual supported crash-state behavior; POSIX CI verifies its corresponding durability behavior. Unsupported combinations remain manual-review states.
- Tests prove no unrecognized or unrelated artifact is deleted and no existing file is overwritten.
- Operator runbook explains inspect, automatic recovery outcomes, manual-review escalation, and credential/Participant rotation after a snapshot Restore.

## 3. Remaining Deferred inventory

The following items cover the Architecture Deferred inventory captured when Phase 6 was introduced plus the explicitly deferred per-Task diagnostic in `TASK-ROUTING-DESIGN.md`. Every capability item needs a bounded design, implementation, and verification before Phase 6 exits. A separate authorization gate may delay execution of a workstream, but it does not count as completion. Optional independent/third-party security reviews in `SECURITY-REVIEW.md` are not product capabilities or Phase 6 completion gates.

- **Phase 5 remote/multi-machine operation:** remains blocked until explicit operator authorization. Before implementation: fresh threat model, authenticated transport and identity lifecycle, credential rotation, replay protection, bounded resource controls, and consistency/partition semantics; then cross-machine and adversarial tests. Loopback-only remains mandatory until separately authorized.
- **Plugin marketplace:** establish provenance/signing, version policy, isolated execution boundary, capability permissions, install/update/rollback, revocation, and audit. Never load arbitrary extensions into the Control Center process.
- **Autonomous scheduling:** define ownership, bounded policy, idempotency, lease/concurrency interaction, cancellation, audit, and operator kill switch. Uncertain non-idempotent work must not be replayed.
- **Dashboard analytics:** select actionable metrics, privacy-safe aggregation, bounded query cost, freshness semantics, and authorization. Analytics remain read-only and cannot decide task authorization/state.
- **Per-Task capability mismatch diagnostics (carried from `TASK-ROUTING-DESIGN.md`):** for an unmatched queued Task, report the required capabilities that no currently eligible active Participant supplies. Define eligibility using the same capability-set inclusion and active/claim-capable Participant rules as the atomic claim path; distinguish no eligible Participants from specific missing capabilities. Keep output bounded, read-only, and payload/credential-free. Test empty requirements, no active claim-capable Participants, partial and complete capability coverage, Participant revocation/capability updates, and concurrent state changes. Revalidate against current state when queried; stale explanations must never affect claims, authorization, or Task state.
- **Automatic retries for external work:** no generic blind retry. Define explicit per-task retry contracts, idempotency guarantees, budgets/backoff, side-effect reconciliation, and opt-in policy. Tasks without a proven safe contract remain blocked for operator review.

### Cross-workstream boundaries and minimum acceptance

The following boundaries prevent the remaining workstreams from expanding into overlapping control-plane features. They remain binding implementation constraints throughout the now-authorized Phase 6 work.

| Workstream | Owns | Explicitly does not own |
|---|---|---|
| Plugin marketplace | Trusted extension metadata, provenance, approval, versioning, permission declaration, lifecycle, revocation, and audit | In-process arbitrary code execution, replacement of Raya-MCP tools, or implicit Worker authorization |
| Autonomous scheduling | Bounded decisions about when an eligible Task should be created or made available | Claiming/executing work, bypassing leases, or retrying failed external side effects |
| Dashboard analytics | Read-only aggregate operational measurements over a bounded time range | Per-Task diagnosis, authorization, claim selection, or Task-state mutation |
| Per-Task capability mismatch diagnostics | A current point-in-time explanation for one unmatched queued Task | Aggregate analytics, claim decisions, authorization changes, or Task-state mutation |
| Automatic retries | Explicit per-task-type retry eligibility and side-effect-safe retry transitions | Generic retry loops, scheduler-owned retry policy, or replay of uncertain/non-idempotent work |

Minimum acceptance evidence for the remaining workstreams:

- **Plugin marketplace:** before implementation, choose and document the artifact format, trust root, signature/provenance verification, compatibility/version rules, permission vocabulary, isolated execution boundary, and operator approval/revocation flow. Tests must reject unsigned, tampered, incompatible, revoked, and unauthorized artifacts; cover update failure and rollback; prove extensions cannot execute inside the Control Center process or gain undeclared permissions; and verify lifecycle audit events. The marketplace must not duplicate or silently expose Raya-MCP tools. If a safe isolated runtime and trust root are not available, keep installation/execution disabled rather than weakening the boundary.
- **Autonomous scheduling:** define the initial trigger types and bounded scheduling horizon before coding; persist enough identity to make duplicate scheduler ticks idempotent; specify concurrency limits, cancellation, missed-run behavior, restart behavior, and an Operator kill switch. Tests must cover duplicate ticks, restart/reconciliation, overlapping schedules, cancellation, exhausted limits, and kill-switch behavior. Scheduling may create or release Tasks only through existing authorized Control Center transitions; it must not claim a Task or run Worker code.
- **Dashboard analytics:** publish a metric dictionary with numerator/denominator, population, time window, freshness/update semantics, and known limitations for every metric. Queries must be Operator-authorized, read-only, payload/result/credential-free, bounded by explicit time-range and result limits, and tested against query-cost limits. Tests must prove analytics cannot mutate Task/Participant/Lease state and that stale/empty data is labeled rather than presented as current. Aggregate counts for routing availability belong here only if useful; they do not replace the per-Task diagnostic.
- **Per-Task capability mismatch diagnostics:** return a bounded explanation computed from current state at query time using the exact atomic-claim eligibility predicate. Tests must cover empty requirements, zero eligible Participants, partial and full coverage, revocation/capability changes, and concurrent updates. The endpoint/UI must not expose Task payload/results or credentials and must never feed back into claim selection or authorization. This workstream is per-Task and point-in-time, not a dashboard metric or historical analytics engine.
- **Automatic retries:** define a versioned opt-in retry contract per task type, including idempotency key semantics, maximum attempts, bounded backoff/jitter, deadline, retryable versus terminal outcomes, and how uncertain external side effects are reconciled. A retry transition must be audited and revalidate Task/Lease state; no active or uncertain prior execution may be replayed. Tests must cover duplicate retry requests, process restart, exhausted budget, cancellation, terminal errors, uncertain side effects, and idempotency conflicts. Tasks without a proven contract remain blocked for Operator review. Scheduler timing must not itself imply retry eligibility.
### Recommended dependency order

This order is a dependency guide for the authorized Phase 6 work; it does not remove per-workstream prerequisites or separately gated authorizations. Work may proceed in parallel only where the stated prerequisites and shared-state boundaries remain satisfied.

1. **Establish shared foundations:** settle the bounded event vocabulary/redaction policy for Structured Operational Logs, and settle the trust-root, artifact, permission, and isolation decisions for the Plugin Marketplace. These are separate designs; neither grants permission to execute extensions or emit sensitive operational data.
2. **Close safety-critical persistence recovery:** implement and verify Automatic Restore Recovery only after its complete Journal v2, reservation guard, native adapter, inventory, durability, and crash-injection prerequisites are met. This workstream is independent of marketplace delivery and must not be weakened to fit another workstream's schedule.
3. **Complete read-only visibility:** implement Per-Task capability mismatch diagnostics against the existing atomic-claim eligibility predicate. Dashboard Analytics may follow once the event/metric definitions and data-retention/freshness semantics are stable; it remains aggregate and read-only. The diagnostic is not an analytics input that can influence claim decisions.
4. **Define retry semantics before scheduling integration:** establish and test versioned per-task retry contracts first. Only then may Autonomous Scheduling integrate bounded schedule triggers with those contracts. Scheduling without a retry contract may create or release eligible Tasks, but may not infer retry permission from elapsed time, a missed run, or a failed execution.
5. **Complete the Plugin Marketplace only when isolation is real:** artifact verification, operator approval, permission enforcement, revocation, and audit must be proven before installation/execution is enabled. If a safe isolated runtime is unavailable, metadata/catalogue functionality may be documented separately, but executable installation remains disabled.
6. **Treat Remote/multi-machine operation as a separately gated final workstream:** it is not unblocked by completing any local workstream. It requires a fresh explicit operator authorization and its own threat model, transport/identity, replay, consistency, and cross-machine evidence. Until then the API remains loopback-only and Phase 6 cannot claim this deferred item complete.

Cross-workstream constraints:

- Structured logs must never become a channel for Task payloads/results, credentials, bearer tokens, or unbounded identifiers. Analytics must consume only the explicitly allowlisted, redacted event/metric surface.
- Restore Recovery must not depend on the marketplace, scheduler, analytics, or retry subsystem; its safety protocol and operator-led fallback remain independently testable.
- Diagnostics and analytics are observational only. Neither may mutate claims, leases, authorization, or Task state.
- Retry execution remains a Task/Lease state transition with explicit per-type policy. The scheduler supplies timing only; it does not own retry eligibility or side-effect reconciliation.
- Marketplace permissions do not confer Participant capabilities or Worker claim authority. Extensions must not bypass the Control Center authorization and lease protocol.
- No dependency or sequence in this section authorizes Phase 5, remote exposure, or the start of Phase 6 implementation.
## 4. Phase 6 governance and exit

- Phase 6 is authorized and In Progress as of 2026-11-12. Each workstream must still satisfy its own prerequisites and acceptance evidence.
- Phase 5 remote work requires its own explicit authorization even while Phase 6 is active.
- Keep the existing local-first and loopback-only security boundary until that authorization and its acceptance gates are satisfied.
- Each workstream must have implementation, tests, documentation, and operational evidence recorded before its checkbox is marked complete.
- At Phase 6 exit, every item in the Deferred inventory captured at Phase 6 creation must be completed and verified; none may remain Deferred, merely undocumented, or be silently dropped/re-labelled. The remote/multi-machine workstream remains subject to the separate explicit authorization gate; until that authorization is given, Phase 6 cannot be declared complete while that item is still pending.

### Restore recovery eligibility: implementation feasibility review (source-derived; design only)

The current implementation was inspected in `src/database-runtime-lock.js`, `src/database-maintenance.js`, and `src/file-system-durability.js`, together with `test/file-system-durability.test.js`.

#### Verified primitives and their limits

- Runtime and maintenance reservations are separate persistent SQLite sidecar databases. Ownership is the live `BEGIN IMMEDIATE` transaction, not sidecar existence. Acquisition fails closed on SQLite busy; release rolls back and closes the connection. Restore acquires the destination runtime reservation and then destination maintenance reservation, releasing in reverse order.
- These reservations serialize Control Center operations that use the same protocol. They do not prove that arbitrary external processes, old binaries, or direct filesystem actors have no open handles or are not replacing paths. Recovery must require a trusted parent/ACL boundary and must not infer exclusive ownership from a free sidecar alone.
- Current Restore source identity is sampled with `lstatSync(path, { bigint: true })` before and after copying. The snapshot includes device, inode, size, mtimeNs, and ctimeNs, but it is pathname-based, not a stable opened-handle identity. The staged copy is SQLite-validated and file-flushed, but current journal v1 does not bind it to a durable digest.
- Current journal publication uses exclusive temporary creation, file flush, hard-link no-replace publication, and parent-directory sync. Restore's later namespace transitions also use hard links and directory sync. This is a useful protocol baseline, not sufficient recovery evidence by itself.
- `syncDirectory` performs directory fsync on supported POSIX runtimes. On Windows it explicitly returns unsupported because Node does not expose a portable directory-handle flush. Tests verify both behaviors. Therefore a Windows recovery protocol cannot claim the same namespace durability boundary as POSIX using the current primitive.
- The current API surface does not provide a portable, cross-platform way to open a file without following all relevant reparse/symlink cases and then prove stable native file identity from that same handle. POSIX and Windows need separately specified, tested native adapters before either platform can be marked eligible for automatic recovery.

#### State eligibility matrix

| Observed state / evidence | Safe continuation | Safe rollback | Required outcome today |
|---|---:|---:|---|
| No journal; no recognized artifacts; inventory complete; no active/unknown locks | No | No | Manual/operator-led normal startup; absence is not a recovery transaction |
| Unpublished journal temp exists, or inventory is incomplete | No | No | Manual review; preserve every artifact |
| Journal malformed, unknown version/fields, unreadable, or destination mismatch | No | No | Manual review; preserve journal and artifacts |
| Valid v1 journal with any artifact combination | No | No | Manual review; v1 lacks content and object-identity binding |
| Valid future v2 intent; staged bytes exactly match source digest/size and SQLite validation; destination still in the explicitly recorded initial state; rollback evidence matches; all relevant ownership and platform gates pass | Candidate only | No | Not eligible until v2 implementation and crash-injection tests prove the exact transition |
| Valid future v2 intent; original rollback object is verified against recorded identity/content; install is absent or provably not published; destination is safely absent; ownership and durability gates pass | No | Candidate only | Not eligible until v2 implementation and crash-injection tests prove the exact transition |
| Live and rollback both exist, but identity relationship is uncertain; staged and live both exist without proven same-object identity; destination collision; unexpected hard links | No | No | Manual review |
| Any active/unknown runtime or maintenance reservation, open/unknown handle, untrusted/aliased parent, symlink/reparse uncertainty, permission error, digest mismatch, unsupported filesystem, or failed durability operation | No | No | Manual review |
| Journal absent after a completed install, with rollback still present | No | No | Preserve rollback; journal absence never authorizes rollback deletion |

The two Ã¢â‚¬Å“candidateÃ¢â‚¬Â v2 rows describe the only narrow classes worth proving in implementation: (a) continuation when the exact staged object is verified and the recorded destination/rollback transition is unambiguous; (b) rollback when the exact original object is verified and the replacement is provably absent. They are **not** authorization to act and are not currently reachable from v1 evidence.

#### Mutual-exclusion rule for future eligibility

The two candidate rows above are hypotheses, not a complete truth table. They are not authorization to act and are not currently reachable from v1 evidence. The rollback candidate can overlap the continuation candidate: if the live destination is absent while both a valid staged object and a valid rollback object exist, both forward installation and rollback publication may appear plausible. The evaluator must not resolve this by preference, timestamps, PID, filename order, or an implicit 'finish what was started' policy. That overlap is manual-review unless a separately specified, durable, immutable transition record proves which single transition was committed to before the crash.

- Evaluate continuation and rollback as independent predicates over one complete evidence projection. Do not use `else-if` ordering to manufacture uniqueness.
- Each predicate must name exactly one source object, destination name, expected prior destination state, operation UUID, and one namespace primitive. Return an eligible descriptor only when exactly one predicate is true; zero or two true predicates means `manual-review`.
- The intent's `destinationExisted` value is mandatory. If false, any pre-existing live destination or rollback object not explained by the immutable intent is a collision/contradiction. If true, the exact original destination must be bound to the rollback role before any install candidate can be considered. A missing or mismatched rollback is not equivalent to an absent original.
- A staged object matching the source digest is not by itself proof that continuation is the correct recovery direction. An original rollback object matching its recorded digest is not by itself proof that rollback is the correct direction. When both are verified and either could be published into the absent live name, the result is ambiguous and manual-review.
- An append-only transition ledger is not required to satisfy the baseline recovery contract. Do not introduce one to increase automatic-recovery coverage; ambiguous states remain manual-review. A ledger may be considered only after a separate product requirement explicitly calls for resolving a currently ambiguous state, followed by its own schema, publication-ordering, crash-semantics, durability, cross-platform design, and approval.
- A live destination that exists is never overwritten by an eligible recovery transition. If the live object is not exactly bound to the expected installed/staged/original role through the same retained handles and directory-entry evidence, manual-review.
- Cleanup is excluded from both predicates. A successful continuation or rollback decision cannot authorize journal, temporary, staged, or rollback deletion.

#### Required protocol corrections before any automatic action

1. Define multi-file reservation ordering for both Restore source and destination. The current Restore path reserves only the destination; source path identity is checked by pathname snapshots. Acquire source and destination maintenance reservations in a deterministic canonical order to avoid cross-operation deadlocks, while preserving destination runtime exclusion. If a source cannot participate in the reservation protocol, automatic recovery is ineligible.
2. Define handle-based file identity adapters separately for POSIX and Windows. Capture identity, type, size, link count, and relevant timestamps from the opened handle, then verify the directory entry still names that same object. Path-based `lstat` snapshots remain useful diagnostics but cannot satisfy this gate.
3. Define reparse-point/no-follow behavior and trusted-parent validation using platform-native APIs. If the implementation cannot prove these properties on a filesystem, that platform/filesystem combination remains manual-review-only.
4. Specify what Ã¢â‚¬Å“no active handlesÃ¢â‚¬Â means operationally. SQLite reservation release is necessary for cooperating Control Center processes but is not a universal proof against external handles. Do not use PID liveness or lock-file presence as a substitute.
5. Keep the durability contract platform-specific. POSIX directory fsync may support a stronger namespace boundary where tested; Windows must remain manual-review-only for transitions whose correctness depends on directory flush until a native, tested flush implementation exists. Do not downgrade a failed flush into a successful recovery result.
6. Preserve rollback indefinitely until a separate, verified retention/backup policy authorizes cleanup. Recovery must never delete rollback merely because the journal is absent or installation appears complete.

**Decision:** no observed crash state is currently approved for automatic continuation or automatic rollback. The current runtime remains operator-led and read-only for recovery inspection. This review changes documentation only; it does not implement Journal v2, alter Restore behavior, or start Phase 5.

### Multi-database reservation protocol (proposed; design only)

Source review confirms that the current Backup flow acquires maintenance reservations in call order (source first, destination second), while Restore acquires the destination runtime reservation and then its maintenance reservation. The current Restore path does not reserve the backup source. These are distinct lock classes; a persistent sidecar file is only a rendezvous point, while the live SQLite BEGIN IMMEDIATE transaction is the reservation.

For any future operation that must reserve more than one database, use one shared acquisition helper and a single total order:

1. Resolve each database path using the same canonical-parent rules as databaseRuntimeLockPath: reject symlink/junction parent components, resolve the parent directory, and combine it with the basename. Revalidate the parent and database entry immediately before lock acquisition. Canonicalization failure is a hard failure, not a fallback to the caller's spelling.
2. Reject source/destination aliases after canonicalization. On Windows compare using the platform's case-insensitive path semantics; on POSIX preserve case sensitivity. Do not use locale-sensitive sorting.
3. Convert requested reservations into unique keys (canonical database path, lock class). Sort by canonical path using a deterministic ordinal comparison over the platform-normalized representation, then by a fixed lock-class rank (runtime before maintenance). The same helper and comparator must be used by every multi-lock caller.
4. Acquire in ascending order. If any acquisition fails, release every acquired reservation in exact reverse order before returning the original error. Release after success in reverse order as well. Release must be idempotent and must not unlink persistent sidecar files.
5. Keep single-lock runtime users unchanged unless they participate in a multi-lock operation. No code path may acquire a lower-ranked key while already holding a higher-ranked key. If an operation discovers it needs another key after acquisition begins, release all keys and restart with the complete sorted set.
6. For Restore, reserve destination runtime plus source and destination maintenance keys as one ordered set before hashing or validating mutable database files. For Backup, reserve source and destination maintenance keys as one ordered set. Existing source/destination equality checks remain mandatory.
7. Reservation success proves exclusion only against processes using the same lock protocol and canonical path. It does not prove absence of external file handles, direct filesystem mutation, older binaries with different lock naming, or aliases on unsupported filesystems. Those conditions remain separate eligibility gates for automatic recovery.
8. The acquisition helper must return one operation-scoped guard that owns the complete sorted set, exposes only the acquired lock classes/keys and a live-held assertion, and releases in reverse order exactly once. Individual raw release callbacks must not escape to callers that can release a subset while evidence is being evaluated. A failed acquisition returns no guard and guarantees reverse release of every partial acquisition. The guard is an in-process lifetime anchor, not a serializable ownership token or proof against non-cooperating processes.
9. Evaluator and executor must share the same live guard instance and retained adapter context. Releasing and reacquiring an equivalent path set does not preserve the earlier evidence binding; it requires a new evidence snapshot and a new evaluation.

#### Required concurrency tests

- Two child processes request the same pair of maintenance locks in opposite argument order. Both must terminate deterministically: one may acquire while the other receives the documented busy result; neither may hang, leak a reservation, or leave a partially held set.
- Repeat with duplicate canonical paths expressed through dot/dot-dot, parent aliases, and Windows case variants; aliases must collapse or be rejected before acquisition.
- Inject failure on the second lock acquisition and assert the first reservation is released, the original failure is preserved, and a subsequent process can acquire both keys.
- Exercise Restore's runtime-plus-maintenance key set against server startup and token rotation; confirm existing single-runtime ownership still blocks Restore and no lock-order inversion is introduced.
- Crash a child while it holds multiple reservations; after process exit, verify SQLite releases the transactions and a new process can acquire them without deleting or recreating sidecar files.
- Run the same tests on supported Windows and POSIX CI. Filesystems with unreliable SQLite locking or unsupported canonicalization remain outside the automatic-recovery support matrix.

**Implementation boundary:** this is a proposed protocol, not a claim that current Backup/Restore already use sorted multi-lock acquisition. No lock code or runtime behavior is changed in this step.

### Handle-based file identity adapters (proposed; design only)

The current implementation has useful pathname diagnostics but no cross-platform handle-identity proof. Snapshot helpers use lstatSync; their device/inode and metadata values describe a directory entry at sampling time. A later open/copy can race with replacement. Parent-component checks and lock-path canonicalization also perform pathname walks that can become stale. These checks are defense-in-depth, not proof that the opened object is the intended directory entry.

This adapter contract is a prerequisite for any future automatic Restore recovery. It does not approve any recovery state today.

#### Common adapter contract

Define a platform adapter with explicit capability reporting and a snapshot operation over an already-open handle:

- openRegularFile(parentHandle, leafName, policy) returns an owned handle plus a snapshot, or fails closed. It must not fall back to ordinary path-based open when no-follow/reparse guarantees are unavailable.
- snapshotHandle(handle) returns the immutable observation below. Every unavailable field is null; absence is never interpreted as safe.
- verifyPathEntry(parentHandle, leafName, expectedSnapshot) verifies that the current directory entry still identifies the opened object.
- verifyUnchanged(handle, beforeSnapshot) re-reads identity and mutation-sensitive metadata after hashing/copying. A mismatch or unsupported comparison means ineligible.
- Keep handles open while identity is relied upon. Surface close errors.
- Capability discovery is explicit and versioned. Check every capability required by the operation and filesystem.

Normalized snapshot fields:

| Field | Meaning |
|---|---|
| platform, adapterVersion | Adapter identity and protocol version |
| objectType | Regular file / directory / other, determined from handle |
| volumeOrDeviceId | Windows volume identity or POSIX device ID |
| fileId | Stable native file identifier where exposed |
| size, linkCount | Handle-derived byte length and hard-link count |
| modifiedTime, changedTime, birthTime | Available high-resolution handle timestamps; otherwise null |
| openFlags | Effective no-follow, access, sharing, and reparse policy |
| parentIdentity | Identity of opened parent directory |
| pathEntryIdentityBefore, pathEntryIdentityAfter | Entry identity observations bracketing operation |
| filesystemType, filesystemCapabilities | Known filesystem and tested capability profile |
| identityStable, noFollowProven, entryMatchProven | Explicit booleans; unknown is never true |

The adapter distinguishes unavailable fields from queried zero values. File IDs are identity evidence, not content proof. SHA-256 plus byte length proves byte equality at hashing time, not provenance. Eligibility requires object relationship and expected digest, trusted-parent and reservation gates.

#### POSIX adapter requirements

- Open and retain the parent directory descriptor. Walk parent components without following symlinks where supported; verify each opened component with fstat and reject non-directories or unexpected filesystem transitions.
- Open the leaf relative to the retained parent descriptor using openat with O_NOFOLLOW and restrictive access flags. O_NOFOLLOW protects the final component only; it does not secure an earlier pathname walk. Do not claim protection against platform-specific magic-link or mount behavior without tests.
- Use fstat on the returned descriptor as authority for type, device, inode, size, link count, and timestamps. Reject non-regular files and unexpected link counts; where a single name is required, require link count exactly one.
- Compare handle-derived device/inode with a no-follow directory-entry observation relative to the retained parent (fstatat with AT_SYMLINK_NOFOLLOW, or stronger statx identity where supported). Repeat after hashing and immediately before namespace transition. If entry identity changes or no-follow comparison is unavailable, mark ineligible.
- Keep the parent descriptor open across checks and namespace changes. Prefer descriptor-relative rename/link/unlink operations; pathname re-resolution reintroduces parent replacement races.
- Directory fsync is a separate durability capability. Identity verification does not imply namespace durability. Unsupported statx, descriptor-relative operations, or directory fsync combinations remain manual-review-only.

Node's portable node:fs API exposes file descriptors and handle metadata, but not a complete portable descriptor-relative openat/fstatat/renameat protocol. Do not assume lstat(path) followed by open(path) closes the race. A native addon/helper or narrower proven platform implementation is required for the full contract.

#### Windows adapter requirements

- Use a native handle-opening implementation based on CreateFileW, with explicit FILE_FLAG_OPEN_REPARSE_POINT policy for inspecting the leaf and a defined directory-handle strategy for parent identity. Reject reparse points unless a separately specified and tested policy handles the exact tag.
- Query identity and metadata from the opened handle using GetFileInformationByHandle and/or GetFileInformationByHandleEx, including volume serial/file ID, attributes, size, link count, and timestamps. Do not treat fs.stat(path) or a path-derived inode as a stable native file ID.
- Define and test share modes. State whether concurrent read, write, and delete/rename opens are permitted while the handle is held. If the share policy cannot exclude conflicting mutation for the critical interval, that transition is ineligible.
- Retain parent directory handles with required backup-semantics and reparse policy. Verify the leaf file ID relative to the intended parent before and after hashing. If a race-resistant parent-relative query is unavailable, report entryMatchProven=false.
- Treat volume identity and file ID as filesystem-dependent. Validate NTFS and explicitly test or exclude ReFS, SMB/network shares, FAT/exFAT, cloud-synced folders, and other filesystems.
- Windows ACL preflight is separate. The existing PowerShell ACL helper's handle-based hard-link count check does not implement the Restore runtime adapter, parent-relative no-reparse open protocol, or namespace durability.

The current Node implementation cannot claim these native Windows guarantees. syncDirectory explicitly reports that portable Node directory-handle flush is unsupported on Windows. Until a native, tested directory durability primitive exists, Windows transitions depending on durable rename/link/unlink ordering remain manual-review-only even if handle identity is implemented.

#### Capability and eligibility matrix

| Capability | POSIX candidate | Windows candidate | Missing/unknown outcome |
|---|---|---|---|
| Retained parent directory handle | Descriptor open | Native directory handle | Manual review |
| No-follow leaf open | openat + O_NOFOLLOW | CreateFileW + explicit reparse policy | Manual review |
| Handle-derived stable identity | fstat device/inode | Native volume/file ID query | Manual review |
| Parent-relative entry comparison | fstatat/statx no-follow | Native parent-relative query with tested semantics | Manual review |
| Link-count verification | st_nlink | Native handle link count | Manual review |
| Prevent conflicting mutation | Tested OS/filesystem locking policy | Tested CreateFileW share modes | Manual review |
| Durable namespace transition | Tested directory fsync | Native directory flush on tested filesystems | Manual review |
| Filesystem support profile | Per filesystem/mount | Per volume/filesystem | Manual review |

A platform is eligible only when every capability required by the exact transition is positively reported and covered by CI/integration tests on that filesystem. A generic supported=true flag is insufficient; report individual capabilities and a stable filesystem profile. Capability probing must not mutate the database or attempt speculative recovery.

#### Adapter-to-evaluator exclusion and namespace contract

A successful open of a candidate handle proves only that this operation holds that handle. It does not prove that no other process or thread holds another handle to the same object. There is no portable cross-platform API in the current Node runtime that enumerates every open handle and turns an empty result into a race-free exclusion proof. Therefore `externalHandleExclusion` must not be inferred from a successful open, SQLite reservation, PID scan, or point-in-time handle enumeration. It is a separate, transition-specific capability and must be reported as unsupported unless the selected native mechanism actually prevents the conflicting operation for the entire critical interval.

- POSIX: `flock` and traditional `fcntl` record locks are generally advisory and constrain only participants that honor the protocol. They do not prevent an unrelated process from opening or writing the file. `O_EXCL`, `O_NOFOLLOW`, and a retained descriptor also do not exclude writes through another already-open descriptor. If the design depends on preventing arbitrary external writes or opens, the platform adapter must identify a tested mandatory/exclusive mechanism with precise filesystem semantics; absent that, automatic continuation and rollback are ineligible. Do not describe cooperative SQLite reservations as OS-level handle exclusion.
- POSIX namespace operations: use a tested descriptor-relative no-replace primitive for each exact transition (for example, `renameat2(RENAME_NOREPLACE)` where supported, or a separately analyzed link/unlink sequence for regular files). Do not silently fall back to replacing `renameat`, path-based rename, or check-then-rename. The adapter must report the exact primitive and its tested filesystem profile. File `fsync` and parent-directory `fsync` are separate required results; a successful file flush does not prove the directory entry is durable.
- Windows: the adapter must specify the exact `dwShareMode` bits used for every retained source, destination, staged, rollback, journal, and parent handle. `FILE_SHARE_READ`, `FILE_SHARE_WRITE`, and `FILE_SHARE_DELETE` have distinct effects; omitting one can prevent later opens/renames, while allowing it can permit conflicting access. Tests must establish which competing opens and rename/delete operations are rejected while each handle remains open. A restrictive share mode is useful only if it is compatible with the SQLite/runtime access pattern and demonstrably covers the full critical interval. Do not claim a universal no-external-handle proof from `CreateFileW` alone.
- Windows namespace durability: a native directory-handle flush is a separate capability from file `FlushFileBuffers`; it must be implemented and tested for each supported filesystem and transition. Until then, any transition whose crash correctness depends on durable directory-entry ordering remains manual-review-only, regardless of successful handle identity or share-mode tests.
- Inventory: parent-handle enumeration must be complete for the relevant namespace and detect concurrent additions, removals, and replacements. A second pass or change marker is not sufficient unless its semantics are proven against concurrent mutation. Unknown or unclassifiable entries force `complete=false`; filename allowlists alone never prove completeness.

#### Restore directory-inventory contract and current inspector gap (design only)

**Current implementation is diagnostic, not a complete namespace inventory.** In `inspectDatabaseRestore()`:
- With no published journal, `readdirSync(dirname(journalPath))` enumerates names, but the report retains only UUID-shaped journal-temp, rollback, and staged-restore names. Unrecognized names and recognized-prefix names with malformed tokens are discarded from the report. The `artifactInventoryComplete` calculation checks whether the selected rollback/staged paths were inspectable; it does not prove that every directory entry was classified.
- With a published journal, the current scan retains only UUID-shaped journal temporary names. It does not inventory all staged/rollback candidates or unrelated/unknown entries in the artifact namespace. Journal-record paths are inspected separately by pathname.
- These scans are path-based `readdirSync`/ `lstatSync` observations. They do not retain a trusted parent-directory handle, bind entries to a stable parent identity, detect a race-free namespace snapshot, or prove that an entry remained unchanged between enumeration and inspection. A successful listing followed by a second listing is not, by itself, a race-free guarantee.
- Consequently, the current `artifactInventoryComplete` value is a limited diagnostic flag and must never be promoted to v2 `inventory.complete`, evaluator evidence, or cleanup authority. Current v1 recovery remains operator-led for every state.

**Future v2 inventory scope and identity contract:**
- Define the exact namespace roots before inventory begins: at minimum the destination's parent directory containing the published journal, journal publication temporary names, staged Restore files, and rollback names. Any supported design that permits artifacts in another directory must enumerate that directory as a separate root and bind it to the same operation context. A missing, unreadable, or untrusted required root makes the aggregate inventory incomplete.
- Open and retain each trusted parent directory handle using the platform adapter's no-follow/reparse-safe rules. Bind the inventory snapshot to the exact parent object identity, adapter version, filesystem profile, and live operation-scoped reservation guard. Path strings alone do not identify the enumerated directory.
- Enumerate **every** entry in each required root, including names outside all known prefixes. Preserve the raw name only as bounded diagnostic data; classify each entry through handle-relative inspection as regular file, directory, symbolic link/reparse point, hard-link/alias condition, or other/unknown. Unknown type, non-regular candidate, alias, unexpected link count, unreadable entry, invalid name encoding, or failed metadata query makes `complete=false` and forces manual review. Do not silently filter an entry because its name is unfamiliar or malformed.
- Bind every recognized artifact to an exact expected role, canonical relative name, operation UUID, journal record, parent identity, opened object identity, link count, size, and digest as applicable. A UUID-shaped filename is only a candidate label; it does not prove ownership, operation association, content, or permission to delete.
- Inventory completeness requires a platform-specific race protocol: enumerate and inspect entries relative to retained parent handles; capture stable entry/object identity; detect additions, removals, replacements, and parent changes over the full interval using a tested directory change/version primitive or equivalent adapter mechanism. A before/after listing is only supplemental unless native tests prove it detects all relevant races for that filesystem. If the platform cannot provide a sufficiently strong snapshot/change-detection guarantee, report incomplete/unsupported and remain operator-led.
- Where multiple roots are involved, bind each root's parent identity and inventory result into one canonical aggregate evidence digest. Any root omitted, enumeration truncated, resource limit reached, or root identity changed invalidates the aggregate. The journal's recorded paths must resolve under the exact inventoried roots; a path outside them is a contradiction, not an implicit additional root.
- In the no-journal case, absence of the journal does not narrow the scan: inventory all entries in every configured Restore artifact root, including unknown names and all candidate rollback/staged/temp entries. Do not infer Ã¢â‚¬Å“no artifactsÃ¢â‚¬Â from an empty filtered allowlist.
- In the journal-present case, inventory the same complete namespace, not merely journal temporary names. Compare every observed candidate with the exact journal operation and expected artifact role. Unexpected extra candidates, duplicate role claims, cross-operation UUIDs, or unassociated artifacts make the evidence incomplete/contradictory.
- Inventory is a read-only evidence operation. It must not repair names, delete unknown files, follow links, normalize away aliases, or perform cleanup while enumerating. Cleanup remains a separate transition requiring the same live complete guard/context, exact operation-owned object identity, fresh evidence, and its own no-replace/durability checks. Filename matching alone never authorizes cleanup.
- A published journal plus a complete inventory does not itself authorize recovery. Journal validity, content digests, retained handles, reservation guard, external-mutation exclusion, platform capabilities, and one-shot evaluator/executor checks remain independent mandatory gates.

**Required inventory regression and native race tests:**
- Unknown filenames, malformed UUID-like names, valid-looking names associated with another operation, duplicate candidates, and unexpected files sharing a known prefix must remain visible and force incomplete/manual review where unclassified.
- Directories, symbolic links, Windows junctions/reparse points, hard links, special/other objects, and unexpected link counts must be classified without following them; unsafe/ambiguous entries force incomplete.
- Permission-denied/unreadable entries, enumeration exceptions, invalid names, truncated enumeration, and resource-limit exhaustion must never produce `complete=true`.
- Child processes must add, remove, rename, and replace entries during enumeration and between enumeration and handle inspection; race detection must invalidate the snapshot and prevent evaluator/cleanup mutation.
- Replace/rename the parent directory after opening it; verify the retained parent identity and path-entry binding detect the change. Test case-colliding names, case-sensitive versus insensitive directories, hard-link aliases, and cross-directory artifact placement.
- Test both journal-absent and journal-present paths with the same complete-inventory expectations. Specifically prove that unknown names are not filtered out in either path and that journal-present inspection includes staged/rollback candidates.
- Verify an incomplete inventory, stale snapshot, changed root identity, lost guard, or unclassified entry cannot be converted into evaluator eligibility by a second path-based scan. No cleanup or namespace mutation is permitted on these failures.
- Run native tests for each claimed OS/filesystem profile. Mocks may validate aggregation and evaluator logic but cannot establish race-free enumeration or parent-handle semantics.

**Acceptance boundary:** the existing inspector's filtered path scans remain operator diagnostics only. The v2 inventory contract is not implemented, and no current `artifactInventoryComplete` value is sufficient evidence for automatic recovery. This is a design clarification only; it does not authorize Phase 6 implementation or Phase 5.
#### Exact artifact-role and operation binding (Journal v2; design only)

The v2 naming scheme must use one immutable operation UUID for every artifact created by a single Restore attempt. The current v1 implementation does **not** satisfy this: it generates independent UUIDs for the journal temporary, staged file, and rollback name, and the v1 journal has no operation UUID. Do not infer a v1 operation identity by correlating timestamps, PID, filename tokens, or proximity.

For a v2 destination whose canonical basename is D and operation UUID is U, the initial same-parent namespace contract is:

| Role | Exact relative name | Required binding |
|---|---|---|
| Published intent journal | D.restore-journal.json | Exactly one strict v2 record; operationId=U; destination and parent identity match this inventory root |
| Journal publication temporary | D.restore-journal.json.U.tmp | Same immutable bytes/object as the journal only during the narrowly defined no-replace hard-link publication/temporary-unlink boundary; otherwise absent |
| Staged Restore object | .D.U.restore | Exact staged digest/length equals the intent source digest/length; SQLite validation is bound to this same object |
| Original-destination rollback | D.pre-restore-U | Exists only if destinationExisted=true; identity/content equal the original destination evidence recorded by the intent |

The strings above are a proposed v2 contract, not a description of current v1 names or behavior. Canonicalization and case comparison must be delegated to the selected filesystem adapter; do not lowercase paths as a universal rule. The journal's path fields must equal the canonical paths derived from (destination, U, role) under that adapter. A path that merely shares a prefix or contains a valid-looking UUID is not a match.

Inventory must build a one-to-one role map for each operation:
- Exactly one published journal may claim an operation UUID in a root. Duplicate journals, multiple candidates for one role, one object claimed under incompatible roles, cross-root paths without a declared root, or a candidate whose UUID differs from the journal UUID are contradictions.
- Every observed entry is accounted for as one exact expected artifact role or as an unrelated/unknown entry. Unknown entries remain visible and force manual review; they are never silently ignored as harmless noise.
- A journal record cannot claim an artifact that is absent from the complete inventory, and an inventoried candidate cannot be attached to a journal solely because its filename parses. Require agreement among exact derived name, canonical path, operation UUID, parent identity, opened object identity, content digest/length, and role-specific intent fields.
- destinationExisted=false prohibits a rollback role. destinationExisted=true requires the original-object evidence and constrains the rollback candidate to that exact object. A staged candidate is not interchangeable with live destination or rollback even when SQLite validation succeeds.
- The operation UUID is a correlation identifier, not a secret or authorization capability. It does not establish ownership, prove that the current process created an artifact, or authorize cleanup.

**Hard-link alias handling must be transition-specific, not a blanket exception.** The current implementation intentionally uses hard links for no-replace publication: journal temp and published journal can briefly name the same object; rollback and original destination can briefly name the same object; staged and installed destination can briefly name the same object. For v2, any such alias is acceptable only when the exact pair of names is prescribed for the single transition under evaluation, both names resolve through retained parent/file handles to the same stable object identity, the observed link count equals the exact expected count for that pair, no third alias exists in the complete inventory, and the adapter proves the transition-specific publication/flush ordering. Otherwise any link count above one, alias, or unexplained shared identity is manual review. Since the immutable intent deliberately has no mutable phase field, the evaluator must prove the transition from live handle/inventory evidence; it must not infer a phase from file presence or link count alone.

Role/alias tests must cover:
- v1 independent UUID tokens and v1 records with no operation UUID are never upgraded into a v2 operation binding;
- wrong UUID, wrong destination basename, wrong parent, wrong role suffix, case/normalization collision, duplicate role, duplicate journal, and path outside declared roots all fail closed;
- each allowed hard-link pair at its exact publication boundary, plus missing peer, extra third link, same-size different object, and link-count mismatch;
- journal temp, staged, rollback, and live entries appearing in every pairwise combination, including impossible combinations that must remain manual review;
- journal claims staged/rollback but inventory omits it, and inventory finds unclaimed candidate, both treated as contradictions;
- cleanup rejects a valid-looking filename with wrong object identity, wrong operation UUID, lost context, or any unexplained alias.

This is a documentation-only contract. No v2 naming, operation UUID, role mapper, hard-link transition evaluator, or automatic cleanup is implemented today.

Capability reporting must distinguish at least `handleIdentity`, `parentEntryMatch`, `noFollow`, `externalMutationExclusion`, `noReplacePublication`, `fileDataDurability`, `namespaceDurability`, and `completeDirectoryInventory`. Each field carries the adapter version, primitive/flags, filesystem profile, and test evidence identifier; unavailable or untested is false/unknown and therefore ineligible. A single aggregate `supported` value is prohibited.

#### Required native adapter tests

- POSIX: demonstrate that a non-cooperating child process can still open/write through a separate descriptor under advisory-lock-only mode; assert that this mode reports external mutation exclusion as unsupported. Exercise each no-replace primitive under destination-present and destination-absent races, then verify both file and parent-directory durability outcomes on each supported filesystem.
- Windows: use competing child processes to test every relevant combination of `FILE_SHARE_READ`, `FILE_SHARE_WRITE`, and `FILE_SHARE_DELETE`, including pre-existing handles, new opens, rename, and delete attempts. Assert the reported capability matches observed behavior and that unsupported combinations remain ineligible.
- Both platforms: race directory additions/removals/replacements against full inventory; inject enumeration errors and unknown entries; require incomplete inventory and zero namespace mutation. Verify a stale evaluator result cannot execute after any guard/handle loss or capability-profile change.
- Run these tests against native APIs on each declared supported OS/filesystem. Mocked adapters may test evaluator logic but cannot establish OS semantics or promote a filesystem into the automatic-recovery support matrix.

#### Threat assumptions and required tests

- Database, journal, and artifact parents are trusted and protected against untrusted same-user/admin mutation according to the operator boundary. Handle identity does not defend against a privileged actor rewriting both journal and artifacts.
- SQLite reservations serialize cooperating Control Center processes only. They do not prove absence of arbitrary external handles or direct filesystem mutation. Native sharing/locking semantics must be specified independently.
- Test replacement between parent open, leaf open, initial snapshot, hashing, final snapshot, and namespace transition. Include symlink/reparse swaps, junctions, hard-link creation/removal, rename races, parent replacement, mount/volume changes, and case/alias behavior.
- Test that a handle continues to identify the same object after pathname rename, and that a replacement at the old name is detected by post-operation entry comparison.
- Test link counts, unsupported metadata fields, file-ID reuse after deletion, timestamp granularity, and filesystems returning unstable or synthetic identifiers.
- Inject permission, sharing-violation, stale-handle, I/O, disk-full, and durability failures. Unknown or failed capabilities must preserve artifacts and produce manual review.
- Run child-process adversarial tests on each declared supported OS/filesystem combination. Mocked metadata alone is not evidence for native handle semantics.

**Decision:** retain current pathname checks as diagnostics and defense-in-depth only. Do not enable automatic Restore continuation or rollback on their basis. Implement POSIX and Windows adapters as separate native contracts, and keep a platform/filesystem combination ineligible unless handle identity, parent-entry comparison, mutation exclusion, and required durability are proven. This section is design-only; no runtime code, API behavior, Phase 5 scope, or network exposure changes.

### Journal v2 ordering: reservations, handles, hashing, and publication (design only)

This section resolves ordering dependencies between immutable Journal v2 evidence, ordered multi-database reservations, and handle-identity adapters. It describes a future protocol; current Restore does not yet satisfy it.

#### Required ordering

1. **Validate inputs without treating path observations as authority.** Normalize requested paths, reject lexical source/destination equality and unsupported path forms, and identify lock keys. Path canonicalization and parent checks are preliminary only. Do not hash database files or make recovery decisions from these observations.
2. **Acquire the complete reservation set before inspecting mutable database content.** Restore must reserve destination Runtime, source Maintenance, and destination Maintenance as one deterministic ordered set. Backup must reserve source Maintenance and destination Maintenance. Use canonical lock-key ordering and lock-class rank from the multi-database reservation protocol; release in exact reverse order. Partial acquisition failure releases every acquired reservation and performs no file inspection, hashing, or mutation.
3. **Establish trusted parent handles and adapter capabilities.** Open and retain relevant parent directories using the selected platform adapter. Verify parent identity, trust assumptions, filesystem profile, and required no-follow/entry-comparison capabilities. A capability gap stops the operation before journal publication or namespace mutation. Parent handles remain open through dependent checks and transitions.
4. **Open candidate files through the adapter.** Open source, and if present existing destination, with no-follow/reparse policy. Derive object type, stable identity, link count, size, and timestamps from handles. Verify each opened handle matches its intended directory entry. Reject unexpected hard links, non-regular files, aliases, or unknown identity fields required by the operation.
5. **Hash from retained handles.** Hash source and existing destination from the same opened handles whose identity was captured. Record byte length and SHA-256. Re-read handle metadata and compare the directory entry after hashing. Any identity, size, timestamp, link-count, or entry mismatch aborts. A path-based reopen for hashing is not acceptable.
6. **Construct and validate immutable intent in memory.** Include operation UUID, canonical paths, explicit destination-existed flag, source and original-destination digests/lengths, parent and file identity observations, adapter version, filesystem profile, and required capability evidence. Enforce strict allowlist, canonical serialization, checksum, and maximum record size. Exclude mutable phase state, credentials, task content, and raw errors.
7. **Publish the journal with no-replace semantics and platform durability.** Create journal temp exclusively, write the complete canonical record, flush the file, publish without replacing an existing journal, and perform the required parent-directory durability operation. If any step or durability confirmation fails, preserve evidence and stop; do not start staging. Published immutable journal is the intent boundary.
8. **Stage from the still-open source handle.** Copy bytes from the reserved and verified source handle into an exclusively created staged file. Flush staged content, open/verify the staged object through the adapter, hash it, and require exact equality with source digest and byte length. Run SQLite integrity, foreign-key, and schema validation against staged content. Recheck source and staged identity/content before proceeding.
9. **Before each namespace transition, revalidate relevant evidence.** While reservations and handles remain held, recheck parent identity, source/staged/original identity, link counts, required digests, destination presence/absence, and directory-entry matches. Perform rollback publication, original-name removal, and staged installation only through proven no-replace/descriptor-relative primitives. Flush file data and namespace changes according to the platform capability contract.
10. **Retain rollback and journal evidence until independently verified.** Do not delete rollback merely because installation returned successfully or the journal is absent. Cleanup is a separate transition with its own identity, ownership, and durability checks. If the platform cannot prove the required boundary, preserve artifacts for operator review.
11. **Release reservations last.** Close file and parent handles only after required verification and durable operations complete; then release reservations in reverse acquisition order. Surface close/release failures; never translate them into unqualified success.

#### Ordering invariants

- Reservations precede content inspection and hashing. This prevents cooperating Control Center maintenance operations from changing selected objects during evidence capture; it does not exclude arbitrary external processes.
- Parent handles precede leaf opens; leaf handles precede snapshots and hashing. The same handle remains the identity anchor throughout each operation.
- Journal publication follows complete evidence capture and validation, but precedes staging and every destructive namespace transition.
- Source and staged digests must match. If destination existed at intent time, its original digest and identity must bind the rollback object after publication. If it did not exist, a later destination appearance is a collision, never permission to overwrite.
- A successful hash does not prove path-entry identity; a matching file ID does not prove content. Both evidence forms and explicit capability gates are required.
- SQLite reservation does not prove absence of non-cooperating handles. Native sharing/locking policy is a separate mandatory gate.
- Unsupported filesystem, missing native adapter, failed post-hash comparison, ambiguous parent identity, or uncertain namespace durability means no automatic continuation or rollback.

#### Current implementation gap

The current Restore wrapper reserves destination Runtime and destination Maintenance only; it does not reserve source Maintenance. Current source validation and staging use path-based operations, and Journal v1 does not bind source/original/staged content with digests or stable handle identity. The ordered multi-reservation protocol, Journal v2 record, and native identity adapters are prerequisites, not descriptions of current behavior. No automatic recovery state is approved by this design.

### Crash matrix and classifier consistency review (design only)

The current source-derived matrix, recovery eligibility matrix, and runtime classifier agree on the governing safety decision: every classifier result has automaticAction = none, and no current crash state is approved for automatic continuation or rollback. The two future v2 candidate rows in the eligibility matrix remain design candidates only; they are not reachable from Journal v1 and are not implemented actions.

The classifier is intentionally coarser than the crash matrix. In particular:
- It records source and journal-temporary existence in observations, but valid-journal classification does not use those fields to distinguish every crash boundary.
- It does not compare object identity, content digests, journal operation paths, parent identity, filesystem capabilities, or handle ownership.
- A valid journal with a journal-temp alias, a staged file, or a particular rollback/install boundary can therefore map to a broad live/rollback state rather than a unique transition row.
- The classifier's output is an operator diagnostic summary, not a one-to-one encoding of the crash transition matrix and not an eligibility evaluator.

This is safe only because the classifier never authorizes an action. Do not expand it to automatic continuation/rollback by adding artifact-presence branches. Any future v2 evaluator must consume validated immutable journal evidence, per-handle identity and digest results, parent-entry comparisons, the complete reservation set, external-handle exclusion evidence, and platform/filesystem durability capabilities. Missing, unknown, contradictory, or untested evidence must map to manual review.

The existing tests in test/database-maintenance.test.js assert conservative classification for representative artifact combinations and assert automaticAction = none. They do not prove exhaustive coverage of every row in the crash matrix, nor do they test v2 evidence because v2 is not implemented. Before any classifier/evaluator expansion, add a table-driven crosswalk test that maps every documented crash boundary to its expected coarse classifier state and separately asserts that every case remains automaticAction = none. Add explicit cases for valid journal plus journal-temp alias, source missing/present, incomplete artifact inventory, and lock inspection unknown/error. Keep this crosswalk as documentation/test consistency evidence only; it must not turn candidate states into approved actions.

**Decision:** no contradiction currently authorizes recovery, but the documentation must not imply that the runtime classifier uniquely recognizes all crash boundaries. The matrix is the detailed forensic model; the classifier is a deliberately lossy, fail-closed summary. This review changes documentation only.

### Crash-boundary to current-classifier crosswalk (diagnostic only)

The following mapping makes the classifier's information loss explicit. It assumes complete inventory and no active/unknown locks; lock-present and lock-unknown branches take precedence in the actual classifier.

| Crash boundary from source matrix | Typical observed inputs | Current coarse classifier result | Why this is not an eligibility decision |
|---|---|---|---|
| Journal temp exists before publication | Journal absent; journalTemporary=true | no-journal-recovery-artifacts-present | Temp may be partial; it is preserved, never parsed as intent |
| Journal published while temp alias remains | Journal valid; journalTemporary=true | One of the broad valid-journal live/rollback states | The valid-journal branch does not distinguish the alias or prove both names identify one object |
| Staged copy in progress | Journal valid; temporary=true; live may exist | live-present-temporary-present-no-rollback, or another broad live/rollback state | Temporary existence does not prove completeness, digest, SQLite validity, or source relationship |
| Staged copy complete, before rollback publication | Journal valid; temporary=true; live=true; rollback=false | live-present-temporary-present-no-rollback | Classifier cannot verify staged digest, identity, or validation evidence |
| Rollback link published before original unlink | Journal valid; live=true; rollback=true | live-and-rollback-present-ambiguous | Two names may or may not still identify the same object |
| Original unlinked before directory sync | Journal valid; live=false; rollback=true | live-missing-rollback-present | Namespace durability may be uncertain; rollback identity/content is not verified |
| Original removal and directory sync complete | Journal valid; live=false; rollback=true | live-missing-rollback-present | Same path observation as the preceding boundary; classifier cannot distinguish durability completion |
| Staged name published at live destination before directory sync | Journal valid; live=true; rollback=true | live-and-rollback-present-ambiguous | Classifier cannot prove live and staged are the same object or publication durability |
| Install sync complete, before staged-name cleanup | Journal valid; live=true; rollback=true; temporary may vary | live-and-rollback-present-ambiguous | Successful namespace sync and content equality are not represented in classifier inputs |
| Journal removed while live and rollback remain | Journal absent; rollback=true | no-journal-recovery-artifacts-present | Journal absence does not authorize rollback cleanup or establish installed DB validity |
| Journal absent after all recognized artifacts are removed | Journal absent; no recognized artifacts; inventory complete | no-pending-restore | This is a normal diagnostic state, not proof of database integrity or historical Restore success |

This table is intentionally many-to-one: several crash boundaries collapse into the same coarse state because the current inspector does not collect the evidence needed to distinguish them. Do not add inferred phase labels to the classifier. A future v2 evaluator must derive eligibility from verified evidence and explicit capabilities, not from this crosswalk. Until then, all rows remain operator-led and automaticAction remains none.

### Future Restore recovery evaluator contract (design only; not implemented)

Keep three layers separate:
1. **Inspector:** read-only collection of observations. It reports unknown/error explicitly and never mutates files or locks.
2. **Classifier:** the existing lossy diagnostic summary. It may group observations for operator display but cannot grant eligibility.
3. **Evaluator:** a future, separately versioned pure decision function over a complete, validated evidence bundle. It returns a bounded decision; it does not execute filesystem operations. A separate executor would revalidate the decision's evidence immediately before each transition.

#### Required evaluator input

The input must be a single immutable evidence snapshot containing all of the following, with explicit unknown values rather than omitted properties:

- schemaVersion and evaluatorVersion, both exact supported values.
- inventory.complete === true, with enumerated names and per-entry inspection results for every recognized and unrecognized artifact in the trusted parent. false, null, omitted, unreadable, or partial inventory is ineligible. Completeness means a successful enumeration of the entire relevant directory namespace under a retained trusted parent handle, not merely enumeration of filename patterns currently recognized by the Inspector. Every entry must be represented, including unknown names, non-regular entries, aliases, and entries that cannot be inspected; any unclassified, omitted, raced, or unreadable entry makes the inventory incomplete and therefore manual-review-only.

The current Inspector's `artifactInventoryComplete` field is not this proof. In the no-journal path it filters rollback and staged names by known UUID patterns and can report true while unrelated/unrecognized names were not included. In the published-journal path it enumerates journal temporary names but does not perform a complete directory inventory of every candidate artifact. A future evidence collector must use a retained parent handle, enumerate the full namespace with race-aware before/after validation, and bind each entry to its parent identity and inspection result. Never promote the current boolean to evaluator evidence.
- Journal state: exact status, strict v2 schema validation result, canonical serialization/checksum result, operation UUID/kind, and every required immutable intent field. v1, unknown fields/versions, duplicate or contradictory fields, malformed records, and path mismatch are ineligible.
- Reservation evidence: the complete deterministic reservation set (destination Runtime, source Maintenance, destination Maintenance), successful acquisition results, and proof that all reservations remain held by the same live in-process operation. Missing source reservation or uncertain ownership is ineligible. The current SQLite `BEGIN IMMEDIATE` protocol exposes no portable ownership token and does not prove owner identity from a sidecar or PID. A future multi-reservation helper must retain opaque, non-serializable reservation guard objects (or equivalent live connection/transaction anchors) for the operation lifetime and expose a narrowly scoped `isHeld`/release contract tied to those exact objects. Do not invent or persist a bearer token; do not reconstruct ownership from lock-path existence, lock inspection, PID, or a copied snapshot. If the evaluator cannot be called while the exact guard set is live, eligibility is unavailable.
- Parent evidence: retained parent handles, stable parent identities, trusted ACL/ownership boundary, no-follow/reparse proof, parent-entry comparisons, and supported filesystem profile.
- File evidence for source, original destination if initially present, staged object, rollback, and live destination: handle-derived object type, stable identity, link count, size, digest algorithm/value, before/after metadata, path-entry match, and whether the exact same retained handle anchored the operation. Required evidence cannot be inferred from paths or names.
- SQLite evidence for staged/live candidates: integrity, foreign-key, and supported-schema checks tied to the exact hashed object.
- Platform capability evidence: tested no-replace namespace primitives, external-handle exclusion/share-mode policy, file flush, and required directory/namespace durability. Unsupported or unknown capability is ineligible.
- A contradiction/error list. It must be empty for any candidate action; errors cannot be downgraded to warnings by the evaluator.

#### Evidence lifetime and evaluator/executor binding

The evidence bundle is immutable as a value, but its authority is valid only while the live resources that anchored collection remain held. Keep reservation guards, retained parent handles, and candidate file handles in one operation-scoped context. Bind each decision to a canonical digest of the complete evidence projection, operation UUID, adapter/evaluator versions, and one narrowly defined transition. Immediately before mutation, the executor must compare the decision binding with a fresh projection from those same still-open handles and guards, recheck directory entries and capabilities, and reject drift. If any handle or guard was closed, replaced, reacquired, or lost, discard the decision and restart evidence collection; never reuse prior eligibility.

The pure evaluator operates only on the immutable projection; the executor owns resource-lifetime checks and mutation. If the architecture cannot preserve the operation-scoped context across this boundary, return manual-review.

#### Decision transport, context identity, and one-shot use

The evaluator's returned value is a decision descriptor, not an authorization token. It may contain only the bounded outcome, operation UUID, exact transition identifier, evidence-projection digest, supported adapter/evaluator versions, and diagnostic preconditions/expiry metadata. Serializing, persisting, logging, copying to another process, or replaying this descriptor must never preserve or recreate authority. A descriptor read back from JSON or reconstructed from its fields is always non-authoritative and can be used only for diagnostics.

The executor must receive the exact operation-scoped context object that owns the live guard and retained handles, and must verify object identity against the context that produced the evidence/decision. A matching operation UUID, digest, path set, or newly acquired equivalent guard is not a substitute for that same in-process context. If evaluator and executor cannot share that exact context without serialization or process transfer, the result is manual-review; no IPC protocol or bearer capability is implied by this design.

Treat each eligible decision as one-shot and transition-scoped. The executor atomically marks it consumed before beginning the protected transition; concurrent or repeated use is rejected. Its validity ends at the earliest of: the named transition attempt, explicit context invalidation/release, any anchor/capability/evidence drift, or the bounded expiry/revalidation boundary. A failed or ambiguous transition attempt does not make the old decision reusable. Any subsequent transitionÃ¢â‚¬â€including cleanupÃ¢â‚¬â€requires a newly collected evidence projection and a fresh evaluation under the still-valid or newly acquired complete context. A new context always requires new evidence and a new decision. The implementation must test duplicate, concurrent, delayed, serialized/replayed, cross-context, and post-release submissions as no-mutation rejections.

#### Required evaluator/executor tests

- Present-journal and absent-journal inventories include every directory entry, including unknown names and non-regular entries; an unreadable entry, partial enumeration, or directory mutation during enumeration yields `complete=false`.
- A known-name-only scan must never satisfy the complete-inventory contract. Add a regression fixture with unrelated UUID-shaped and non-UUID-shaped files beside the journal, staged, and rollback candidates.
- Multi-reservation acquisition in opposite input orders returns at most one complete guard; partial failure releases every acquired lock in reverse order, and callers cannot release one member independently.
- Releasing, replacing, or reacquiring any reservation or file/parent handle invalidates the prior decision binding. Executor revalidation must reject the stale decision without mutation.
- A decision digest bound to a different operation UUID, adapter/evaluator version, evidence projection, or transition identifier is rejected.
- Table-driven predicate tests evaluate continuation and rollback independently: zero true predicates returns `manual-review`; exactly one true predicate returns only its matching transition-specific eligible result; both true returns `manual-review`. Assert that evaluation order cannot change the result and that no fallback/priority rule selects one candidate.
- Contradictory, incomplete, or multiply matched evidence returns `manual-review` even when one candidate predicate would otherwise appear true; a transition-ledger field is neither required nor accepted as an implicit baseline prerequisite.

No evaluator input may be assembled by promoting the current inspector's exists, kind, PID, path-based lstat, or lock-sidecar observations into handle/digest/reservation proof. The current inspector does not produce this contract.

#### Bounded output

The evaluator returns exactly one of:
- manual-review Ã¢â‚¬â€ preserve every journal/artifact; no automatic mutation.
- eligible-continuation Ã¢â‚¬â€ a candidate authorization for one precisely named, non-destructive/forward namespace transition, with evidence digest, operation UUID, required preconditions, and expiry/revalidation boundary.
- eligible-rollback Ã¢â‚¬â€ a candidate authorization for one precisely named rollback transition, with the same binding and revalidation requirements.

no-pending-restore is an inspector/classifier diagnostic state, not an evaluator action or recovery authorization. The evaluator must not return generic success, recover, cleanup, delete, or retry decisions.

#### Mandatory decision precedence

1. Any missing/unknown/unsupported input, incomplete inventory, malformed or non-v2 journal, lock/handle uncertainty, untrusted parent, identity/path mismatch, digest/SQLite mismatch, unexpected hard link, destination collision, unsupported filesystem, failed flush/durability, or contradiction => manual-review.
2. If the evidence bundle does not prove one unique transition from the immutable intent and observed file identities/content, => manual-review.
3. If more than one candidate action could apply, or continuation and rollback both appear plausible, => manual-review.
4. Only after all general gates pass may a narrowly enumerated v2 transition rule return one candidate authorization. Candidate rules remain disabled until implementation, adversarial tests, and platform-specific acceptance evidence are complete.
5. The executor must use the exact same still-live operation context, reservation guard, and retained handles that anchored evidence collection and evaluation; it must not release and reacquire an equivalent guard. Immediately before mutation it revalidates the evidence binding and all transition preconditions from those same anchors. Any drift, stale decision, lost resource, or failed revalidation cancels eligibility and returns to manual review. A decision object is never a reusable bearer capability.

#### Decision lifecycle and transition boundary

The future implementation must enforce this in-process lifecycle; these labels are design vocabulary, not persisted journal phases:

1. `evidence-collected`: one immutable projection has been produced while the complete guard and all retained handles are live. No mutation is authorized.
2. `evaluated`: the pure evaluator has returned a bounded descriptor for either `manual-review` or one exact transition. Evaluation itself has no side effects.
3. `eligible-pending`: only an eligible descriptor may enter this transient state, and only while attached to the exact originating context. It is not serializable authority and cannot be exposed as an operator command or generic recovery permission.
4. `consumed`: the executor atomically consumes the descriptor before the first namespace mutation attempt. Consumption is terminal even if the OS call fails, throws, or has an ambiguous result.
5. `invalid`: any guard/handle/parent/inventory/capability drift, context mismatch, expiry, or failed precondition invalidates the descriptor before mutation. Invalid is terminal.

There is no transition from `consumed` or `invalid` back to `eligible-pending`. A later attempt must start with a new evidence collection and evaluation; if the previous transition may have changed the namespace, the new inventory must account for that ambiguity and normally yields manual-review unless the adapter can prove one exact resulting state. A transition descriptor names one operation (for example, publish this exact staged object at this exact absent destination), not a sequence, goal, recovery plan, cleanup bundle, or permission to choose a fallback. Every subsequent namespace change, including alias/temp/journal cleanup, is a separate transition with separate evidence and evaluation. Operator-facing output must describe the bounded result without exposing a replayable mutation handle.

#### Current status and compatibility

Today the evaluator does not exist; every state in the runtime classifier remains automaticAction: none. All v1 journals and all current crash states remain operator-led. The two v2 rows in the eligibility matrix are hypotheses for future rule design, not active rules. Phase 6 acceptance must be updated only after actual evaluator/executor implementation and tests; documentation alone cannot mark Automatic Restore Recovery complete.

### Adapter failure semantics and evidence-preserving recovery (design only)

This subsection closes the failure semantics left implicit by the crash matrix. It is a design constraint for a future Journal v2 implementation; it does not authorize runtime changes or automatic recovery today.

#### Global fail-closed invariants

- A failed, interrupted, or outcome-unknown durability/publication operation is never treated as success or as proof that the namespace change did not occur.
- Preserve the journal, journal temporary, staged file, rollback name, live destination, and every unclassified neighboring entry whenever an operation outcome is uncertain. Do not perform best-effort cleanup after an uncertainty boundary.
- A cleanup operation is itself a namespace transition: it requires its own verified preconditions, no-replace/identity-safe semantics where applicable, and successful required durability. Cleanup failure or uncertain durability preserves remaining evidence and returns manual-review.
- Any lost/closed/replaced handle, invalidated reservation guard, failed reservation assertion, changed parent identity, inventory race, or capability-profile drift immediately invalidates the evidence snapshot and every evaluator decision derived from it.
- Release only resources still owned by the operation, in reverse acquisition order, exactly once. A release failure is recorded as an error; it never authorizes file cleanup or a recovery transition. Do not release a partial member through a public per-lock callback.
- A reservation busy result means the complete reservation set was not acquired. Do not inspect mutable content and do not proceed. A transaction rollback, connection close, or failed live-held assertion means the guard is lost and all prior evidence is stale.
- Sidecar existence, PID values, successful open of one handle, and point-in-time lock inspection are never substitutes for live guard ownership or external-handle exclusion.
- The current v1 implementation remains operator-led. These rules describe future v2 eligibility gates and do not change current classifier output (automaticAction: none).

#### Failure-boundary disposition

| Failure boundary | What may be true after the error | Required disposition |
|---|---|---|
| Staged-file flush fails or its result is unknown | Some or all staged bytes may have reached storage; the staged name may exist | Do not publish rollback or install. Preserve journal and staged candidate. Record bounded failure category; manual-review. |
| File flush reports success but the handle closes/is lost before subsequent verification | The bytes may be durable, but the exact object can no longer be revalidated through the anchoring handle | Invalidate evidence and any decision. Preserve all artifacts; manual-review and recollect only as a new operator-led inspection. |
| Parent-directory flush fails, is interrupted, or is unsupported | A preceding link/unlink may or may not survive a crash | Treat namespace outcome as uncertain. Do not repeat the operation blindly and do not remove aliases/rollback/journal. Manual-review. |
| Journal file flush fails before publication | The temp record may be incomplete or its durability unknown | Preserve the temp candidate. Do not stage or mutate the destination. A fresh read-only inventory may report observations but cannot promote the temp to a valid intent. |
| Journal no-replace publication returns collision | Another entry may already occupy the journal name | Never overwrite or unlink the colliding entry. Preserve both candidate names and inspect under fresh trusted handles; manual-review unless the operation can prove publication definitely did not occur and no conflicting entry exists. |
| Journal publication call returns an ambiguous error or process interruption occurs around publication | The journal name may have been created even though the caller did not receive success | Treat publication as possibly completed. Do not stage, retry publication, or clean the temp. Preserve journal and temp names; perform a complete fresh namespace inventory and validate exact object identity. Without conclusive evidence, manual-review. |
| Handle identity/path-entry revalidation fails | A path may now refer to another object or the retained object may no longer anchor the expected name | Invalidate the snapshot; no rename/link/unlink/install. Preserve all candidates and require manual-review. |
| Reservation acquisition is busy or partially fails | Another cooperating operation may own one or more resources | Do not hash, inspect mutable content, stage, or mutate. Release only successfully acquired reservations in reverse order; report acquisition failure. Retry is a new operation after a fresh complete acquisition, not continuation with partial ownership. |
| Reservation transaction rolls back, connection closes, or live-held assertion fails | The operation no longer owns the complete coordination set | Immediately invalidate all evidence and decisions. Do not mutate or clean artifacts. Release remaining owned reservations safely; manual-review. |
| Complete directory inventory fails, races, or observes an unclassified entry | Relevant artifacts may be omitted or may have changed during enumeration | Set inventory complete=false. Preserve all entries; manual-review. Filename allowlists and a second path scan are not equivalent to a retained-parent, race-aware inventory. |
| No-replace link/publication returns an ambiguous result | The destination may have been created by this operation or by a concurrent actor | Do not retry or unlink either name based on path presence. Re-open and compare through supported retained handles; if exact same-operation identity cannot be proven, manual-review. |
| Any cleanup unlink or its following directory flush fails | The name may remain or reappear after a crash | Preserve all remaining evidence. Do not escalate cleanup to deleting rollback or journal. Report cleanup as incomplete and manual-review. |

#### Journal publication outcome model

The future adapter must distinguish only outcomes it can prove:

1. not-published: the adapter proves the no-replace operation did not create the journal entry, the destination was not occupied by another object, and the relevant namespace observation is still anchored to the trusted parent. This result does not itself authorize staging; the caller must still preserve any temp evidence and handle the failure.
2. published-and-durable: the journal entry is verified as the exact intended object and both required file-data and parent-namespace durability operations completed on a tested platform/filesystem profile.
3. possibly-published: every ambiguous syscall result, interruption, failed/unknown flush, lost handle, collision with uncertain provenance, or inability to revalidate the parent entry.

Only published-and-durable permits the next planned stage in a future v2 executor. possibly-published is terminal for that attempt: preserve the journal candidate, temp alias, and all other artifacts; do not retry publication, start staging, or delete either name. A later read-only inspection may establish facts for an operator, but it cannot retroactively turn an unknown flush result into a proven durability event. If the platform cannot distinguish these outcomes, it must report possibly-published.

The not-published result must not be inferred merely from an exception code or from a subsequent path lookup. It requires adapter-specific tested semantics and parent-entry evidence. If an entry exists at the journal name but cannot be proven to be this operation's exact object, it is a collision/manual-review state.

#### Decision invalidation and release ordering

- The evidence context owns the complete reservation guard, retained parent handles, and retained candidate handles. No decision survives loss of any member.
- A failed flush, failed identity check, failed inventory check, unexpected handle close, reservation loss, or adapter capability change marks the context invalid before any further callback can perform a mutation.
- The executor must check context validity and the same live guard/handle anchors immediately before each individual namespace transition; a prior successful check does not cover a later transition.
- On abort, stop mutation first. Preserve namespace artifacts. Then release still-owned reservations in reverse acquisition order and close remaining handles according to adapter-defined safe ordering. Never release/reacquire and then reuse the old evidence digest.
- If cleanup/close/release itself reports an error, retain the diagnostic and remain manual-review. Do not run a second cleanup path to make the directory appear tidy.

#### Bounded acceptance tests for future adapters

Each injected failure below must assert (a) no subsequent destructive namespace transition occurs, (b) no unrelated or candidate artifact is deleted, (c) the evidence context/decision is invalidated where applicable, and (d) the result is manual-review or an explicitly non-authorizing operation error:

- Inject file flush failure before and after staged-file validation; prove rollback publication and install are not attempted.
- Inject parent-directory flush failure after journal publication, rollback publication, original-name removal, install publication, and cleanup; prove no blind replay or follow-on deletion occurs.
- Inject journal publication collision and ambiguous publication outcomes; prove the adapter never overwrites the colliding object and never starts staging for possibly-published.
- Close or replace each retained source, destination, staged, rollback, and parent handle between evidence collection and executor revalidation; prove the decision is rejected without mutation.
- Force reservation acquisition failure at each member of the sorted set, then force transaction rollback/connection close after acquisition; prove reverse-order release, no partial public release, and stale-decision rejection.
- Mutate the directory namespace during full inventory (addition, removal, replacement, unreadable entry, unknown name); prove complete=false and no candidate action.
- Inject no-replace publication returning an ambiguous result; prove no retry, unlink, or overwrite is attempted.
- Inject temp/journal cleanup unlink and directory-flush failures; prove rollback and all remaining evidence are retained.
- Run the failure matrix in child processes on every claimed OS/filesystem adapter profile. Mock-only tests are unit evidence and cannot establish native flush, share-mode, no-replace, or namespace durability semantics.

**Current implementation note:** the existing Restore catch path has best-effort cleanup branches for the staged file and journal, and the current implementation does not expose the v2 outcome/guard/handle contracts above. This subsection therefore records required future behavior and a concrete implementation gap; it does not claim that current Restore already preserves evidence for every ambiguous adapter failure. Until those implementation changes and native tests exist, no automatic recovery action is eligible.

### Concurrent-operation interleavings and cleanup ownership (design only)

This section defines how the future Restore v2 protocol must reason about competing cooperating operations and non-cooperating namespace actors. It records current coordination gaps; it does not authorize runtime implementation or claim that current path-based operations are race-free.

#### Current coordination boundary

- Backup acquires source-maintenance and destination-maintenance reservations.
- Restore currently acquires destination-runtime and destination-maintenance reservations only. It does not reserve the source Backup for maintenance.
- Therefore, a cooperating Backup operation targeting the same source path can overlap a Restore that is reading/copying that source. Path identity snapshots do not exclude in-place writes through another handle.
- Restore's preflight observations (source validation, WAL/SHM checks, journal/orphan checks, destination kind) are path-based. A successful preflight does not freeze the namespace against a non-cooperating actor.
- Destination reservations serialize cooperating Restore/Backup operations only when they use the same canonical reservation key. They do not prevent arbitrary filesystem mutation or handles held by unrelated software.
- The process-local flags in the current Restore implementation describe only the current call stack. They are not durable transition evidence and cannot arbitrate a competing process after a crash.

#### Required v2 reservation and lock ordering

- Before hashing, validating mutable content, or creating a journal, Restore must acquire one complete deterministic reservation set: destination Runtime, source Maintenance, and destination Maintenance. Backup must acquire source Maintenance and destination Maintenance.
- All operations must derive canonical reservation keys before acquisition and use one documented global sort order. No caller-supplied ordering and no nested acquisition that can invert the order.
- The operation-scoped guard owns the complete set. Partial acquisition failure releases only the acquired prefix in reverse order and aborts before mutable content inspection. No partial guard may be exposed to the evaluator or executor.
- The guard remains live across source hashing, intent publication, staging, rollback publication, installation, and any transition that depends on the protected database identities. Losing any member invalidates the operation context.
- A Restore that cannot reserve its source must fail before inspecting/copying it. It must not downgrade to destination-only locking.
- The lock protocol serializes only cooperating Control Center operations. It must never be described as external-handle exclusion; that is a separate adapter capability and may remain unsupported.

#### Interleaving matrix

| Competing interleaving | Current evidence/behavior | Future required disposition |
|---|---|---|
| Two Restore calls target the same destination | Destination runtime/maintenance reservations should serialize cooperating calls; second acquisition fails busy while first owns them | Keep the second call outside mutable inspection. No journal/temp cleanup by the losing call. Verify canonical-key equivalence and release order in child-process tests. |
| Backup writes the selected Restore source while Restore validates/copies it | Restore currently has no source-maintenance reservation; path identity does not detect all in-place writes | Future Restore must hold source Maintenance for the full evidence lifetime. Without it, no v2 intent or automatic eligibility. |
| Backup destination equals Restore destination | Shared destination-maintenance key should serialize cooperating operations; runtime reservation additionally protects Restore destination | Prove both operations canonicalize to the same key and that a busy acquisition causes no artifact cleanup or content inspection. |
| Backup source equals Restore destination | Backup's source-maintenance reservation and Restore's destination-maintenance/runtime reservations overlap by key class only if key canonicalization is deliberately shared | Define one canonical database identity namespace across reservation classes; otherwise document and test the non-overlap as a conflict requiring a stronger protocol. Never assume different lock classes coordinate. |
| Two Backup operations share a destination but use different sources | Destination-maintenance reservation serializes cooperating publishers | Losing operation must not run stale-temp cleanup until it owns the complete reservation set. No destination overwrite; no deletion of the winner's artifacts. |
| A second process observes a temp/journal name while the first process is active | Filename and PID do not establish ownership; sidecar existence is not live ownership proof | Preserve candidate names. Require complete reservation acquisition and live guard before any cleanup; if ownership cannot be proven, manual-review. |
| A non-cooperating process replaces or mutates source/destination after preflight | Current path checks may detect some replacements but not all in-place writes or retained external handles | Adapter must report transition-specific external mutation exclusion. If unsupported or unproven, evaluator returns manual-review. |
| A destination appears between absence check and no-replace publication | No-replace hard-link publication should fail rather than overwrite | Treat collision as a terminal conflict. Never unlink the competing destination or retry with replacing rename. Preserve staged/journal/rollback evidence. |
| A process crashes after publishing rollback but before updating local flags/returning | Local booleans disappear; both live and rollback names may remain or one may be absent | Reconstruct only from immutable intent and fresh complete evidence. Do not infer the transition from a flag, PID, path presence, or sidecar. |
| A process crashes during cleanup while another operation starts | Cleanup may have removed some names while directory durability is uncertain | The next operation must acquire the complete reservation set, inventory all entries, and preserve all ambiguous artifacts. Cleanup is never inferred complete from the prior process exit. |

#### Cleanup ownership rules

- Only the operation that created a temporary artifact may propose its cleanup, and only while it still holds the complete reservation guard and can prove the exact object identity and expected parent entry. A matching filename/UUID is not ownership proof.
- A process that fails reservation acquisition must not run cleanupStaleMaintenanceTemps, Restore orphan cleanup, journal cleanup, or any other reconciliation against that destination.
- Reconciliation is not a generic preflight side effect. In v2 it must be a separately specified, auditable transition with a complete inventory, explicit artifact class, exact identity binding, no-follow semantics, and a successful namespace durability step.
- Never delete a journal, rollback, or unknown entry merely because another process appears inactive or because a lock sidecar is present/absent.
- A cleanup warning means the operation did not fully clean up. The warning must identify only a bounded artifact category and error code; it must not invite a caller to retry deletion without reacquiring and revalidating the full context.
- If the publishing operation loses its guard after creating an artifact, it stops. A later operation may inspect the artifact but cannot inherit the former operation's cleanup authority from its filename or journal PID.
- If two candidate owners or operation identifiers appear to claim one artifact, preserve it and require manual review.

#### Required concurrency and adversarial tests

- Run two child processes with barriers at each reservation acquisition point. Verify that same-key operations serialize, partial acquisition is released in reverse order, and the losing process performs no content read, staging, or cleanup.
- Race Restore against Backup with the Restore source equal to the Backup source. Verify that the future complete reservation set blocks the competing Backup for the entire source evidence lifetime.
- Exercise source/destination key alias cases (relative versus absolute paths, case behavior on Windows, parent normalization, and equivalent database paths). Verify one canonical key or an explicit fail-closed collision.
- Race two Backup operations with distinct sources and the same destination. Verify one publisher wins, the other preserves its own evidence, and neither deletes the winner's staging directory.
- Inject destination creation/replacement between preflight, rollback publication, original unlink, install publication, and cleanup. Verify no replacing rename, no unlink of an unowned object, and no blind retry.
- Kill the owner after each artifact creation/publication and start a second process. Verify the second process does not treat PID/sidecar/name as stale ownership and does not clean artifacts before complete reservations and inventory.
- Mutate source bytes in place while a Restore is validating/copying. Verify that path-only identity is insufficient and that v2 either excludes the external mutation through a tested adapter capability or returns manual-review.
- Lose the reservation guard immediately before each cleanup step. Verify cleanup is skipped and the stale context cannot be reused.
- Record operation-level outcomes without exposing tokens, database content, arbitrary paths, or raw exception messages.

**Current implementation gap:** the Restore path's source reservation and external mutation exclusion are not implemented. The current tests and cooperating SQLite locks cannot prove arbitrary external handles are absent. These remain Phase 6 implementation prerequisites; current automatic recovery remains disabled.

### Canonical path identity and reservation-key equivalence (design only)

This section separates lexical path normalization, filesystem namespace identity, and opened-object identity. It records the current implementation boundary and defines fail-closed requirements; it does not change runtime lock behavior.

#### Current implementation boundary

- The runtime-lock path helper applies Node path resolution, rejects symlink/junction parent components, creates the parent directory, resolves the parent with realpath, retains the leaf basename, and appends the lock suffix.
- The lock rendezvous path is based on a canonicalized parent pathname plus the original leaf spelling. It is not a stable physical file identifier.
- Relative/absolute forms and dot segments are normalized by the host path API. Parent aliases that are real symlinks/junctions are rejected rather than treated as equivalent. A database leaf that is a symbolic link is rejected.
- The current implementation does not establish general equivalence for case variants, hard links, volume aliases, mount aliases, per-directory case-sensitivity settings, or filesystem-specific namespace behavior.
- Restore journal inspection uses case-insensitive string comparisons for some path-shape checks. Those checks are validation heuristics, not proof that two paths identify the same filesystem object or reservation key.
- Current lock acquisition remains caller-ordered and uses separate runtime/maintenance sidecars. It does not yet provide one operation-scoped guard that globally sorts and atomically owns a complete multi-resource reservation set.
- These observations do not establish future v2 reservation-key or object-identity guarantees.

#### Three identity layers

1. **Lexical path form:** an absolute normalized path after resolving relative segments and separators according to the host path API. This removes simple spelling differences but does not prove namespace equivalence.
2. **Namespace entry identity:** the entry reached under a retained, trusted parent-directory handle, including parent identity, leaf name under that filesystem's actual comparison rules, and a revalidated parent-entry observation. This is required to reason about races and aliases.
3. **Opened object identity:** identity obtained from the retained file handle (for example POSIX device/inode or Windows volume serial/file ID), together with regular-file type and link-count evidence. This can identify an opened object but cannot, by itself, tell the reservation protocol which path key to acquire before opening or make distinct hard-link names share one path-derived key.

The protocol must state explicitly which layer each field represents. A lexical canonical path must never be labelled a physical identity; an opened-object ID must not be retroactively treated as proof that the correct reservation was acquired before inspection.

#### Platform and filesystem equivalence rules

- Do not lowercase all Windows paths. Windows is commonly case-preserving and often case-insensitive, but case sensitivity can be enabled for particular directories and filesystem/provider behavior varies. Case folding is permitted only when a tested adapter can establish comparison semantics for the exact parent namespace and keeps that evidence live for the operation.
- Do not lowercase POSIX paths. POSIX path case behavior is filesystem-dependent; some filesystems or mounted volumes may be case-insensitive or have additional normalization behavior.
- Normalize separators, repeated separators, dot and dot-dot segments only through the platform path implementation and only as lexical normalization. Do not infer physical equivalence from this alone.
- Drive-letter spelling, volume GUID paths, UNC paths, device paths, mount points, bind mounts, and provider-specific aliases require explicit adapter support and tests. Until then, unsupported forms must be rejected or remain ineligible for v2 automatic transitions. Network/remote filesystems remain outside this local-first scope and do not authorize Phase 5.
- Trailing separators and root paths must be handled according to path type; do not strip or fold them with ad hoc string operations.
- Long-path prefixes and alternate namespace spellings must either be normalized by a tested platform adapter or rejected. Do not silently create a second lock key for an alias that the filesystem treats as the same namespace.
- Hard links are distinct directory entries that can identify the same opened object. A path-key protocol cannot claim that all hard-link aliases serialize unless it has an explicit, tested object-identity reservation scheme. Selected hard-link rejection paths are not a general proof that every future source/destination alias has been excluded.
- Parent symlink/junction/reparse traversal remains rejected unless a future adapter provides retained-handle, no-follow resolution with equivalent tested guarantees. A check-then-open path walk is not a race-free substitute.
- If the adapter cannot establish relevant volume/filesystem comparison and namespace semantics, it must fail closed for automatic eligibility. It may still provide a diagnostic lexical key for operator inspection, clearly labelled non-authoritative.

#### Future reservation-key contract

- Derive every requested resource key before acquiring any member of the reservation set. Each key must include a versioned adapter namespace identifier, a stable parent namespace identity, the filesystem-appropriate leaf comparison representation, and the reservation class.
- Keep the database namespace identity common across Runtime and Maintenance classes. Lock class is a separate sort component, not a way to make aliases of the same database appear unrelated.
- Define one global total ordering over namespace identity, leaf identity, and lock class. Every operation, including Restore, Backup, runtime startup, and maintenance, must use that same ordering. No caller-supplied order and no nested acquisition that can invert it.
- Deduplicate identical database-identity/lock-class requests before acquisition. If two lexical inputs resolve to the same proven namespace entry, they must not produce two independent reservations for that same class.
- If two inputs may alias but the adapter cannot prove either equivalence or distinction, abort before mutable content inspection. Do not guess by case folding or comparing path strings.
- Acquire the complete sorted set under one operation-scoped guard. On partial failure, release only the acquired prefix in exact reverse order and abort. Do not expose partial ownership to an evaluator/executor.
- Bind the guard to exact resolved namespace identities, adapter version, filesystem profile, and live reservation transactions. A parent replacement, changed comparison semantics, closed transaction, lost handle, or changed identity invalidates the guard and all evidence derived from it.
- Revalidate the parent and leaf entry through retained handles before each namespace transition. A key computed during preflight is not permanent authority if the namespace can change.
- Keep diagnostic path spellings separate from reservation keys. Avoid logging arbitrary full paths or secret-bearing path components in operational output.

#### Required test matrix before v2 implementation

- Lexical normalization: relative versus absolute paths, dot/dot-dot, repeated separators, trailing separators, and platform root handling.
- Windows: drive-letter case variants, UNC and volume aliases where supported, long-path prefixes, case-sensitive directory behavior, and two names differing only by case on both case-sensitive and case-insensitive directories.
- POSIX: case-sensitive names, case-insensitive filesystem profiles where available, mount/bind-mount aliases where supported, and Unicode/name-normalization behavior where the filesystem exposes it.
- Parent aliases: symlink, junction, reparse point, renamed/replaced parent, and parent handle identity changes. Unsupported alias forms must fail closed.
- Object aliases: hard links to the same database object, replacement of a leaf between key derivation and open, and file-ID/inode reuse or mismatch scenarios within adapter limits.
- Reservation behavior: same proven namespace entry through different accepted spellings yields one key; distinct entries remain distinct; ambiguous aliases abort; duplicate requests are deduplicated; all operations sort identically; partial acquisition releases in reverse order; two child processes cannot deadlock through inverse caller order.
- Cross-class behavior: Runtime and Maintenance keys for one database share the same namespace identity and sort deterministically; Backup source versus Restore destination conflicts are covered even when supplied through different accepted path spellings.
- Run native tests on every claimed OS/filesystem profile. Mock-only path tests do not establish filesystem comparison, volume identity, reparse behavior, or cross-process reservation semantics.

**Acceptance boundary:** until the adapter can prove a stable namespace key and the complete reservation guard remains live, v2 automatic recovery is ineligible for that operation. A lexical path match, case-insensitive string comparison, PID, sidecar pathname, or opened file ID alone is insufficient. Phase 5 remains deferred and no remote path or transport is introduced by this contract.

### Reservation guard lifecycle, acquisition failure, and release semantics (design only)

### Restore source-to-install binding and journal publication boundary (design only)

#### Current implementation boundary
- `restoreDatabaseBackup()` currently acquires only the destination Runtime reservation followed by the destination Maintenance reservation. It does not reserve the selected backup source. The source is validated by path, copied by path, and compared before/after using `lstat`-derived device/inode/size/mtime/ctime snapshots; this detects several ordinary replacement or mutation cases but is not a retained-handle content binding and does not exclude a concurrent writer or namespace actor.
- The current v1 journal is published after source validation and before staging. It records PID, timestamp, and four paths only. It does not bind the selected source bytes, staged bytes, destination-at-intent state, parent identities, reservation ownership, or platform capabilities. A valid v1 journal therefore cannot authorize continuation or rollback.
- The current Restore flow validates the source path, then `copyFileSync`s it to staging. A post-copy path metadata comparison is not proof that the copied bytes came from the exact validated source object if an actor can mutate/replace the source across the interval. Validation of the staged SQLite file protects the installed candidate's database structure, not its provenance or equality to the selected backup.

#### Required v2 source and destination binding
- Before hashing, validation, journal publication, or artifact cleanup, Restore must acquire one complete operation-scoped reservation set: destination Runtime, source Maintenance, and destination Maintenance. The request set is canonicalized, deduplicated, globally sorted, and acquired as one guard; partial acquisition unwinds in reverse order and performs no content inspection or cleanup.
- The source Maintenance reservation is a coordination boundary for cooperating Control Center maintenance operations only. It does not prove arbitrary external writers or handles are absent. A separate transition-specific `externalMutationExclusion` capability is mandatory; if the adapter cannot prove the required exclusion for the source-read/stage interval, Restore is ineligible for automatic recovery and must remain operator-led.
- Retain the exact opened source handle and trusted source/destination parent handles. Derive source identity, link count, size, and digest from that handle; verify its directory entry still names the same object. Bind the immutable intent to the source digest/length and source identity, not merely its path. Do not reopen by path and treat that as the same source.
- Stage bytes from the retained source handle (or an adapter primitive with an equally explicit same-object guarantee). Hash the staged object independently and require exact digest and byte-length equality with the intent source. Run SQLite integrity, foreign-key, and supported-schema validation against that exact staged object. The installed object must remain the same staged object whose digest and validation were recorded.
- Bind destination state at intent time explicitly (`destinationExisted` plus exact original destination digest/identity when present). A destination appearing when intent said absent, or changing identity/content when it said present, is a collision/contradictionÃ¢â‚¬â€not permission to overwrite. Rollback publication and install each require fresh same-context evidence and no-replace semantics.
- Publish the immutable v2 intent only after the complete guard, retained parent/source handles, capability profile, and source/destination evidence have been established, but before creating staged or rollback artifacts and before any destructive namespace transition. The journal binds operation UUID, canonical reservation-set digest, source/staged expected digest and length, destination initial state, parent/file identities, adapter/evaluator versions, and required durability capabilities. It contains no bearer authority and no mutable phase flag.
- The journal's publication result must distinguish not-published, published-and-durable, and possibly-published. Only published-and-durable permits staging. Possibly-published is terminal for that attempt: preserve journal and every artifact, invalidate the context, and require operator review; do not guess publication success or clean up.

#### Source/destination interleavings and acceptance tests
- Restore must serialize against Backup using the same source Maintenance reservation key when the selected backup path is also a Control Center-maintained database path. Tests must cover Backup writing the selected Restore source, Backup publishing to the Restore source path, Backup destination colliding with Restore destination, and aliases that resolve to the same reservation key.
- A competing process that ignores the SQLite reservation must be used to test the adapter's claimed external-mutation exclusion. If it can write through a pre-existing handle or replace the source entry during hashing/staging, the capability is unsupported for that platform/filesystem and no automatic decision may be emitted.
- Inject source mutation/replacement after open, during hash, after intent publication, during staging, after staged validation, and immediately before install. Every mismatch must prevent install and preserve evidence; no path-only re-stat may upgrade a mismatch to success.
- Verify source and staged digest/length equality, exact staged-object SQLite validation, destination-existed/absent collision handling, source reservation loss, handle replacement, parent replacement, capability drift, and journal publication ambiguity. Each failure must prove no unauthorized namespace mutation and must retain artifacts required for diagnosis.
- These requirements do not change current runtime behavior or authorize automatic Restore recovery. Current v1 Restore remains operator-led; Phase 6 is still design-only until separately started and implemented with native platform evidence.


This section defines the future operation-scoped guard lifecycle. It does not introduce a runtime guard or change the current fail-fast SQLite lock behavior.

#### Current lifecycle behavior and limits

- Each current lock acquisition opens a separate SQLite sidecar connection and starts BEGIN IMMEDIATE. The live transaction, not the persistent sidecar file, represents ownership.
- The returned release closure is idempotent: it marks itself released before attempting ROLLBACK, then closes the connection in a finally block. A second invocation is a no-op.
- If ROLLBACK throws, connection close is still attempted. The release closure does not retry rollback; connection close is the final release attempt available to that closure. A close failure may still propagate.
- Backup acquires source Maintenance and then destination Maintenance; its finally block releases destination then source. If destination acquisition fails, the optional destination release is skipped and source is released.
- Restore acquires destination Runtime and then destination Maintenance; its finally block releases Maintenance then Runtime. If Maintenance acquisition fails, Runtime is released.
- These nested try/finally structures provide reverse release for the current fixed two-lock paths. They do not provide a shared guard, a globally ordered acquisition set, or proof that all future call paths use the same order.
- SQLite busy acquisition currently fails rather than establishing a waiting queue contract. Opposite-order operations can therefore fail fast under contention; they must not be described as proven deadlocks in the current implementation. A future wait/retry policy without a global order could turn the same pattern into a deadlock.
- Current tests cover exclusive cross-process ownership, crash release, and lock release on success/failure paths. They do not yet prove a general multi-resource guard state machine, acquisition-order invariance, or injected failure at every release boundary.

#### Required guard state machine

The future guard must have explicit, monotonic states:

1. new: request set is immutable and validated; no reservation is owned.
2. acquiring: resources are acquired in the one global total order. Only the successfully acquired prefix is owned.
3. held: the entire deduplicated reservation set is owned, every underlying transaction is live, and the guard is bound to the exact resource identities and adapter context.
4. releasing: no new acquisition or protected operation may begin; owned reservations are released in reverse acquisition order.
5. released: all owned transactions have been closed successfully, or the guard is terminally invalidated with a recorded release failure. It can never be reused.
6. invalid: a transaction, connection, handle, or parent identity was lost, replaced, or found inconsistent. No evaluator/executor action or cleanup may use this guard.

The implementation may represent terminal release failure separately from released, but it must never report a fully successful release when any close/release operation failed. Repeated release calls must be safe and must return or retain the same terminal outcome rather than re-running ownership transitions.

#### Acquisition algorithm and partial failure

- Freeze the complete request set before acquiring anything. Each item contains the proven namespace identity, reservation class, adapter/version context, and a stable sort key.
- Deduplicate exact (namespace identity, reservation class) duplicates. Reject unresolved alias ambiguity before acquisition.
- Sort once using the single global total order. No operation may acquire a subset in caller order and then append another resource.
- Acquire sequentially and record each successful acquisition in a private guard-owned stack. Do not publish a partially acquired guard to callers, inspectors, evaluators, or executors.
- If acquisition N fails, stop immediately. Release only the acquired prefix N-1 through 1 in exact reverse order, then return the original acquisition failure with bounded release-failure metadata. Do not continue to later resources, inspect mutable content, create artifacts, or perform cleanup.
- If acquisition fails partway, release only the acquired prefix. A failed acquisition must not trigger stale temp/orphan reconciliation. Cleanup authority exists only after the complete guard reaches held, and only for artifacts whose exact ownership is separately established.
- If a release in the partial-failure unwind fails, continue attempting to release the remaining earlier acquisitions in reverse order. Preserve every failure in a bounded structured outcome; do not replace the original acquisition error with the first cleanup error.
- A guard with uncertain ownership after any release failure is terminally invalid. It cannot be passed to an evaluator or reused for another attempt. The caller must stop and preserve evidence.

#### Held lifetime and invalidation

- The guard remains held for the full interval in which any protected evidence or transition depends on those resources. For Restore v2 this includes source/destination inspection, hashing, immutable intent publication, staging, rollback/install transitions, and separately authorized cleanup.
- The guard exposes only safe assertions such as isHeld() and immutable resource descriptors. It must not expose raw release callbacks, transaction objects, mutable internal arrays, or a caller-controlled partial-release method.
- isHeld() must verify the actual live transaction/connection anchors, not merely a boolean set at acquisition time. A closed connection, rolled-back transaction, lost parent/file handle, changed namespace identity, or adapter profile drift invalidates the guard.
- Invalidation is monotonic. Reopening an equivalent lock, reacquiring the same sidecar, or reconstructing a guard from a path/PID does not restore the original evidence lifetime.
- The guard must be released exactly once by its owning operation. A different process or later invocation cannot inherit release or cleanup authority from a journal, lock pathname, operation UUID, or PID.
- No asynchronous gap may permit the guard to be silently replaced between a successful held assertion and a protected synchronous namespace transition. If asynchronous operations are later introduced, cancellation and ownership checks are required at every await boundary.

#### Release protocol and error handling

- Release all owned resources in exact reverse acquisition order, attempting every release even if an earlier release fails.
- Each individual reservation release remains idempotent. It must attempt transaction rollback and always attempt connection close. It must report whether the transaction was rolled back, whether close succeeded, and whether ownership is now known to be gone; unknown is not success.
- A rollback failure followed by successful connection close may establish that this connection no longer owns the SQLite transaction, but must not erase the rollback error from the operation outcome. A close failure leaves ownership uncertain and invalidates the guard.
- Preserve the primary operation error. Attach bounded release outcome codes without leaking raw SQLite messages, tokens, database paths, or database content. If the main operation succeeded but release failed, report the overall operation as failed/uncertain; never return success while a reservation may remain held.
- After release begins, no protected transition, retry, cleanup, or evaluator action may start. If release is incomplete or uncertain, preserve journal and artifacts for operator inspection.
- A process crash is handled by SQLite/OS connection teardown as today; the persistent sidecar remains. Sidecar existence is not a live guard and must never be used to reconstruct one.

#### Deadlock and liveness requirements

- Global ordering must be shared by Backup, Restore, runtime startup, and every maintenance path. It must include namespace identity and lock class in a documented total order.
- No nested acquisition is allowed outside the guard. A helper that already owns one reservation may not call another helper that independently acquires a second resource in an order unknown to the guard.
- The guard must be the sole owner of acquisition/release. Domain operations receive a held guard/context and cannot independently acquire or release its members.
- Prefer fail-fast busy behavior for the initial implementation. If bounded waiting or retry is later introduced, it must use the same global ordering, a bounded deadline, cancellation semantics, and tests proving no resource is held while waiting for a resource that sorts earlier.
- Retries must restart the entire acquisition attempt from an empty set after complete unwind. Never continue from a partial prefix after contention.
- No fairness guarantee should be claimed unless the underlying mechanism and scheduling behavior are explicitly tested. Liveness failure or repeated contention remains a bounded operational error, not permission to bypass a reservation.

#### Required tests before guard implementation is accepted

- Unit state-machine tests for every valid transition and rejection of invalid/repeated transitions.
- Inject acquisition failure at every position in a multi-resource sorted set; assert exact reverse unwind, no later acquisition, no content inspection, no artifact creation, and no cleanup.
- Inject rollback and close failures independently at every release position; verify all remaining releases are attempted, original operation/acquisition error is retained, uncertain ownership invalidates the guard, and success is never reported.
- Verify duplicate request deduplication and exact one-time release; verify no raw partial release capability is exposed.
- Use child processes and barriers to run opposite caller-order requests. Verify the guard sorts identically, serializes or fails boundedly, and never enters a wait cycle.
- Race Backup source/destination reservations with Restore destination Runtime/source Maintenance/destination Maintenance reservations. Verify shared database identity across lock classes and one common ordering.
- Verify losing acquisition performs no mutable reads, stale cleanup, journal publication, staging, or namespace mutation.
- Verify guard invalidation after connection close, transaction rollback, parent replacement, handle close, adapter-version change, and namespace-profile drift. Previously derived evidence must become unusable.
- Verify repeated release after success, partial unwind, rollback failure, and close failure is deterministic and never re-enters a completed release.
- Run native cross-process tests on each claimed supported OS/filesystem profile. In-process mocks alone do not establish SQLite/OS lock lifetime or process-death behavior.

**Acceptance boundary:** until the complete operation-scoped guard, global ordering, reverse unwind, terminal error semantics, and adversarial child-process tests exist, current per-file lock closures remain the only implemented mechanism. They are not a v2 guard. Automatic Restore recovery remains disabled and operator-led. Phase 5 remains deferred.

### Artifact classification and Journal/operation binding (design only)

#### Current implementation boundary
- The current v1 journal contains four paths but no operation UUID. UUID-shaped filename tokens are checked independently for staged and rollback names; this is a naming-shape check, not proof that either object was created by the journal's operation.
- The inspector's artifacts object is populated from paths read from the journal. It reports path existence/kind/size, but does not prove that the journal path, journal temporary hard link, staged file, rollback file, or live destination are the same objects observed during one stable inventory.
- The journal-present path currently inventories only UUID-shaped journal temporary names in the destination directory. The journal-absent path recognizes selected filename patterns. Neither path classifies every directory entry or establishes ownership of an artifact.
- The v1 journal has no strict canonical schema/checksum or operation UUID binding. A valid-looking path and UUID token therefore cannot be promoted into provenance or cleanup authority.

#### Required v2 artifact identity model
- Define one immutable operation UUID at operation creation. Every artifact role has one exact canonical basename grammar derived from that UUID and the intended destination namespace; the grammar is versioned and case-sensitive only where the tested filesystem adapter can prove that comparison rule.
- The immutable journal must bind, by role, the exact canonical path, expected parent identity, artifact name, expected object type, content digest/length where applicable, and publication semantics. It must also bind the operation UUID, operation kind, schema version, and reservation-set digest.
- Artifact roles are distinct and non-interchangeable: journal, journal-publication temporary, staged database, rollback/original database, and installed live database. A matching UUID token never makes one role valid as another role.
- Every observed entry is classified independently of its name. The classification result must include the bounded entry name, role candidate, object kind, stable object identity and link count where supported, exact parent identity, open/inspection result, and whether it matches exactly one journal role. Unknown, duplicate-role, multiply-matched, aliased, malformed, or unclassifiable entries make the inventory incomplete and the operation manual-review.
- Journal path agreement is exact under the active adapter's proven namespace comparison rules. Do not use unconditional lowercasing as a substitute for filesystem semantics. A case/normalization collision, alternate path spelling that cannot be proven equivalent, cross-parent artifact, or UUID disagreement is a contradiction, not a candidate to repair.
- A journal's presence or valid checksum does not establish that its listed artifacts exist, are operation-owned, or have expected content. Conversely, a recognized artifact without a valid journal remains unowned evidence and must be preserved.
- A journal temporary hard link may be treated as the same journal object only after handle-derived object identity and link-count evidence establish the relationship under the tested adapter. Name resemblance or equal contents are insufficient.
- The inventory projection and journal binding are immutable for one evaluation attempt and are tied to the same retained parent handles, complete reservation guard, adapter profile, and operation context. Re-enumeration or any identity/content/path change invalidates the projection; a new attempt must collect fresh evidence.
- A role match is not cleanup permission. Cleanup requires the exact object identity, proof that the current operation created/owns that object, complete live guard, fresh same-context evidence, no aliases outside the approved namespace, and a separately accepted no-replace/durability transition. Otherwise preserve it for operator review.
- Never infer operation ownership from PID, timestamp, UUID-shaped name, file content alone, journal path alone, or the fact that the current process can open the file.

#### Required adversarial tests
- Correct UUID but wrong role suffix; correct role suffix but wrong UUID; journal path points outside the declared parent; duplicate candidates for one role; two roles resolving to one object; and one entry matching multiple roles.
- Journal UUID differs from staged/rollback/temp tokens; malformed/noncanonical UUID; unknown journal fields/version; checksum-valid but contradictory paths; checksum mismatch; and journal replacement between read and evidence binding.
- Journal temporary name and published journal name are hard links to one object, then to distinct equal-content objects; verify only the former can satisfy the alias relation when identity/link evidence is complete.
- Case-folding and Unicode-normalization collisions on filesystems with differing semantics; never assume the same comparison behavior across Windows and POSIX.
- A valid-looking artifact located in another directory, a parent renamed/replaced after enumeration, and an artifact moved between enumeration and handle inspection.
- Regular file replaced by directory, symlink/reparse point, hard link, device/FIFO/socket where supported, or another non-regular object; all unsupported kinds remain incomplete/manual-review.
- Unknown filename, duplicate name under adapter comparison rules, unreadable entry, partial enumeration, concurrent add/remove/replace, identity reuse, and adapter capability loss.
- Prove that no cleanup occurs on filename/UUID match alone, on a stale serialized decision, after guard/handle release, or when an artifact's exact operation ownership cannot be established.

**Acceptance boundary:** current v1 inspection remains diagnostic and operator-led. This section defines future v2 evidence requirements only; it adds no runtime artifact ownership, no cleanup authority, and no automatic recovery. Phase 6 implementation is in progress, but this section remains design-only; Phase 5 remains deferred.
