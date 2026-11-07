# Integration Contract v1

Status: implemented and exercised by independent HTTP client tests. Consumer-specific future requirements are defined in [CONSUMER-REQUIREMENTS.md](./CONSUMER-REQUIREMENTS.md).
Base path: `/control/v1`.
Transport: HTTP on loopback only in the current MVP. This is not a remote-access contract.

## Identity and credentials

- An operator provisions each Participant using `POST /participants/register`.
- A successful registration returns Participant metadata and a high-entropy Participant bearer token exactly once.
- Store that token in the consuming application's secret store. It cannot be retrieved later.
- A Participant token identifies the caller; it does not grant operator privileges.
- The `tasks:claim` scope is required to claim work.
- A successful claim returns a separate lease token. Treat it as a short-lived secret and keep it only for the lifetime of that lease.
- Never put either token in a URL, task payload, result, progress details, event data, or logs.
- Revocation is terminal for that Participant credential. Register a replacement Participant rather than attempting to reactivate the old token.

## Current scope semantics

Participant `kind` is descriptive metadata and does not grant privileges. The current API enforces only the `tasks:claim` Participant scope, on the claim route. Start, heartbeat, progress, complete, fail, cancellation acknowledgement, and lease-status reads require a valid Participant token plus the matching active Lease token; they do not currently have distinct per-action scopes. Operator routes always require the Operator credential. Consumers must not assume that arbitrary stored scope names are enforced. See [CONSUMER-REQUIREMENTS.md](./CONSUMER-REQUIREMENTS.md) for the normative consumer boundary and future requirements.

## Task lifecycle

```text
Operator creates Task
        |
        v
     queued
        |
Participant claims (scope + Participant token)
        |
        v
     claimed ---- lease expires/revoked ----> blocked
        |
Participant starts (Participant token + lease token)
        |
        v
     running ---- operator requests cancellation ----> cancellation_requested
        |                                                     |
        | complete/fail                                      | Participant acknowledges
        v                                                     v
 succeeded / failed                                        cancelled
```

A task claim is atomic. The claim response contains the Task and the lease ID, token, and expiry. The lease token is required for every worker lifecycle mutation. A Participant can only mutate the Task associated with its own active, unexpired lease.

Concurrent claim requests are serialized by the SQLite transaction boundary: one eligible Task can be granted to at most one Participant. Competing callers receive either their own claim or `{ "claim": null }`; they must not infer ownership from a timeout or from a locally cached queue view. The lease and `task.claimed` audit event are committed together.

Task creation accepts an optional globally unique `idempotencyKey`. Retrying the same create request with the same key, type, payload, and priority returns the original Task (HTTP 200, `idempotentReplay: true`) without creating another Task or audit event. Reusing that key with different task input returns `409 conflict`. Keep the key stable across retries; do not generate a new key after a timeout. Concurrent identical requests using the same key also create exactly one Task and one `task.queued` event; one response is the initial `201`, and the replay response is `200`.

## Client sequence

1. Receive and securely store a Participant token during provisioning.
2. Call `POST /tasks/claim` with the Participant bearer token. A successful empty queue is represented by `{ "claim": null }`.
3. Persist the returned lease token only in memory or protected short-lived storage.
4. Call `POST /tasks/{id}/start` with both credentials.
5. Optionally call `POST /tasks/{id}/progress`; progress is informational and does not renew the lease.
6. Call `POST /tasks/{id}/heartbeat` before expiry when work is still active.
7. Finish with `POST /tasks/{id}/complete` or `POST /tasks/{id}/fail`.
8. Discard the lease token after a terminal response. A released/expired/revoked lease cannot be reused.

For cooperative cancellation, the operator calls `POST /tasks/{id}/cancel-request`. The Participant polls `GET /tasks/{id}/lease-status` with its Participant bearer and active `X-Lease-Token`. The response exposes only task ID, lifecycle status, cancellation flag, update time, and lease expiry (not the task payload). After observing `cancellationRequested=true`, the Participant stops its external work safely, then calls `POST /tasks/{id}/cancel-ack` with the still-active lease. The acknowledgement is not proof that arbitrary external side effects were rolled back.

## Response and error contract

- Success responses are JSON. The current API returns HTTP 200 for successful reads/mutations, 201 for Participant registration and Task creation.
- `401 authentication_required`: missing, malformed, or invalid bearer credential.
- `403 insufficient_scope`: Participant is authenticated but lacks the required scope.
- `404 not_found`: requested resource or route does not exist.
- `409 lease_mismatch`: lease is absent, foreign, expired, revoked, or no longer active; `409 invalid_transition` indicates a disallowed lifecycle transition.
- `400 validation_error`: invalid body, filter, or field.
- `413 payload_too_large`: request body exceeds 16 KiB.
- `421 misdirected_request`: Host header is not an accepted loopback host.
- `500 internal_error`: unexpected server error; response does not disclose internal details.

Clients should branch on HTTP status and stable `error.code`, not human-readable error messages. Task creation can be retried safely only when the original idempotency key and identical request fields are reused. Do not blindly retry claim, start, heartbeat, progress, complete, fail, or cancellation mutations after an ambiguous network failure; reconcile the authoritative Task/Lease state first.

## Lease loss and recovery

- A heartbeat extends the lease; a progress report does not.
- A Participant must stop mutating a Task after any lease-mismatch response.
- Expired leases are reconciled to `blocked`; the system does not automatically retry uncertain work.
- Revoking a Participant revokes its active leases and blocks affected active Tasks.
- An operator must inspect the Task and external side effects before deciding whether to create replacement work.
- A Participant must not assume that a timeout means its last request failed; read Task state through the operator interface or wait for the orchestrator to reconcile.

## Future consumer boundaries

- A future Raya-Agent worker may be provisioned as a Participant with the minimum required scopes.
- A future Raya-MCP adapter may submit explicitly observed operations as Tasks or act as a separately scoped Participant only after its adapter contract is designed.
- Neither future consumer owns Participant registry, Task state, Lease state, or the authoritative event journal.
- This contract does not imply that ChatGPT can inspect other conversations, hidden reasoning, or unsubmitted tool activity.
- This document does not authorize changes to the Raya-Agent or Raya-MCP repositories.

## Verification

The repository test `test/client-contract.test.js` starts a real loopback HTTP server and behaves as an independent client. It verifies registration, task creation, claim, start, progress, heartbeat, completion, stale lease rejection, audit events, lease-bound cancellation-status polling, foreign-lease rejection, and cooperative cancellation/acknowledgement. It also issues concurrent claim requests from two Participants and concurrent identical task-creation requests, asserting exclusive claim ownership and one idempotent creation/audit event. It is an API contract test, not a remote deployment or penetration test.

### Cancellation request retry semantics

The operator cancellation endpoint is idempotent. Repeating `POST /tasks/{id}/cancel-request` while the task is already `cancellation_requested` or `cancelled` returns the current Task without changing timestamps or appending another audit event. Requests against tasks that completed successfully or failed remain invalid transitions. This makes an operator retry safe after an ambiguous HTTP response. Participant cancellation acknowledgement remains lease-bound; after an ambiguous acknowledgement response, read the Task state rather than blindly repeating the acknowledgement.

### Participant revocation retry semantics

The operator endpoint `POST /participants/{id}/revoke` is idempotent. Repeating the request after the Participant is already revoked returns its current metadata with HTTP 200 and does not append another `participant.revoked` event. Active leases and affected Tasks are changed only by the first successful revocation. An unknown Participant ID still returns `404 not_found`. This permits safe retry after an ambiguous HTTP response.
