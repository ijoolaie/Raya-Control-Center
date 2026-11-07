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

Evidence (pre-remediation):
- src/control-center.js previously copied progress message, failure reason, and full completion result into appendEvent.
- listEvents returned parsed event data to Operator callers.
- docs/SECURITY.md prohibited secrets and sensitive content in audit events.

Impact:
Before remediation, a Participant could cause arbitrary free-form content to be retained in the immutable event journal, creating an unnecessary second copy of potentially sensitive Task data.

Remediation:
- Schema migration 5 adds tasks.result_json. Successful completion results remain available as task.result without being copied into audit events.
- Progress events now store only the percentage; progress message/details remain on the Task record.
- Failure events store no free-form reason. The input remains accepted for API compatibility but is not persisted.
- Security and integration contracts now warn that Task payloads, progress fields, and results are persisted and must not contain secrets.

Verification:
- Unit tests prove completion results remain on the Task and are absent from audit events.
- Unit tests prove failure reasons and progress message/details are absent from audit events.
- HTTP contract tests verify result availability to the completing client while audit history contains only a result-present flag.
- Backup validation and restore tests cover schema version 5.

Residual risk:
Task payloads, progress data, and successful results remain persisted in the Tasks table and are available to authorized clients. This remediation removes duplicate retention in the immutable event journal for new events; it does not detect secrets or encrypt application data at rest. Existing event rows are not rewritten or deleted because the journal is append-only. Any sensitive values already recorded before this fix remain in the live database and in backups made before cleanup.
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
