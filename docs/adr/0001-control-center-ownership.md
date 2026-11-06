# ADR-0001: Raya Control Center ownership

- **Status:** Accepted
- **Date:** 2026-11-06

## Context
The coordination system needs one authoritative owner for participant registration, durable tasks, leases, authorization, and event history. The implementation must remain independently deployable and must not be coupled to the lifecycle of any one worker or transport adapter.

## Decision
1. The independent Raya-Control-Center repository owns the Control Center product and its Control Plane subsystem.
2. The Control Center is the authoritative source of truth for its coordination records.
3. Raya-Agent is a future worker/participant client.
4. Raya-MCP is a future MCP adapter/client.
5. External repositories are not implementation targets under this project scope. Their integration needs may be documented here as contracts or issues only.
6. Local-first SQLite is the MVP persistence direction; final runtime/driver choice must be verified by Phase 1 compatibility tests.

## Consequences
- The Control Center can evolve without embedding its state in Agent or MCP.
- Adapters remain replaceable and should be stateless with respect to authoritative task/lease data.
- The API contract must be versioned and tested with simulated clients.
- There is no assumption that ChatGPT sessions expose private conversation state or support force cancellation.
- Any future remote/multi-machine mode requires a separate decision and security review.
