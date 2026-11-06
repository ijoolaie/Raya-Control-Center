# Roadmap

Status labels: **Not started**, **In progress**, **Verified**, **Blocked**, **Deferred**. A phase is not complete until its acceptance criteria are met by repeatable tests or documented operational evidence.

## Phase 0 — Product foundation
**Status: In progress (documentation bootstrap)**
- [x] Establish independent repository and ownership boundary.
- [x] Define product principles and initial architecture.
- [x] Define data, security, and API contracts.
- [ ] Add tooling and development instructions.
- [ ] Enable CI for lint, type-check, and tests.

Exit criteria: documents agree on ownership, lifecycle, security, and MVP scope.

## Phase 1 — Durable core
**Status: Not started**
- [ ] Select and verify supported Node.js runtime and SQLite driver.
- [ ] Implement migrations and SQLite repository layer.
- [ ] Implement participant registry and scoped credential verification.
- [ ] Implement task registry and state machine.
- [ ] Implement atomic claim and lease renewal/expiry.
- [ ] Implement append-only event journal.
- [ ] Add unit, integration, restart, concurrency, and authorization tests.

Exit criteria: state survives process restart; two concurrent claimers cannot own the same task; stale lease holders cannot mutate tasks; event and state changes commit atomically; expired non-idempotent work is not blindly retried.

## Phase 2 — Local operator interface
**Status: Not started**
- [ ] Loopback-only HTTP API.
- [ ] Local operator authentication and safe bootstrap.
- [ ] CLI for participants, tasks, events, and health.
- [ ] Structured logs with secret redaction.
- [ ] Backup and restore procedure.

Exit criteria: an operator can inspect and manage local work without editing the database manually.

## Phase 3 — Integration adapters
**Status: Deferred until core API is stable**
- [ ] Publish versioned integration contract.
- [ ] Define participant adapter requirements for Raya-Agent.
- [ ] Define MCP adapter requirements for Raya-MCP.
- [ ] Add contract tests using simulated clients.
- [ ] Document capability limitations and cooperative cancellation.

This phase does not authorize development in the Raya-Agent or Raya-MCP repositories.

## Phase 4 — Dashboard and operational hardening
**Status: Deferred**
- [ ] Read-oriented dashboard.
- [ ] Guarded task/participant controls.
- [ ] Audit/event explorer.
- [ ] Upgrade, backup, restore, and recovery tests.
- [ ] Security review and packaging.

## Phase 5 — Optional remote/multi-machine operation
**Status: Deferred / not part of MVP**
Proceed only after explicit product decision and threat-model review. Requires authenticated remote ingress, transport security, credential rotation, replay protection, and a defined consistency/availability model.

## Progress reporting rule
Every update must distinguish:
- **Documented:** specified but not implemented.
- **Implemented:** code exists.
- **Tested:** automated tests passed.
- **Operational:** exercised in the intended environment.

Never report a task as complete based only on a file being created.
