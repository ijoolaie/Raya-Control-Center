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
- [x] Added read-only Restore inspection and a conservative recovery-state model covering journal validity, lock presence (including a residual lock after journal cleanup), and live/temporary/rollback artifact combinations; child-process crash simulations cover journal publication, staging, original move, install, temporary cleanup, and journal cleanup. No state performs automatic file or lock actions.
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

## Phase 4 — Dashboard and operational hardening
**Status: In progress**
- [x] Read-oriented dashboard for task, participant, and health inspection (Operator-authenticated data reads; no mutations exposed).
- [x] Audit/event explorer with entity filters.
- [x] Backup, restore, and recovery tests for WAL snapshots and corrupt/unsafe restore inputs.
- [x] Upgrade and packaging review: private distribution policy, runtime matrix, package allowlist, and bundle contents documented and verified.
- [ ] Independent security review before any remote exposure.

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
- [ ] Complete independent security review by a reviewer who did not implement the controls.
- [ ] Keep the API loopback-only until the independent review gate is complete.
