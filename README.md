# Raya Control Center

Raya Control Center is an independent, local-first application for coordinating registered participants and durable tasks across tools and worker processes.

**Product:** Raya Control Center  
**Core subsystem:** Raya Control Plane  
**Status:** Phase 0 — repository and product foundation.

## Ownership and scope

This repository is the sole implementation home for Raya Control Center. It owns the authoritative records for participants, tasks, leases, authorization decisions, and audit events.

External systems are future clients, not owners of control-plane state:
- **Raya-Agent:** future worker/participant integration. Not developed in this repository.
- **Raya-MCP:** future MCP adapter/integration. Not developed in this repository.
- Other applications may integrate through documented APIs when explicitly supported.

Integration requirements may be documented here. Changes to those external projects are out of scope.

## Principles

- Local-first; useful on one machine before distributed deployment.
- Durable state; process memory is never authoritative.
- Explicit ownership through atomic claims and time-bounded leases.
- Observable lifecycle transitions and append-only, redacted audit events.
- Least privilege, scoped credentials, and revocation.
- Cooperative cancellation; never claim to forcibly stop an external process.
- Never store full prompts, transcripts, hidden reasoning, secrets, raw tool arguments, or file contents.

## MVP

1. SQLite persistence and schema migrations.
2. Participant registration, authentication, heartbeat, and revocation.
3. Task lifecycle, atomic claim, lease renewal, and expiry handling.
4. Append-only event history with redaction.
5. Loopback-only API and minimal CLI.
6. Restart, concurrency, authorization, and failure-mode tests.

A graphical dashboard and multi-machine deployment are later phases.

## Documentation

- Architecture: docs/ARCHITECTURE.md
- Roadmap: docs/ROADMAP.md
- Data model: docs/DATA-MODEL.md
- Security: docs/SECURITY.md
- API contract: docs/API-CONTRACT.md
- Ownership decision: docs/adr/0001-control-center-ownership.md

## Development status

No runtime implementation is claimed yet. Phase 0 establishes product boundaries and contracts. Local implementation and test execution require the dedicated Raya-Control-Center workspace to be available to the development environment.
