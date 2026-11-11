# Phase 6 — Deferred Capability Closure: Acceptance Plan

**Status:** Planned; no Phase 6 implementation is authorized or started by this document.
**Parent plan:** `docs/ROADMAP.md`.
**Boundary:** Phase 5 remains Deferred. This plan does not authorize remote binding, tunnels, proxies, port forwarding, external repository changes, or arbitrary code execution.

Phase 6 closes the Deferred inventory recorded when it was added. A workstream is closed only when its design, implementation, regression/failure-mode tests, and operator documentation are complete. Re-labeling an item is not closure.

## 1. Structured operational logs (carried from Phase 2)

### Current baseline
- The application currently emits a small number of human-readable startup, shutdown, lease-reconciliation, and maintenance messages.
- CLI JSON/stdout responses and one-time credential displays are command interfaces, not operational logs; they must remain separate.
- No shared structured operational event schema is currently established.

### Required design
- Use a versioned schema with a fixed event-name allowlist and per-event field allowlists.
- Minimum envelope: schema version, event name, UTC timestamp, severity, process instance identifier, and a bounded correlation/operation identifier where available.
- Event-specific fields must be typed, bounded, and non-sensitive. Prefer counts, enums, durations, and opaque operation identifiers over user-controlled strings.
- Never log Operator/Participant/Lease tokens, credential hashes, authorization headers, request bodies, Task payloads/results, raw exception objects, arbitrary URLs/userinfo, or unrestricted filesystem contents.
- Error reporting must map failures to bounded error codes/categories. Do not serialize stack traces or error messages unless a separately reviewed sanitizer proves they contain no secrets or user data.
- Define output destination, encoding, maximum event size, behavior when the sink fails, and operator retention/rotation responsibilities. Logging failure must not silently change task/lease/authorization outcomes; security-critical failure behavior must be explicit.
- Keep CLI contract output and one-time secret output out of the operational logger.

### Acceptance evidence
- Unit tests reject unknown event names and unknown fields.
- Redaction tests inject token-shaped values, authorization headers, task payload/result sentinels, URL userinfo, and exception messages; none may appear in emitted records.
- Bounds tests cover oversized strings, invalid enums, excessive event frequency/cardinality, and malformed values.
- Child-process tests verify startup/shutdown and lease-reconciliation events without leaking the bootstrap token.
- Documentation specifies schema evolution, destination, retention, sink failure behavior, and how operators collect diagnostics safely.

## 2. Automatic Restore Recovery (carried from Phase 2)

### Current baseline
- Restore publishes a versioned intent journal atomically and refuses a second Restore while the journal exists.
- A read-only inspector inventories journal, lock, live, temporary, and rollback artifacts and classifies observed combinations.
- Runtime/maintenance ownership uses SQLite `BEGIN IMMEDIATE` reservations; a persistent sidecar's existence alone does not prove a live owner.
- Crash-injection coverage already exercises journal publication, staging, rollback publication/original move, installation, temporary cleanup, and journal cleanup.
- The current classifier intentionally returns `automaticAction: none` for every state. It is diagnostic, not a recovery executor.

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
- A written state/transition matrix maps every journal/artifact/lock combination to exactly one of: safe automatic continuation, safe automatic rollback, or manual review. No implicit/default action is allowed.
- Child-process crash injection occurs immediately before and after every durable transition, then runs recovery repeatedly and verifies the same final result.
- Tests cover path replacement, symlink/junction parents, hard-link and identity changes, malformed/truncated journals, unknown fields/versions, source mutation, destination collisions, stale-looking and active locks, unreadable directories, disk-full/permission/fsync failures, and unsupported filesystem behavior.
- Windows CI verifies actual supported crash-state behavior; POSIX CI verifies its corresponding durability behavior. Unsupported combinations remain manual-review states.
- Tests prove no unrecognized or unrelated artifact is deleted and no existing file is overwritten.
- Operator runbook explains inspect, automatic recovery outcomes, manual-review escalation, and credential/Participant rotation after a snapshot Restore.

## 3. Remaining Deferred inventory

The following items were listed in the Architecture Deferred section when Phase 6 was introduced. Every item needs a bounded design, implementation, and verification before Phase 6 exits. A separate authorization gate may delay execution of a workstream, but it does not count as completion:

- **Phase 5 remote/multi-machine operation:** remains blocked until explicit operator authorization. Before implementation: fresh threat model, authenticated transport and identity lifecycle, credential rotation, replay protection, bounded resource controls, and consistency/partition semantics; then cross-machine and adversarial tests. Loopback-only remains mandatory until separately authorized.
- **Plugin marketplace:** establish provenance/signing, version policy, isolated execution boundary, capability permissions, install/update/rollback, revocation, and audit. Never load arbitrary extensions into the Control Center process.
- **Autonomous scheduling:** define ownership, bounded policy, idempotency, lease/concurrency interaction, cancellation, audit, and operator kill switch. Uncertain non-idempotent work must not be replayed.
- **Dashboard analytics:** select actionable metrics, privacy-safe aggregation, bounded query cost, freshness semantics, and authorization. Analytics remain read-only and cannot decide task authorization/state.
- **Automatic retries for external work:** no generic blind retry. Define explicit per-task retry contracts, idempotency guarantees, budgets/backoff, side-effect reconciliation, and opt-in policy. Tasks without a proven safe contract remain blocked for operator review.

## 4. Phase 6 governance and exit

- Phase 6 work must not begin until explicitly scheduled/authorized by the operator; this document is planning evidence only.
- Phase 5 remote work requires its own explicit authorization even while Phase 6 is active.
- Keep the existing local-first and loopback-only security boundary until that authorization and its acceptance gates are satisfied.
- Each workstream must have implementation, tests, documentation, and operational evidence recorded before its checkbox is marked complete.
- At Phase 6 exit, every item in the Deferred inventory captured at Phase 6 creation must be completed and verified; none may remain Deferred, merely undocumented, or be silently dropped/re-labelled. The remote/multi-machine workstream remains subject to the separate explicit authorization gate; until that authorization is given, Phase 6 cannot be declared complete while that item is still pending.
