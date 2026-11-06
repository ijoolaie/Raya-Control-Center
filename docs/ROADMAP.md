# Roadmap

Status labels: **Not started**, **In progress**, **Verified**, **Blocked**, **Deferred**. A phase is complete only after repeatable tests or operational evidence satisfy its acceptance criteria.

## Phase 0 ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â Product foundation
**Status: In progress**
- [x] Independent repository and ownership boundary.
- [x] Architecture, data, security, API contract, and ADR documented.
- [ ] Development instructions and CI.
- [ ] Review and merge the foundation PR.

## Phase 1 ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â Durable core
**Status: In progress**
- [x] Verify Node.js runtime and built-in SQLite availability (Node 22.23.2; SQLite 3.51.3).
- [x] Implement initial versioned SQLite migration and WAL mode.
- [x] Implement participant registration, scoped credentials, authentication, and revocation.
- [x] Implement task creation and initial lifecycle state machine.
- [x] Implement atomic task claim and time-bounded leases.
- [x] Enforce lease ownership and expiry on worker mutations.
- [x] Implement cooperative cancellation and append-only event journal.
- [x] Validate multi-connection claim contention with two independent SQLite connections.
- [ ] Exercise process termination and WAL crash/recovery behavior.
- [ ] Add property/failure-mode and authorization coverage.
- [ ] Decide whether experimental node:sqlite is acceptable for supported production runtime.

Exit criteria: state survives process restart; concurrent claimers cannot own the same task; stale lease holders cannot mutate tasks; event and state changes commit atomically; uncertain non-idempotent work is not blindly retried.

## Phase 2 ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â Local operator interface
**Status: Not started**
- [ ] Loopback-only HTTP API.
- [ ] Local operator authentication and safe bootstrap.
- [ ] CLI for participants, tasks, events, and health.
- [ ] Structured logs with secret redaction.
- [ ] Backup and restore procedure.

## Phase 3 ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â Integration contracts
**Status: Deferred until core API is stable**
- [ ] Publish versioned integration contract and simulated-client contract tests.
- [ ] Define future Raya-Agent participant requirements.
- [ ] Define future Raya-MCP adapter requirements.

This phase does not authorize development in either external repository.

## Phase 4 ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â Dashboard and operational hardening
**Status: Deferred**
- [ ] Read-oriented dashboard and guarded controls.
- [ ] Audit/event explorer.
- [ ] Upgrade, backup, restore, and recovery tests.
- [ ] Security review and packaging.

## Phase 5 ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â Optional remote/multi-machine operation
**Status: Deferred**
Requires an explicit product decision, threat-model review, authenticated transport, credential rotation, replay protection, and a defined consistency model.

## Progress reporting rule
Distinguish **Documented**, **Implemented**, **Tested**, and **Operational**. Never report completion based only on file creation.
