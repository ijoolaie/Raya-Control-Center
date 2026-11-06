# API Contract v1

This contract describes the implemented local API. Base path: `/control/v1`.
Default bind: `127.0.0.1` only. Default port: `4317`.

For the complete consumer lifecycle, recovery rules, and independent client verification, see [INTEGRATION-CONTRACT.md](./INTEGRATION-CONTRACT.md).

## Authentication

- Operator endpoints require `Authorization: Bearer <operator-token>`.
- Participant endpoints require `Authorization: Bearer <participant-token>`.
- Worker lifecycle endpoints additionally require `X-Lease-Token: <lease-token>`.
- The participant token and lease token are distinct credentials.
- Tokens must never appear in URLs, request bodies, logs, event data, or error messages.
- Operator token is generated on first start and displayed once. Later starts require `RAYA_CC_OPERATOR_TOKEN`.
- Rotate with `node src/rotate-operator-token.js`; the new token is displayed once.

## Endpoints

| Method | Path | Authentication | Purpose |
|---|---|---|---|
| GET | `/health` | None | Process/API health |
| POST | `/participants/register` | Operator | Register participant; returns token once |
| GET | `/participants` | Operator | List participants with bounded filters and pagination |
| GET | `/participants/{id}` | Operator | Read participant metadata |
| POST | `/participants/{id}/revoke` | Operator | Revoke participant and block its active tasks; safe to repeat |
| POST | `/tasks` | Operator | Create task |
| GET | `/tasks` | Operator | List tasks with bounded filters and pagination |
| GET | `/tasks/{id}` | Operator | Read task |
| POST | `/tasks/claim` | Participant + `tasks:claim` scope | Claim next eligible task |
| POST | `/tasks/{id}/start` | Participant + lease header | Start claimed task |
| POST | `/tasks/{id}/heartbeat` | Participant + lease header | Renew lease |
| POST | `/tasks/{id}/progress` | Participant + lease header | Report task progress |
| POST | `/tasks/{id}/complete` | Participant + lease header | Complete task |
| POST | `/tasks/{id}/fail` | Participant + lease header | Fail task |
| POST | `/tasks/{id}/cancel-ack` | Participant + lease header | Acknowledge cancellation |
| GET | `/tasks/{id}/lease-status` | Participant + lease header | Read own active task status and cancellation signal |
| POST | `/tasks/{id}/cancel-request` | Operator | Request cooperative cancellation |
| GET | `/events` | Operator | Read bounded event history |
| POST | `/maintenance/reconcile-expired-leases` | Operator | Reconcile expired leases |

## Request bodies

All non-empty request bodies must be JSON objects and are limited to 16 KiB.

- Register: `{ "displayName": "worker", "kind": "worker", "scopes": ["tasks:claim"] }`
- Create task: `{ "type": "job.example", "payload": {}, "priority": 0, "idempotencyKey": "optional-key" }`
- Task creation with an idempotency key returns `201` for the first creation and `200` with `idempotentReplay: true` for an identical replay. Reusing the key with a different type, payload, or priority returns `409 conflict`.
- Claim: `{ "leaseDurationMs": 30000 }`
- Heartbeat: `{ "leaseDurationMs": 30000 }`
- Progress: `{ "percent": 50, "message": "Halfway", "details": {} }` (percent may be null; message max 240 chars; details max 2 KiB).
- Complete: `{ "result": { "ok": true } }`
- Fail: `{ "reason": "bounded diagnostic" }`

Worker routes use the authenticated participant identity and `X-Lease-Token`; clients must not send participant IDs in request bodies. A successful empty claim returns `{ "claim": null }`.

## Query parameters

Query parameters are route-specific and strict:

- `GET /participants`: `status`, `kind`, `limit`, `offset`.
- `GET /tasks`: `status`, `type`, `assignedParticipantId`, `limit`, `offset`.
- `GET /events`: `entityType`, `entityId`, `limit`.
- Other implemented routes do not accept query parameters.
- Unknown or repeated parameter names, empty values, and non-decimal `limit`/`offset` values return `400 validation_error`.
- `limit` and `offset` must use non-negative decimal integer notation; endpoint-specific range limits still apply.

## Common rules

- UTC timestamps.
- Stable machine-readable error codes.
- No CORS and no wildcard network binding.
- Host headers are restricted to `127.0.0.1`, `localhost`, and `::1`.
- Task state changes and their audit events commit atomically.
- Heartbeat is not progress. Progress updates are accepted only for running tasks held by the current unexpired lease; they do not renew the lease.
- Cancellation request is not cancellation acknowledgement.
- Repeating participant revocation returns the current revoked Participant without another state change or audit event; an unknown participant ID remains `404 not_found`.
- A Participant may poll `GET /tasks/{id}/lease-status` with its Participant bearer and active lease token; the response contains status and cancellation signal only, never task payload.
- API errors never expose stack traces or database details.
- Request bodies and authorization headers are not logged.
- Clients should use HTTP status and `error.code`, not parse human-readable error messages.

## Error codes

`authentication_required`, `insufficient_scope`, `not_found`, `invalid_transition`, `lease_mismatch`, `conflict`, `validation_error`, `payload_too_large`, `misdirected_request`, `internal_error`.

Do not store prompts, transcripts, hidden reasoning, secrets, raw tool arguments, or file contents in task payloads or event data.
