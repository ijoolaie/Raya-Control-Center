# Data Model (initial contract)

This document defines logical entities. Exact SQL types, indexes, and migration details are Phase 1 implementation work and must be validated against the selected SQLite runtime.

## Participant
Represents a client or worker allowed to interact with the Control Center.

Fields: opaque UUID id; operator-facing display_name; kind (worker, adapter, operator_client); status (active, disabled, revoked); explicit scopes; one-way credential_verifier; created_at, updated_at, last_seen_at; small validated non-secret metadata.

## Task
Represents durable work and its lifecycle.

Fields: opaque UUID id; namespaced type; status; minimum-necessary validated payload or payload reference; created_by; nullable assigned_participant_id; nullable lease_id; priority; created_at, updated_at, started_at, finished_at; optional idempotency_key; explicit conservative retry policy.

### Task states
Primary path: queued → claimed → running → succeeded / failed / cancelled.

Additional states: waiting_approval, blocked, cancellation_requested, expired (only when expiry is semantically confirmed; lease expiry alone may require reconciliation).

Transitions must be explicit and validated. A generic update endpoint must not allow arbitrary state assignment.

## Lease
Fields: opaque UUID id; task_id; participant_id; token_verifier; issued_at; expires_at; renewed_at; released_at; status (active, released, expired, revoked).

Constraints: at most one active lease per task; lease creation and task claim are atomic; every worker mutation verifies participant, task, and lease identity; a stale lease cannot renew or update the task.

## Event
Append-only record of a meaningful transition or security-relevant action.

Fields: monotonic local sequence or UUID; occurred_at; nullable actor_participant_id; entity_type; entity_id; event_type; redacted structured data; correlation_id.

Events are not edited in place. Corrections are represented by additional events.

## Authorization
Authorization is evaluated from participant status, credential validity, scopes, resource ownership, and operation-specific policy. The decision and a redacted reason may be journaled. Secrets and raw credentials must never be included in events.

## Storage constraints
- SQLite foreign keys enabled.
- WAL mode considered for local concurrency, with documented backup behavior.
- UTC timestamps in a consistent representation.
- Explicit indexes for task status/priority/creation, lease expiry, participant status, and event lookup.
- Database migrations are ordered, versioned, and tested both forward and from a clean database.
