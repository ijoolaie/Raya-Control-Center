# Architecture

## Purpose
Raya Control Center is the authoritative coordination service for registered participants and durable work. Its core subsystem is the Raya Control Plane. The product name and architectural subsystem name are intentionally distinct.

## System boundary
This repository owns participant identity records, status, scopes, credential verifiers, task records, lifecycle transitions, assignment, lease ownership, authorization policy, append-only operational events, local API, CLI, migrations, and an Operator-authenticated operational dashboard with inspection, audited capability updates, and guarded Task requeue actions.

External clients do not own authoritative state:
- Raya-Agent may later register as a participant and claim/execute tasks.
- Raya-MCP may later expose an MCP-facing adapter that calls the Control Center API.
- These integrations are contracts only until separately authorized; their repositories are not implementation targets.

## Logical components
| Component | Responsibility |
|---|---|
| API boundary | Validate requests, authenticate callers, enforce loopback binding |
| Identity and authorization | Participant registry, token verification, scopes, revocation |
| Task service | Task creation, transition validation, claim and cancellation requests |
| Lease manager | Atomic ownership, heartbeat/renewal, expiry and reconciliation |
| Event journal | Append-only state-change and security events |
| Persistence | SQLite schema, transactions, migrations |
| CLI | Local operator workflows |
| Dashboard | Operator-authenticated task, participant, routing, and audit-event inspection; audited capability updates and guarded Task requeue actions |

Business rules belong in services, not HTTP handlers or CLI commands.

## Initial deployment
Single-machine, local-first deployment: one Control Center process; SQLite using WAL mode where supported; API bound to loopback only; local operator access separated from participant credentials; no inbound network exposure by default.

The initial implementation must not assume a cloud database, message broker, Kubernetes, or multi-node consensus.

## Task ownership and execution
A Participant claims the highest-priority oldest queued Task for which its stored capability set contains every requiredCapabilities entry. The claim operation atomically verifies Participant status and the tasks:claim scope, applies exact capability matching, assigns a unique Lease token and expiry, transitions the Task to claimed, and appends the corresponding event. Empty Task requirements preserve legacy unrestricted routing. Participant kind remains descriptive metadata. Task-type and payload safety is still validated by the consuming Worker.

The capability-aware routing model is approved and implemented; see TASK-ROUTING-DESIGN.md and API-CONTRACT.md. The bounded owner-led AI-assisted security review is complete and recorded in SECURITY-REVIEW.md; third-party review is optional and is not a project gate.

The worker then reports running, bounded progress metadata, heartbeat, and terminal outcome. A heartbeat proves liveness only; it is not evidence of progress.

Lease expiry is not proof that work did not happen. For potentially non-idempotent tasks, expiry moves work to reconciliation/blocked handling rather than blindly retrying.

## Cancellation semantics
Cancellation is cooperative: an operator/client requests cancellation; the task enters cancellation_requested; the current lease owner acknowledges cancellation and stops when able; only a valid owner acknowledgement (or explicit operator reconciliation with audit) permits cancelled.

The Control Center cannot inspect arbitrary ChatGPT sessions, hidden reasoning, or forcibly terminate generation outside an integration that explicitly exposes such capabilities.

## Reliability
- All state-changing operations use transactions.
- State transitions are validated against a finite-state machine.
- Lease ownership is checked on every worker update.
- Idempotency keys are required for retryable commands where duplicate submission is possible.
- Startup performs migration and integrity checks; it does not silently replay uncertain external work.
- Events are committed in the same transaction as the state change they describe.

## Deferred
Not MVP: multi-machine coordination, remote ingress, plugin marketplace, autonomous scheduling, dashboard analytics, and automatic retries for arbitrary external work.

The Operator-only GET /control/v1/routing/summary endpoint reports exact queued and unmatched-queued counts using the same capability inclusion rule as Claim; it is not limited to the Dashboard latest-100 task/participant tables.
