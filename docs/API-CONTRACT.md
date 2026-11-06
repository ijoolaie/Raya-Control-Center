# API Contract (proposed v1)

The API is a versioned boundary between the Control Center and future clients. This is a contract proposal, not an implemented API.

Base path: /control/v1  
Default bind: loopback only.

## Authentication
Participant endpoints require a participant credential. Credentials are scoped and revocable. Operator endpoints use a separate local operator mechanism. Tokens are sent in the Authorization header and must never appear in URLs or logs.

## Endpoints
| Method | Path | Purpose |
|---|---|---|
| POST | /participants/register | Register a participant (operator/bootstrap policy applies) |
| POST | /participants/heartbeat | Update participant liveness |
| GET | /participants | List participants (operator scope) |
| GET | /participants/{id} | Read participant metadata |
| POST | /participants/{id}/revoke | Revoke a participant (operator scope) |
| POST | /tasks | Create a task |
| GET | /tasks | List/filter tasks |
| GET | /tasks/{id} | Read task status and safe metadata |
| POST | /tasks/{id}/claim | Atomically claim eligible task |
| POST | /tasks/{id}/start | Report start under active lease |
| POST | /tasks/{id}/heartbeat | Renew lease / report liveness |
| POST | /tasks/{id}/progress | Report bounded progress metadata |
| POST | /tasks/{id}/complete | Report success under active lease |
| POST | /tasks/{id}/fail | Report failure under active lease |
| POST | /tasks/{id}/cancel-request | Request cooperative cancellation |
| POST | /tasks/{id}/cancel-ack | Acknowledge cancellation by current owner |
| GET | /events | Query authorized, redacted event history |
| GET | /health | Local process and storage health |

Exact request/response schemas are to be defined alongside implementation and OpenAPI generation.

## Common rules
- JSON request/response bodies.
- UTC timestamps.
- Stable machine-readable error codes.
- Bounded pagination; deterministic ordering.
- Idempotency keys for commands that clients may safely retry.
- State changes and corresponding events commit atomically.
- Task updates require a valid active lease unless explicitly an operator action.
- Heartbeat is not progress.
- Cancellation request is not cancellation acknowledgement.

## Error categories
authentication_required, invalid_credential, participant_revoked, insufficient_scope, not_found, invalid_transition, lease_required, lease_expired, lease_mismatch, conflict, validation_error, rate_limited, internal_error.

Do not expose internal stack traces or database details.
