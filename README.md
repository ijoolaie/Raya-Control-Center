# Raya Control Center

Raya Control Center is an independent, local-first application for coordinating registered participants and durable tasks across tools and worker processes.

**Product:** Raya Control Center  
**Core subsystem:** Raya Control Plane  
**Status:** Phase 4 verified. Phase 0 remains in progress while the foundation PR is intentionally Open, Draft, and Unmerged.

## Ownership and scope

This repository is the sole implementation home for Raya Control Center. It owns authoritative participant, task, lease, authorization, and audit records.

- **Raya-Agent:** future worker/participant client; not developed here.
- **Raya-MCP:** future MCP adapter/client; not developed here.
- Integration requirements may be documented here; external repositories are out of scope.

## Implemented

- SQLite persistence with versioned migrations and WAL mode.
- Participant registration, scoped credentials, authentication, and revocation.
- Durable tasks, atomic claims, time-bounded leases, and lease-bound lifecycle changes.
- Cooperative cancellation and safe blocking after lease expiry or participant revocation.
- Database-enforced append-only event history.
- Loopback-only HTTP API at `/control/v1`.
- Separate operator and participant bearer credentials; lease tokens are supplied separately in `X-Lease-Token`.
- One-time operator-token bootstrap and explicit token rotation command.
- Request-size limits, JSON validation, Host-header allowlist, and safe API errors.
- Local Operator dashboard for task, participant, and audit-event inspection, including confirmed manual recovery for eligible blocked Tasks.

## Runtime requirements

- Recommended runtime: Node.js 26 Active LTS.
- Minimum supported runtime: Node.js 24.15.0.
- npm 10+.
- The built-in `node:sqlite` API is Release Candidate in Node 24.15+; see the runtime decision in `docs/ROADMAP.md`.

## Quick start

1. Run `npm test` and `npm run check`.
2. Start with `npm start`.
3. On first start, save the operator token printed once.
4. On later starts, set `RAYA_CC_OPERATOR_TOKEN` to that same token.

The API listens only on `127.0.0.1`, port `4317` by default.

To rotate the Operator token while the server is running, use `npm run cli -- operator rotate`. Save the replacement token and update `RAYA_CC_OPERATOR_TOKEN` in the environment used by the server and Operator CLI sessions. If the current token is unavailable or a rotation response was lost, stop the server and use `npm run operator:recover` for offline recovery; see `docs/OPERATIONS.md`.

Optional environment variables:
- `RAYA_CC_PORT` — HTTP port (default `4317`).
- `RAYA_CC_DATABASE` — database path (default `.data/control-center.sqlite`).
- `RAYA_CC_OPERATOR_TOKEN` — Operator token (32–1024 URL-safe ASCII characters: letters, digits, `_`, or `-`).

## API

Base URL: `http://127.0.0.1:4317/control/v1`

- `GET /health`
- `POST /participants/register` — operator credential
- `GET /participants/{id}` — operator credential
- `POST /participants/{id}/revoke` — operator credential
- `POST /tasks` and `GET /tasks/{id}` — operator credential
- `POST /tasks/claim` — participant credential with `tasks:claim` scope
- `POST /tasks/{id}/start|heartbeat|complete|fail|cancel-ack` — participant bearer plus `X-Lease-Token`
- `POST /tasks/{id}/cancel-request`, `POST /tasks/{id}/requeue`, and `GET /events` — operator credential

CLI examples (with the server running and RAYA_CC_OPERATOR_TOKEN set):

- `npm run cli -- health`
- `npm run cli -- participant register --name local-worker --scope tasks:claim`
- `npm run cli -- task create --type demo.example`
- `npm run cli -- task get TASK_ID`
- `npm run cli -- task requeue TASK_ID --reason "verified external state" --confirm-worker-stopped --confirm-side-effects-reviewed`
- `npm run cli -- events --limit 25`
- `npm run cli -- reconcile`

The CLI prints a newly created participant token once; save it securely.

See `docs/API-CONTRACT.md` for request and response behavior.

## Security

The server binds only to IPv4 loopback and rejects non-loopback Host headers. It does not enable CORS or remote ingress. Operator and participant credentials are separate; lease tokens are distinct from participant credentials. Only token hashes are stored. The API does not log request bodies or authorization headers.

Do not place prompts, transcripts, hidden reasoning, credentials, raw tool arguments, or file contents in task payloads or event data. Store only bounded operational metadata.

The default database is `.data/control-center.sqlite`; protect and back it up as private application data.

## Listing records

Use `npm run cli -- participant list --status active` to list participants, and `npm run cli -- task list --status queued --limit 25` to list tasks. Both commands accept filters and bounded offset pagination; see `docs/API-CONTRACT.md`.

## Database maintenance

- `npm run db:backup` creates a consistent SQLite snapshot in `.backups` (or pass an explicit destination).
- `npm run db:restore -- <backup-file>` validates and restores a snapshot. Stop the server first; restore refuses existing WAL sidecars and retains the replaced database for rollback.
- `RAYA_CC_DATABASE` selects the live database path for both commands.

See `docs/OPERATIONS.md` for the safe restore procedure.

## Reference Worker

A runnable Participant worker example is available in [examples/reference-worker](./examples/reference-worker/README.md). It demonstrates claim/start/heartbeat/progress/cancellation/completion using only a Participant token and lease tokens. Its allowlist contains only `demo.echo` and `demo.delay`; arbitrary shell or code execution is not supported.

## Dashboard

Start the server with `npm start`, then open [http://127.0.0.1:4317/](http://127.0.0.1:4317/). Enter the saved Operator token to inspect tasks, participants, routing capabilities, and recent audit events. The dashboard also supports explicitly confirmed Participant capability updates and controlled requeue of eligible blocked Tasks; these actions are revalidated by the API and recorded in the append-only audit history. It does not create Tasks, cancel Tasks, or revoke Participants. The token is held only in page memory and is not written to local or session storage. See `docs/OPERATIONS.md` for details. Internal bundle policy is documented in `docs/PACKAGING.md`.

## Development

See [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md) for the supported local environment, validation commands, and contribution constraints.
