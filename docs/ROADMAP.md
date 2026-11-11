# Raya Control Center Roadmap

Status labels: **Not started**, **In progress**, **Verified**, **Blocked**, **Deferred**.
A phase is complete only when repeatable tests or operational evidence satisfy its exit criteria.

## Phase 0 — Product foundation
**Status: In progress**
- [x] Independent repository and ownership boundary.
- [x] Architecture, data model, security principles, API contract, and ADR documented.
- [x] GitHub Actions CI workflow added.
- [x] Development instructions and operator runbook (`docs/DEVELOPMENT.md`, `docs/OPERATIONS.md`).
- [ ] Review and merge the foundation PR.

## Phase 1 — Durable coordination core
**Status: Implemented and tested**
- [x] Versioned SQLite migrations and WAL mode.
- [x] Participant registration, scoped credentials, authentication, and revocation.
- [x] Task creation and lifecycle state machine.
- [x] Atomic task claims and time-bounded leases.
- [x] Lease ownership and expiry enforcement.
- [x] Cooperative cancellation and append-only event journal.
- [x] Atomic entity writes and audit-event writes.
- [x] Database-enforced append-only event history.
- [x] Concurrent claim test using independent SQLite connections.
- [x] WAL recovery test after abrupt process exit.
- [x] Expired lease reconciliation without blind retry.
- [x] Participant revocation blocks tasks held by that participant.
- [x] Operator/Participant/Scope/Lease authorization tests.
- [x] Malformed input and safe error-response tests.
- [x] Lease-bound progress, independent of heartbeat.
- [x] Consistent SQLite backup and validated offline restore.

### SQLite runtime decision
For the MVP, use the built-in `node:sqlite` API with Node.js **24.15.0 or newer**.
Node 24.15+ marks SQLite as a Release Candidate; Node 26 is the preferred Active LTS line.
This is an accepted MVP constraint, not a claim that the API is fully Stable.
Reassess before 1.0; retain the option to move to a mature SQLite adapter if the API contract changes.

**Exit criteria:** state survives process restart; concurrent claimers cannot own the same task; stale or revoked lease holders cannot mutate tasks; state and audit events commit atomically; uncertain non-idempotent work is not automatically retried.

## Phase 2 — Local operator interface
**Status: Implemented and tested**
- [x] Loopback-only HTTP API with Host-header allowlist and no CORS.
- [x] One-time operator-token bootstrap and authenticated, immediate token rotation through the live API.
- [x] Participant registration, read, list, and revocation endpoints.
- [x] Task create/read/list/cancel and worker claim/lifecycle endpoints.
- [x] Separate participant bearer and lease-token authentication.
- [x] Strict 16 KiB request-size and JSON validation.
- [x] HTTP header limit (8 KiB), bounded header/request receipt timeouts, bounded keep-alive, and per-socket request count.
- [x] Raw TCP coverage for oversized headers, malformed framing/UTF-8, incomplete request-body disconnects, and response disconnects.
- [x] Safe 413 connection closure and destroyed-response handling.
- [x] Graceful SIGINT/SIGTERM shutdown: close idle connections, drain active requests for up to 10 seconds, then force-close before closing SQLite.
- [x] Startup and periodic expired-lease reconciliation; operator-triggered reconciliation endpoint.
- [x] CLI for participant registration/read/revocation, task create/read/cancel, events, health, lease reconciliation, and Operator token rotation.
- [x] Consistent SQLite backup and validated offline restore with rollback file.
- [x] Added an atomically published, fsynced Restore intent journal that blocks repeat Restore after a process crash; documented operator-led recovery. Automatic recovery remains deferred pending journal-state interpretation and Windows crash-state verification.
- [x] Added read-only Restore inspection and a conservative recovery-state model covering journal validity, active/unrecognized SQLite lock reservations, persistent idle lock sidecars, and live/temporary/rollback artifact combinations; child-process crash simulations cover journal publication, staging, original move, install, temporary cleanup, and journal cleanup. Runtime and maintenance ownership now use SQLite `BEGIN IMMEDIATE` reservations that release automatically on process death; legacy JSON lock artifacts are preserved for operator review. No state performs automatic file or lock actions.
- [x] Lease-bound task progress reporting, separate from heartbeat, with append-only audit events.
- [ ] Structured operational logs (deferred until an allowlisted, redacted event schema is justified).

## Phase 3 — Integration contracts
**Status: Verified**
- [x] Publish versioned integration contract for Participant, Task, Lease, progress, heartbeat, cancellation, and recovery semantics.
- [x] Add simulated independent HTTP client contract tests for success, cancellation, and participant revocation.
- [x] Define future Raya-Agent participant requirements in `CONSUMER-REQUIREMENTS.md`.
- [x] Define future Raya-MCP adapter requirements and credential boundary in `CONSUMER-REQUIREMENTS.md`.
- [x] Verify Participant kind, Operator credential separation, and current `tasks:claim` scope behavior with an independent HTTP authorization test.
- [x] Add a separately runnable Node.js Reference Worker with environment-based credentials and no Operator token.
- [x] Restrict executable task handling to harmless `demo.echo` and bounded `demo.delay` allowlist entries; unknown types fail safely.
- [x] Add real worker-process integration tests for success, cooperative cancellation, unsupported task failure, empty-queue polling, stale lease expiry, and stop behavior.

This phase does not authorize development in either external repository. Raya-Agent and Raya-MCP remain future consumers/adapters only.

