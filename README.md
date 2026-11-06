# Raya Control Center

Raya Control Center is an independent, local-first application for coordinating registered participants and durable tasks across tools and worker processes.

**Product:** Raya Control Center  
**Core subsystem:** Raya Control Plane  
**Status:** Phase 1 Ã¢â‚¬â€ durable core foundation.

## Ownership and scope

This repository is the sole implementation home for Raya Control Center. It owns authoritative participant, task, lease, authorization, and audit records.

- **Raya-Agent:** future worker/participant client; not developed here.
- **Raya-MCP:** future MCP adapter/client; not developed here.
- Integration requirements may be documented here; external repositories are out of scope.

## Current implementation

- SQLite persistence using Node.js built-in `node:sqlite` (Node.js 22.13+).
- Versioned schema migration and WAL mode for file-backed databases.
- Participant registration, scoped credentials, authentication, and revocation.
- Task creation, explicit lifecycle transitions, authenticated atomic claims, and time-bounded leases.
- Cooperative cancellation, expired-lease reconciliation to blocked state, and database-enforced append-only event history.
- Lease-bound worker updates; stale or foreign lease tokens are rejected.

## Requirements

- Node.js 22.13.0 or newer (tested initially with 22.23.2).
- npm 10+.

## Quick start

```powershell
npm test
npm run check
```

The database defaults to `.data/control-center.sqlite`; keep this directory private and backed up. The API and CLI are not implemented yet.

## Security notes

Participant and lease tokens are generated with 256 bits of randomness. Only SHA-256 token hashes are stored. Tokens are returned once at creation and must be handled as secrets. This initial core is a library, not yet an exposed network service; loopback-only API enforcement is required before API release.

Do not store prompts, transcripts, hidden reasoning, credentials, raw tool arguments, or file contents in task payloads or events.
