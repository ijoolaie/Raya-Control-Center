# Internal Security Review Preparation

Status: in progress  
Review type: internal code and test inspection; **not an independent security review**  
Review date: 2026-11-07  
Reviewed commit: 8ab14a5579890b2a72a26812baf3746b2e1c0de6

## Scope

This review is limited to the Raya Control Center repository and its current local-only deployment:
- HTTP server, route and Host validation, request parsing and resource limits
- operator, participant, and lease credential boundaries
- task lifecycle, lease ownership, revocation, cancellation, and recovery
- SQLite transactions, migrations, and append-only audit events
- backup and restore paths
- dashboard authentication, browser storage, and response security headers
- packaging and runtime assumptions

No remote ingress, tunnel, reverse proxy, or port-forwarding behavior is in scope for enablement. The service must remain bound to loopback.

## Review rules

- Findings must cite concrete code paths and observable behavior.
- Severity describes the impact under the documented single-machine threat model.
- A control is not considered independently verified merely because its implementation or an internal test exists.
- Do not claim a security certification or independent-review completion.
- Track remediation with a regression test and CI evidence.

## Confirmed observations

### SEC-001 — Untrusted worker-supplied content is copied into audit event data

Severity: **Medium**  
Status: **Open — remediation design required**

Evidence:
- `src/control-center.js`: `updateTaskProgress` appends the worker-provided `message` to `task.progress_updated` event data.
- `src/control-center.js`: `failTask` passes the worker-provided `reason` into `task.failed` event data.
- `src/control-center.js`: `completeTask` passes the entire worker-provided `result` object into `task.succeeded` event data.
- `src/control-center.js`: `listEvents` returns parsed `data_json` to Operator callers.
- `docs/SECURITY.md` states that secrets, raw tool arguments, and sensitive content must not be written to logs/events.

Impact:
A Participant can submit arbitrary progress messages, failure reasons, and completion results. Those values are persisted in the append-only audit table and returned by the Operator events API. If a consumer accidentally includes credentials, private content, or raw tool output in those fields, the audit trail retains a second copy of that data. This conflicts with the documented redaction policy. Operator authentication limits who can read the events, but does not prevent the data from being persisted or later exported with audit records.

Required decision:
Define the intended task-result contract before changing persistence:
1. Keep audit events metadata-only (for example, percent and bounded event codes; no free-form message, reason, or result).
2. If task results are a required product feature, store them separately under an explicit retention and access policy, rather than embedding them in append-only audit event data.
3. Document that callers must not send secrets in operational text fields; validation alone cannot reliably identify secrets.

Acceptance tests:
- Completion result values do not appear in audit event data.
- Failure reason and progress message do not appear in audit event data.
- Event listing continues to expose event metadata and sequence ordering.
- If a separate result store is introduced, tests verify its access control, size limits, and redaction/retention contract.

No code change is made for SEC-001 in this preparation commit because the product contract for task result retention must be settled first.

## Reviewed controls (implementation inspection only)

| Area | Observation | Review state |
|---|---|---|
| Network binding | Server binds to `127.0.0.1` | Inspected; runtime verification still required |
| Host validation | HTTP handler accepts loopback Host names and rejects others | Inspected; parser edge cases need independent testing |
| HTTP limits | Header, request, body, keep-alive, and per-socket limits are configured | Inspected; existing integration coverage present |
| Credential separation | Operator and Participant credentials use distinct routes and checks; lease token is separately required for worker mutations | Inspected; independent adversarial testing pending |
| Token storage | Operator and Participant token hashes are stored; lease hashes are stored | Inspected; filesystem/database protection is an operational responsibility |
| Audit immutability | SQLite triggers reject event UPDATE and DELETE | Inspected; privileged filesystem/database access can bypass application-level guarantees |
| Dashboard | Operator token is held in page memory; static assets use restrictive headers; UI is read-only | Inspected; browser/runtime testing pending |
| Backup/restore | Dedicated backup and offline restore implementation exists | Not yet fully reviewed |
| Startup recovery | Expired active leases are reconciled before listening and periodically | Inspected; crash/restart fault injection pending |

## Open review work

- [ ] Decide and remediate SEC-001.
- [ ] Review database backup/restore for path traversal, overwrite, symlink, and rollback hazards.
- [ ] Review startup/shutdown and WAL recovery under forced process termination.
- [ ] Review URL/Host parsing edge cases and HTTP parser behavior with adversarial raw requests.
- [ ] Review token rotation, backup exposure, local filesystem permissions, and database file permissions.
- [ ] Add or identify independent tests for credential leakage through errors, events, CLI output, and dashboard rendering.
- [ ] Obtain an independent security review from a reviewer who did not implement the controls.

## Gate

Phase 4 security work remains **in progress**. This document is preparation for an independent review, not evidence that such a review has passed. Keep the API loopback-only until the independent review gate is completed.