### Capability-aware Task routing
- [x] Approve TASK-ROUTING-DESIGN.md (2026-11-08).
- [x] Add migration, Operator-managed Participant capabilities, and Task required-capability metadata.
- [x] Filter atomic claims by exact capability-set inclusion; leave unmatched Tasks queued.
- [x] Add backward-compatibility, core routing, HTTP, audit, and active-Lease preservation tests.
- [x] Add an Operator-only exact routing summary and expose required/available capabilities in the read-only Dashboard.
- [x] Complete focused owner-led AI-assisted security review of capability routing; record tested cases, findings, and owner decisions in `docs/SECURITY-REVIEW.md` (2026-11-11).

## Phase 4 — Dashboard and operational hardening
**Status: In progress**
- [x] Operator-authenticated dashboard for task, participant, health, and audit inspection; blocked-task history inspection and explicitly confirmed, API-revalidated manual requeue. No payload/result rendering or automatic retry.
- [x] Participant detail inspector with creation/update/last-seen metadata and append-only registration, capability-change, and revocation history; revocation history identifies tasks blocked by the action. Event details are rendered from explicit allowlisted fields only; credentials are never displayed.
- [x] Operator-only Participant capability editor with sorted before/after diff, identifier/duplicate/64-item validation, explicit acknowledgement, final native confirmation, and append-only audit through the existing API. Editing is hidden for revoked/disabled Participants, and the API transaction rejects updates unless the Participant is still active; changes affect future claims only and preserve active Leases. Dashboard DOM-harness regression covers preview, rejection of duplicate identifiers, confirmation, API request, refreshed details, and audit history.
- [x] Chrome 157 headless acceptance of the capability editor on an isolated in-memory SQLite database and loopback-only server: Operator login, capability diff, acknowledgement gating, exact final confirmation, API persistence, audit-history refresh, empty browser storage, and editor/token cleanup on disconnect. Temporary Chrome profile and acceptance script removed; no live `.data` used.
- [x] Manual Chrome acceptance on an isolated temporary database: valid/invalid Operator login, routing metrics, capability columns, task/participant filters, disconnect cleanup, and 390px responsive layout.
- [x] Chrome 157 headless acceptance of blocked-task inspection and controlled requeue against an isolated in-memory SQLite database: login, event history, payload non-rendering, browser-storage check, both confirmations, requeue, and audit event. No live `.data` used.
- [x] Audit/event explorer with entity filters.
- [x] Backup, restore, and recovery tests for WAL snapshots and corrupt/unsafe restore inputs.
- [x] Upgrade and packaging review: private distribution policy, runtime matrix, package allowlist, and bundle contents documented and verified.
- [ ] Remote exposure remains disabled and out of scope; do not enable it under the current loopback-only project constraints.

## Phase 5 — Optional remote/multi-machine operation
**Status: Deferred**
Requires an explicit product decision, threat-model review, authenticated transport, credential rotation, replay protection, and a defined consistency model. The current API must remain loopback-only.

## Progress reporting rule
Distinguish **Documented**, **Implemented**, **Tested**, and **Operational**.
Never report completion based only on file creation.
### Security review preparation
- [x] Create an evidence-based internal review register in docs/SECURITY-REVIEW.md; identify confirmed redaction-policy mismatch SEC-001.
- [x] Remediate SEC-001: keep task results on Task records and restrict audit events to bounded metadata; regression tests added.
- [x] Make Operator token rotation immediate in the running server; reject offline rotation that could desynchronize server and database credentials.
- [x] Redact echoed Operator credentials from CLI API error output.
- [x] Implement and test offline Operator token recovery under an exclusive per-database runtime lock.
- [ ] Complete the owner-led, AI-assisted review across HTTP/authentication, task/lease authorization, persistence/recovery, dashboard, CLI, and Worker boundaries.
- [ ] Keep the API loopback-only. Owner-led review does not authorize remote binding, tunnels, proxies, or port forwarding.

### Owner-led security review progress — 2026-11-11

- [x] Review Backup/Restore locking, WAL snapshots, validation, journals, rollback, crash boundaries, and platform durability limitations.
- [x] Review loopback HTTP Host/request-target handling, Bearer-only authorization, browser CORS/preflight behavior, and dashboard security headers; add a cross-origin regression test.
- [x] Add isolated multi-connection concurrency regressions for completion/cancellation, completion/revocation, and heartbeat/expiry reconciliation; repeat race tests five times.
- [x] Reject HTTP redirects in CLI, Worker, and Dashboard API clients to prevent forwarding request bodies and lease credentials to another origin; add redirect regression tests (SEC-014).

- [x] Consolidate owner-facing confirmed findings, remediation evidence, residual risks, and review boundaries in the security register (2026-11-11).

- [x] Inspect dashboard DOM sinks and CLI/Worker credential lifecycles; record bounded evidence and remaining same-process trust boundaries (2026-11-11).

- [x] Recheck post-body Operator authorization and transactional Participant/Lease validation, including revocation during a delayed request body (2026-11-11).

- [x] SEC-015: suppress native URL-parser diagnostics that could echo malformed Worker API URL userinfo; add a child-process regression (2026-11-11).

- [x] SEC-016: make Restore inspection fail closed on symlinked/junction database parents so recovery journals are not read through path aliases (2026-11-11).
- [x] Reject unsupported SQLite schema versions before changing file permissions or journal mode; centralize the latest supported schema version across migration and Backup/Restore validation (2026-11-11).

- [x] SEC-018: restrict Backup/Restore temporary cleanup to artifacts created by the current operation; preserve UUID-shaped regular files and unexpected staging contents; add collision/race regressions (2026-11-11).

- [x] SEC-019: replace overwrite-capable Restore rollback renames with no-replace hard-link transitions; cover rollback-path collisions and the intermediate crash state (2026-11-11).
- [x] SEC-020: reconcile recognized Backup staging left by a crash immediately after publication; preserve the already-published backup on retry (2026-11-11).
- [x] SEC-021: detect Restore source-path replacement between preflight validation and staging; add deterministic regression coverage (2026-11-11).
