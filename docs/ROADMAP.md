# Raya Control Center Roadmap

Status labels: **Not started**, **In progress**, **Verified**, **Blocked**, **Deferred**.
A phase is complete only when repeatable tests or operational evidence satisfy its exit criteria.

## Phase 0 — Product foundation
**Status: In progress**
- [x] Independent repository and ownership boundary.
- [x] Architecture, data model, security principles, API contract, and ADR documented.
- [x] GitHub Actions CI workflow added.
- [ ] Development instructions and operator runbook.
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
- [x] One-time operator-token bootstrap and explicit token rotation command.
- [x] Participant registration, read, list, and revocation endpoints.
- [x] Task create/read/list/cancel and worker claim/lifecycle endpoints.
- [x] Separate participant bearer and lease-token authentication.
- [x] Strict 16 KiB request-size and JSON validation.
- [x] HTTP header limit (8 KiB), bounded header/request receipt timeouts, bounded keep-alive, and per-socket request count.
- [x] Raw TCP coverage for oversized headers, malformed framing/UTF-8, incomplete request-body disconnects, and response disconnects.
- [x] Safe 413 connection closure and destroyed-response handling.
- [x] Graceful SIGINT/SIGTERM shutdown: close idle connections, drain active requests for up to 10 seconds, then force-close before closing SQLite.
- [x] Startup and periodic expired-lease reconciliation; operator-triggered reconciliation endpoint.
- [x] CLI for participant registration/read/revocation, task create/read/cancel, events, health, and lease reconciliation.
- [x] Consistent SQLite backup and validated offline restore with rollback file.
- [x] Lease-bound task progress reporting, separate from heartbeat, with append-only audit events.
- [ ] Structured operational logs (deferred until an allowlisted, redacted event schema is justified).

## Phase 3 — Integration contracts
**Status: In progress**
- [x] Publish versioned integration contract for Participant, Task, Lease, progress, heartbeat, cancellation, and recovery semantics.
- [x] Add simulated independent HTTP client contract tests for success, cancellation, and participant revocation.
- [ ] Define future Raya-Agent participant requirements.
- [ ] Define future Raya-MCP adapter requirements.
- [ ] Add a separately packaged runnable example client only if the test contract exposes a concrete integration need.

This phase does not authorize development in either external repository. Raya-Agent and Raya-MCP remain future consumers/adapters only.

## Phase 4 — Dashboard and operational hardening
**Status: Deferred**
- [ ] Read-oriented dashboard and guarded controls.
- [ ] Audit/event explorer.
- [x] Backup, restore, and recovery tests for WAL snapshots and corrupt/unsafe restore inputs.
- [ ] Upgrade and packaging review.
- [ ] Independent security review before any remote exposure.

## Phase 5 — Optional remote/multi-machine operation
**Status: Deferred**
Requires an explicit product decision, threat-model review, authenticated transport, credential rotation, replay protection, and a defined consistency model. The current API must remain loopback-only.

## Progress reporting rule
Distinguish **Documented**, **Implemented**, **Tested**, and **Operational**.
Never report completion based only on file creation.
