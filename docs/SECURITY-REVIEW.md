### SEC-012 - Runtime retained and exposed an unnecessary plaintext Operator token Internal Security Review Preparation

Status: in progress  
Review type: internal code and test inspection; **not an independent security review**  
Review date: 2026-11-07  
Reviewed implementation commit: d4eb172ad7ea704b2cae16884b88fcf6b309fb35

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

SEC-001 was remediated in commit `ba933f23d2a21824b50eeb64c863aa070cb32ea3` and the historical-retention clarification was recorded in `a72518058433e2639acec795fe2dcbdb5e4f5d26`. GitHub Actions push and pull-request workflows for the reviewed head both passed on Node 24 / Windows and Node 26 / Windows. This is implementation and CI evidence, not independent verification.


### SEC-001 — Untrusted worker-supplied content is copied into audit event data

Severity: **Medium**
Status: **Remediated for new events; CI verified on 2026-11-07**

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
### SEC-002 — Host and request-target parsing accepted alternate authority forms

Severity: **Medium**
Status: **Remediated; CI verified on 2026-11-07**

Evidence (pre-remediation):
- `src/http-server.js` parsed the raw Host header by prepending `http://` and checking only the resulting URL hostname.
- A Host value such as `attacker.example@localhost` is parsed with hostname `localhost` and username `attacker.example`; the old check therefore accepted a malformed authority containing userinfo.
- The request handler constructed a URL directly from `req.url`; absolute-form and network-path request targets could supply a different authority while routing continued from the parsed pathname.

Impact:
The Host allowlist did not strictly validate HTTP authority syntax, and request-target authority was not constrained to origin-form. This created inconsistent interpretation of the authority used for loopback validation versus request routing.

Remediation:
- Reject authority values containing whitespace, userinfo delimiters, path separators, query/fragment delimiters, or percent escapes before URL parsing.
- Require the parsed authority to have no username/password, path, query, or fragment, then apply the existing exact loopback hostname allowlist.
- Accept origin-form request targets only; reject absolute-form, network-path, backslash, and fragment-bearing targets before URL parsing.

Verification:
- Raw HTTP regression tests verify `attacker.example@localhost`, path-bearing, query-bearing, and fragment-bearing Host values receive HTTP 421.
- Raw HTTP regression tests verify absolute-form, network-path, and backslash-bearing request targets receive HTTP 400.
- The existing non-loopback Host test continues to verify safe error output.
- Targeted HTTP tests: 18/18 passed locally; full suite: 58/58 passed. GitHub Actions run `42351515683` passed on Node 24 / Windows and Node 26 / Windows.

Residual risk:
This closes the observed userinfo and alternate request-target authority gaps. Broader adversarial HTTP parser coverage remains open; this is not an independent review.

### SEC-003 — CLI API override could send the Operator token to a remote host

Severity: **High**
Status: **Remediated; CI verified on 2026-11-07**

Evidence (pre-remediation):
- `src/cli.js` accepted `RAYA_CC_URL` without validating its protocol, hostname, or path.
- Operator commands attached `RAYA_CC_OPERATOR_TOKEN` as a Bearer authorization header to requests sent to that URL.
- The reference worker already enforced an HTTP loopback URL, but the CLI did not.

Impact:
A user or process setting `RAYA_CC_URL` to an attacker-controlled remote URL could cause CLI operator credentials to be transmitted to that host. This contradicted the documented local-only deployment model.

Remediation:
- Validate the CLI base URL at startup; allow HTTP only, exact loopback hostnames only, no userinfo, and exactly the `/control/v1` path with no query or fragment.
- Fail before issuing any API request when the override is invalid.

Verification:
- Integration tests reject HTTPS remote hosts, HTTP remote hosts, URL-userinfo tricks, lookalike hostnames, unexpected paths, and query strings.
- Tests verify the operator token is not echoed in the error output.
- Targeted CLI tests: 7/7 passed locally; full suite: 58/58 passed. GitHub Actions run `42351515683` passed on Node 24 / Windows and Node 26 / Windows.

Residual risk:
Environment variables remain under the control of the local user/process. This validation prevents accidental credential forwarding to non-loopback URLs; it does not protect against a malicious process that can alter the user's environment or executable files.

## Backup and restore hardening in progress

The implementation now uses `lstat` for endpoint checks so the final source/destination path component must be a regular file; directories and final-component symbolic links are rejected. WAL/SHM sidecar presence is checked without following a final-component symlink. Restore validates the staged copy after copying it, rejects symbolic-link/junction components in source and destination paths, and installs the file through a same-directory hard link that cannot overwrite a destination created concurrently. The original database is moved to a unique rollback path first; rollback failures are surfaced with the preserved backup path. Regression tests reject directory inputs and destinations, reject symbolic-link/junction parent components, and verify the live database remains intact. Local validation for the current working tree: `npm test` 61/61 and `npm run check` passed on Node.js 22.23.2. The backup/restore code in commit `b8fb7f1` passed Node 24 and Node 26 Windows CI.

Backup/restore fault injection now covers both installation failure with successful rollback and rollback failure. The first case verifies the original live database is restored with all committed records intact. The second verifies the original database remains preserved at the reported rollback path when the rollback rename itself fails. Windows directory junctions and symbolic-link parent components are also covered by regression tests. Same-directory installation no longer overwrites a destination that appears concurrently. Concurrent ancestor replacement and permission/ACL behavior still require independent review and targeted tests. Lock-specific regression tests now cover simultaneous cross-process acquisition, sidecar symlink rejection, and hard-link rejection on the CI filesystems. Read-only lock inspection also fails closed for symlink/junction database parents and uses the same canonical parent resolution as acquisition. Do not treat these changes as protection against a hostile process running with the same Windows user privileges.

## Operator token rotation and CLI error output

Operator-token rotation is now performed through an authenticated POST to `/control/v1/operator/rotate-token`. The handler validates the current in-memory credential, writes a new SHA-256 token hash to SQLite, updates the in-memory credential before responding, and returns the new random token once. Regression coverage proves unauthenticated rotation is rejected, the prior token fails immediately after rotation, and the replacement token works. The CLI exposes `npm run cli -- operator rotate`. Offline recovery is now supported only while holding an exclusive per-database runtime lock. Server startup acquires the same lock before opening SQLite and releases it after graceful shutdown closes SQLite. The recovery command refuses to run while that lock reservation is active, then rotates the credential hash and returns a one-time replacement token without changing application records. Runtime ownership is represented by a persistent SQLite sidecar held with `BEGIN IMMEDIATE`; forced termination releases the reservation automatically. A legacy JSON lock from older versions is reported as unrecognized and requires operator review before it is archived.

CLI API error messages redact the configured Operator token if a server response echoes it. A local fake-server regression test intentionally echoes the Bearer header in a 500 response and verifies the token does not appear in stdout/stderr. Runtime-lock tests prove recovery is refused while the server is active and succeeds after graceful shutdown, with the recovered token accepted on the next startup. Successful participant-registration responses and the explicit rotation command still display their one-time credentials by design; operators must protect terminal output and avoid transcript/log capture. Concurrent Operator rotations using the same current token are also tested: exactly one request succeeds, the competing request is rejected, and only the winning replacement token remains valid. The regression passed locally as part of the 115-test suite; CI for this test-only extension is pending.

Residual risks: the one-time replacement token is transmitted over loopback HTTP and printed to CLI stdout; local processes running as the same user may inspect or capture it. If the rotation response is lost after the server commits the new hash, the replacement token cannot be recovered from SQLite; stop the server and use the exclusive-lock offline recovery command to rotate again and obtain a fresh token. SQLite releases the lock reservation after forced termination; the persistent sidecar is reused. The lock is cooperative process coordination, not a security boundary against a same-user process or local administrator that can modify the parent directory or unlink/replace the sidecar while another process is using it. Acquisition rejects symbolic links, non-regular/non-empty files, and hard-linked sidecars (nlink !== 1), but these are pre-open checks: portable Node DatabaseSync(path) cannot bind the SQLite connection to a previously verified no-follow file descriptor. The validation-to-open race remains inside the trusted-directory boundary. The environment variable for the server and CLI must be updated by the operator before restart or further authenticated CLI calls.

## Windows filesystem permissions

A local Windows inspection of the repository current .data directory found inherited Authenticated Users: Modify and Users: Read & Execute access. This is an observation about this machine current NTFS ACL, not a claim about all Windows installations. The existing data directory and its files were not modified.

An opt-in PowerShell helper, scripts/secure-data-acl.ps1, now hardens a dedicated data directory and its descendants to explicit Full Control for only the invoking user, SYSTEM, and local Administrators. It rejects reparse points, checks for open files before changing anything, supports -WhatIf, disables inherited ACLs on each item, and attempts in-memory ACL rollback if an update fails. A disposable-tree test verifies the allowed principals, WhatIf behavior, and refusal when a file is open. The test is included in Windows CI.

Residual risks: this helper is not automatically applied; operators must run it separately for data and backup directories after stopping processes. It does not protect against local Administrators, SYSTEM, malware running as the same user, or offline disk access. The helper test does not establish protection against every NTFS reparse/hard-link race or validate ACL behavior on non-NTFS filesystems.

## WAL recovery and process termination

The WAL recovery regression launches a child process, opens an immediate write transaction, confirms the uncommitted update is active, and forcibly terminates that process. Reopening the database recovers the prior committed task state (`queued`), and a truncate checkpoint succeeds. The test passed in CI on Node 24 and Node 26 / Windows. Graceful shutdown is tested separately through the same runtime shutdown function used by the SIGINT/SIGTERM handlers: it stops accepting HTTP requests, closes idle connections, completes the close callback, closes SQLite, and permits a successful database reopen. The integration test runs on Windows; delivery of operating-system console signals themselves is not asserted by the test.

## Reviewed controls (implementation inspection only)

| Area | Observation | Review state |
|---|---|---|
| Network binding | Server binds to `127.0.0.1` | Inspected; runtime verification still required |
| Host validation | HTTP handler accepts loopback Host names and rejects others | Inspected; parser edge cases need independent testing |
| HTTP limits | Header, request, body, keep-alive, and per-socket limits are configured | Inspected; existing integration coverage present |
| Credential separation | Operator and Participant credentials use distinct routes and checks; lease token is separately required for worker mutations | Inspected; independent adversarial testing pending |
| Token storage | Operator and Participant token hashes are stored; lease hashes are stored | POSIX main DB and WAL/SHM files are restricted to 0600; Windows ACL helper remains operator-managed and has not been applied to live data |
| Audit immutability | SQLite triggers reject event UPDATE and DELETE | Inspected; privileged filesystem/database access can bypass application-level guarantees |
| Dashboard | Operator token is held in page memory; task views use metadata-only summary endpoints; dynamic values use `textContent`; no HTML injection sinks, console logging, or payload/result rendering. Blocked-task recovery requires a recognized latest block event, reason, and two separate operator attestations; the API revalidates the mutation. | Chrome 157 headless acceptance passed against an isolated in-memory SQLite database: Operator login, blocked-task inspection, latest block-event display, payload non-rendering, empty browser storage, required confirmations, successful requeue, refreshed queued status, and visible `task.requeued` audit event. Chrome 157 headless acceptance also passed for the participant inspector against an isolated in-memory SQLite database: metadata, registration/capability-change/revocation history, blocked-task reference, credential non-rendering, empty browser storage, and inspector close/clear. Event detail rendering uses explicit event-type allowlists and `textContent`; HTTP tests confirm participant detail is Operator-only and excludes credentials. Node DOM-harness and HTTP regressions pass. No live project data used. |
| Backup/restore | Dedicated backup and offline restore implementation exists; fault-injection covers installation and rollback failures | POSIX database, WAL/SHM, backup, and restored database modes are restricted to 0600; Windows ACLs on data and backup directories remain an operator responsibility |
| Startup recovery | Expired active leases are reconciled before listening and periodically | Startup integration test exists; forced WAL termination and graceful runtime shutdown tests passed in CI on Node 24/26 Windows |

## Open review work

- [x] Remediate SEC-001 for new events; retain the documented historical-data residual risk.
- [x] Test backup/restore path validation, overwrite resistance, symlink/junction rejection, and rollback success/failure paths (local Windows fault-injection tests; CI pending).
- [x] Verify WAL rollback after forced child-process termination and database reopen (local Windows test).
- [x] Verify graceful runtime shutdown drains HTTP and closes SQLite; startup recovery and forced WAL termination are covered (Node 24/26 Windows CI).
- [x] Add startup listener-failure fault injection; verify SQLite can be reopened and the runtime lock is released after `EADDRINUSE` (`test/server-runtime.test.js`).
- [x] Exercise shutdown when the listener has already stopped; verify the close error is surfaced while SQLite closes and the runtime lock is released (`test/server-runtime-shutdown-failure.test.js`). Forced termination during the shutdown drain window remains untested.
- [x] Reject malformed Host authorities that could use URL userinfo to disguise a remote host (SEC-002; CI verified).
- [ ] Complete broader URL/Host parsing and adversarial raw HTTP parser review.
- [x] Prevent CLI Operator-token forwarding to non-loopback API overrides (SEC-003; CI verified).
- [x] Add and test an opt-in Windows ACL hardening helper for a dedicated data directory.
- [ ] Apply and verify restrictive ACLs on the actual configured data and backup directories after the operator stops all processes; no live ACL has been changed.
- [x] Make Operator token rotation immediate in the running server and redact echoed credentials from CLI API errors.
- [x] Add offline token recovery guarded by a per-database exclusive runtime lock.
- [ ] Independently review token handling under local filesystem and backup threat scenarios.
- [x] Add regression coverage for credential redaction in HTTP errors, audit events, CLI failures, and dashboard output/source sinks.
- [ ] Obtain independent adversarial review of credential handling and interactive browser behavior.
- [ ] Obtain an independent security review from a reviewer who did not implement the controls.

## Gate

Phase 4 security work remains **in progress**. This document is preparation for an independent review, not evidence that such a review has passed. Keep the API loopback-only until the independent review gate is completed.

Backup temporary-file handling: failed VACUUM INTO operations remove partial snapshots in an error path. After a maintenance lock is acquired, the next operation removes only regular files matching the exact destination-specific UUID temp pattern; symlinks, directories, and preserved .pre-restore-* rollback files are not removed. A forced crash can leave a stale maintenance lock, which still requires operator verification before removal.

### SEC-004 � URL canonicalization expanded the exact Host allowlist

Severity: **Low**
Status: **Remediated; local regression tests passed on 2026-11-08**

Evidence (pre-remediation):
- `src/http-server.js` passed the raw Host authority to the WHATWG `URL` parser and then compared only the canonicalized `hostname` with the loopback allowlist.
- WHATWG URL parsing canonicalizes alternate numeric IPv4 forms such as the integer, hexadecimal, and octal spellings of `127.0.0.1` to the same hostname. Those forms were therefore accepted even though the documented policy names only the conventional loopback authorities.

Impact:
- The accepted Host syntax was broader than the explicit allowlist. These examples still canonicalize to loopback; this finding does not establish remote access or a network-boundary bypass. It is a strict-policy and parser-consistency defect.

Remediation:
- Validate the raw authority against the exact `127.0.0.1`, `localhost`, or `[::1]` forms, with an optional numeric port, before URL parsing.
- Keep URL parsing as a secondary syntax/port validation step.
- Add raw TCP regression cases for integer (`2130706433`), hexadecimal (`0x7f000001`), and octal (`0177.0.0.1`) spellings.
- Document the exact accepted authority forms in the API and security contracts.

Verification:
- Windows local `npm test`: 108 passed, 2 skipped, 0 failed (110 total).
- `npm run check` and `git diff --check` passed.
- Supported-runtime CI run `42477292999` passed on Node 24/26 � Linux/Windows.

Residual risk:
- This is an internal finding and has not been independently reviewed. The API remains loopback-only; no remote ingress is authorized.

### SEC-005 - Operator token bootstrap accepted values rejected by the Bearer parser

Severity: **Low**
Status: **Remediated; local regression tests and supported-runtime CI passed**

Evidence (pre-remediation):
- `bootstrapOperatorToken` accepted any supplied string of at least 32 characters and persisted its SHA-256 hash.
- The HTTP Bearer parser accepts only `[A-Za-z0-9_-]` characters. A supplied token containing characters such as `+`, `/`, `=`, or whitespace could therefore initialize the database but could never authenticate an HTTP request.
- The same minimum-length-only validation existed at the HTTP server construction boundary.

Impact:
- A custom operator token could leave an initialized instance inaccessible through normal authenticated API operations. Offline token recovery remained available, but required stopping the server and performing a separate recovery operation.

Remediation:
- Enforce a full-string match against the URL-safe Bearer alphabet, with a 32 to 1024 character bound, before persisting a supplied token.
- Apply the same validation when constructing the HTTP server and parsing incoming Bearer credentials.
- Keep generated and rotated credentials as cryptographically random base64url tokens.
- Add regression tests proving invalid custom tokens are rejected before the initial credential hash is stored and that the server rejects invalid token inputs.
- Document the accepted custom-token format.

Verification:
- Windows local `npm test`: 108 passed, 2 skipped, 0 failed (110 total).
- `npm run check` and `git diff --check` passed.
- Supported-runtime CI run `42478010676` passed on Node 24/26 � Linux/Windows.

Residual risk:
- The finding concerns custom token format consistency, not token entropy. Operators supplying custom values remain responsible for using high-entropy secrets. Independent review remains pending.

### SEC-006 - Backup and restored database files inherited permissive POSIX modes

Severity: **Low**
Status: **Remediated; Windows local regression suite and POSIX CI verification passed**

Evidence (pre-remediation):
- SQLite `VACUUM INTO` created backup snapshots using filesystem creation permissions influenced by the process umask. Under a common `022` umask, a published backup could be readable by other local users if its parent directory was traversable.
- Restore copied the backup file to its staging path and installed it without tightening the copied mode, potentially carrying permissive source permissions to the live database.
- The Windows ACL helper does not apply to POSIX filesystems; Windows directory ACLs remain separately managed by the operator.

Impact:
- On POSIX hosts with permissive umask and directory permissions, local accounts other than the application owner could read backup contents or a restored database file.

Remediation:
- Before publishing a backup hard link, set the completed snapshot to mode `0600` and verify the effective mode.
- Before validating and installing a restored staging copy, set it to mode `0600` and verify the effective mode.
- Keep Windows ACL handling explicitly separate; do not claim `chmod` establishes NTFS access control.
- Add POSIX assertions for backup and restored database file modes.
- Document the distinction between POSIX file modes and Windows directory ACLs.

Verification:
- Windows local `npm test`: 108 passed, 2 skipped, 0 failed (110 total); POSIX-specific assertions are skipped on Windows.
- `npm run check` and `git diff --check` passed.
- Node 24/26 Linux and Windows CI runs `42478478780` and `42478474723` passed.

Residual risk:
- The destination directory and its parent must still be protected while a snapshot is being generated. This change restricts the completed snapshot before publication, not the permissions of pre-existing directories or temporary-file exposure during generation. Windows ACLs remain operator-managed. Independent security review remains pending.
### SEC-007 - SQLite database and WAL sidecars inherited permissive POSIX modes

Severity: **Low**
Status: **Remediated; Windows local regression suite and POSIX CI verification passed**

Evidence (pre-remediation):
- `openDatabase` created or opened the SQLite database and enabled WAL without restricting the main database file mode.
- On POSIX systems, SQLite file creation can inherit umask-derived permissions; with a common `022` umask, the database and its WAL/SHM sidecars could be readable by other local users when the parent directory was traversable.
- The database contains participant metadata, task payloads, credential hashes, leases, and audit history.

Impact:
- Local accounts other than the application owner could read sensitive application state from the database or active WAL sidecars on hosts with permissive file and directory defaults.

Remediation:
- Restrict the main database file to POSIX mode `0600` immediately after opening it and before enabling WAL.
- After migrations, restrict any existing WAL and SHM sidecars to `0600`; subsequent SQLite sidecars inherit the protected database mode.
- Verify the effective mode and fail closed if it cannot be restricted.
- Close the database handle if permission hardening or initialization fails.
- Add a POSIX regression that verifies the main database and active WAL/SHM modes, then deliberately loosens the main DB mode and confirms reopening tightens it.
- Document that Windows requires the separate operator-run NTFS ACL helper.

Verification:
- Windows local `npm test`: 108 passed, 3 skipped, 0 failed (111 total); POSIX mode regression is skipped on Windows.
- `npm run check` and `git diff --check` passed.
- Node 24/26 Linux and Windows CI runs `42478735992` and `42478731032` passed; both Linux jobs explicitly executed the POSIX mode test (111 passed, 0 failed).

Residual risk:
- This does not restrict pre-existing parent-directory permissions or Windows ACLs. A privileged local user can still access or replace files. Independent security review remains pending.
### SEC-008 - Database open followed symbolic-link and junction paths

Severity: **Low**
Status: **Remediated with pre-open path checks; local Windows regression suite and supported-runtime CI passed**

Evidence (pre-remediation):
- `openDatabase` resolved the configured path, created its parent directory, and passed the path directly to `DatabaseSync`.
- Unlike runtime-lock acquisition and backup/restore path validation, the normal database-open path did not reject symbolic-link or junction ancestors, nor a final-component database symlink.
- SQLite could therefore follow a configured or substituted link and open/create a database outside the apparent configured directory. On POSIX, the subsequent permission hardening could also chmod the link target.

Impact:
- A misconfigured database path or link placed in a writable path could redirect database access and permission changes to another filesystem target. This is not evidence of a remote attack; path ownership and local filesystem access remain in the trust boundary.

Remediation:
- Before creating parent directories, inspect every existing path component with `lstat` and reject symbolic links/junctions, non-directory ancestors, and a final component that exists but is not a regular file.
- Repeat the validation after recursive parent creation and immediately before `DatabaseSync`.
- Add a Windows directory-junction regression and a POSIX final-component symlink regression; assert that rejected paths do not create the target database.
- Document the residual validation-to-open race and trusted-parent-directory requirement.

Verification:
- Windows local `npm test`: 109 passed, 3 skipped, 0 failed (112 total).
- `npm run check` and `git diff --check` passed.
- Node 24/26 Linux and Windows CI matrix passed in workflow run `42479638677`.

Residual risk:
- These are pre-open checks, not an atomic no-follow open. Portable Node `DatabaseSync(path)` cannot bind SQLite to a previously verified file descriptor; a hostile actor able to replace path components between the final check and SQLite open may still redirect the open. Keep the database parent and its ancestors writable only by trusted principals. This does not defend against a same-user process or local administrator. Independent security review remains pending.
### SEC-009 - Backup snapshot exposed during generation

Severity: **Low**
Status: **Remediated on POSIX; local Windows regression suite and supported-runtime CI passed**

Evidence (pre-remediation):
- `createDatabaseBackupUnlocked` directed SQLite `VACUUM INTO` to a temporary file created directly in the destination directory.
- The file received mode `0600` only after VACUUM completed and validation began. Under a permissive POSIX umask and traversable destination directory, other local accounts could read the snapshot while it was being generated.

Impact:
- Sensitive database contents could be exposed to other local accounts during the backup generation window. No remote exposure is established.

Remediation:
- Generate the snapshot inside a destination-local UUID-named staging directory. On POSIX, create and verify that directory at mode `0700` before invoking SQLite; the snapshot file remains mode `0600` before publication.
- Keep staging on the destination filesystem so the existing hard-link publication remains atomic and cannot overwrite a raced-in destination.
- Extend stale-temp cleanup to remove only exact UUID staging directories that are empty or contain exactly one regular `snapshot.sqlite` file. Preserve symlinks and unexpected contents.
- Preserve cleanup warnings and crash recovery; add a crash test that leaves a staging directory and confirms a later locked backup safely cleans it.
- Add a concurrent-WAL test assertion that checks the staging directory is already mode `0700` while VACUUM is still running.

Verification:
- Windows local `npm test`: 109 passed, 3 skipped, 0 failed (112 total); `npm run check` and `git diff --check` passed.
- POSIX mode assertion is exercised by Linux CI, not by the Windows local run.
- Supported-runtime CI run 42480610561 passed Node 24/26 on Linux and Windows; Linux exercised the POSIX staging-directory mode assertion.

Residual risk:
- On Windows, the staging directory inherits the destination parent NTFS ACL; portable Node APIs used here do not set a restrictive Windows DACL. Operators must restrict the backup directory with the documented ACL helper. A same-user process or local administrator remains outside this protection boundary. Independent security review remains pending.
### SEC-010 - Reference Worker inherited the Operator environment credential

Severity: **Low**
Status: **Remediated in the reference worker; local Windows regression suite and supported-runtime CI passed**

Evidence (pre-remediation):
- The documented PowerShell workflow set RAYA_CC_OPERATOR_TOKEN to register a Participant and then launched the reference Worker from the same shell.
- Node child processes inherit the parent environment unless the launcher supplies an explicit environment map. The Worker did not use the Operator token, but it remained readable through process.env to all code executing in that Worker process.

Impact:
- A compromised or later-extended Worker code path could read an Operator credential that was not required for its Participant role. This is a local process credential-isolation weakness, not an API authorization bypass.

Remediation:
- Remove RAYA_CC_OPERATOR_TOKEN immediately during reference Worker startup, before task processing or application logic.
- Document removing the Operator token from the launching PowerShell environment before starting the Worker.
- Add a focused regression for the environment-sanitization helper.

Verification:
- Windows local npm test: 110 passed, 3 skipped, 0 failed (113 total); npm run check and git diff --check passed. The focused environment helper regression passed. CI run 42482491748 passed all four Node 24/26 × Linux/Windows jobs.

Residual risk:
- Startup sanitization occurs after Node process initialization. It does not defend against injected preload hooks, a compromised launcher, or a malicious same-user process that can inspect process memory/environment at launch. Production process supervisors should construct an explicit allowlisted child environment and must not pass Operator credentials to Worker processes. Independent security review remains pending.

### SEC-011 - Restore can resurrect credentials revoked after the snapshot

Severity: **Medium**
Status: **Mitigated by a mandatory post-Restore credential-reset procedure; local full suite passed**

Evidence:
- SQLite Backup includes the settings.operator_token_hash, participants.token_hash and participant status, plus active Lease hashes/status and task assignments.
- A regression test creates a Backup, then rotates the Operator token and revokes a Participant. Restoring the older Backup makes the old Operator token valid again, restores the Participant as active, and restores its previously active Lease token.
- This is inherent point-in-time snapshot behavior; the live rotation and revocation operations themselves work as designed.

Impact:
- If clients reconnect immediately after restoring an older Backup, credentials revoked or rotated after the snapshot can become valid again. A restored unexpired Lease may also permit a worker to continue mutating a task.

Mitigation:
- Document a mandatory post-Restore sequence: keep all clients stopped, run offline Operator token recovery before server startup, start with the recovered token, revoke every restored active Participant before reconnecting any Worker/adapter, and re-register Participants with fresh tokens.
- Participant revocation also revokes active Leases and blocks affected nonterminal tasks.
- Add an integration regression proving the rollback behavior and the documented recovery sequence: Operator recovery rejects the old token, and Participant revocation rejects the old Participant/Lease credentials.

Verification:
- Windows local npm test: 111 passed, 3 skipped, 0 failed (114 total). The focused Restore credential rollback/recovery regression passed. npm run check and git diff --check passed. Supported-runtime CI run 42483414521 passed all four Node 24/26 x Linux/Windows jobs.

Residual risk:
- The procedure is operational and requires the operator to follow it. A user who starts workers before revoking restored Participants can temporarily re-enable old credentials. Restore intentionally preserves snapshot state and does not silently invalidate identities. Independent security review remains pending.

### SEC-012 - Runtime retained and exposed an unnecessary plaintext Operator token

Severity: **Low**
Status: **Remediated; local full suite passed**

Evidence:
- startControlCenter returned operatorToken as a normal property for every startup, including when an existing token was supplied through the environment.
- The only production consumer was server.js, which needs the token once only when the database is first initialized. After the initial display, the runtime object continued to retain the plaintext token for the full server lifetime; after rotation that retained value was stale.

Impact:
- Any code holding the runtime object could read a plaintext credential that it did not need. After rotation the retained token was invalid, but it remained unnecessary secret material in memory. This was not an API authentication bypass.

Remediation:
- Return the bootstrap token through a one-time consuming getter only when a new token was generated.
- Existing credentials are never exposed on the runtime return object.
- Add a regression proving first-start token access succeeds once and subsequent access, plus all existing-database startup access, returns undefined.

Verification:
- Windows local npm test: 112 passed, 3 skipped, 0 failed (115 total). The one-time runtime-token getter regression passed. npm run check and git diff --check passed. Supported-runtime CI run 42483414521 passed all four Node 24/26 x Linux/Windows jobs.

Residual risk:
- The server still must briefly hold the generated token to display it once at first initialization, and the HTTP layer retains only its hash for request authentication. Same-process memory inspection and privileged local access remain outside this control. Independent security review remains pending.
### SEC-013 - Operator authorization decision survived token rotation during body receipt

Severity: **Low**
Status: **Remediated; full local suite, static checks, diff checks, and supported-runtime CI passed on commit `1eaa1c04`**

Evidence:
- The HTTP handler originally compared the supplied Operator token with the current hash once, before route processing.
- `POST /tasks` and `POST /participants/register` then awaited the request body after that authorization check.
- A client could begin one of these requests with the current token, pause body transmission, have the Operator token rotated by another request, and then finish the body. The first request still used its stale authorization decision and completed successfully after rotation.
- A regression test reproduced this: the old-token Task creation returned HTTP 201 after a successful rotation, and the Task was persisted.

Impact:
- A request already in progress could perform an Operator action after the credential used to authorize it had been revoked by rotation. This required possession of the old valid token before rotation; no unauthenticated or remote-access bypass was established.

Remediation:
- Move Operator authorization for body-bearing Task creation and Participant registration until after the complete JSON body has been read.
- Make the Operator authorization helper compare against the current in-memory token hash at the point of authorization instead of capturing a Boolean decision at request arrival.
- Add a regression that pauses a Task-creation body, rotates the token, completes the body, and asserts HTTP 401 with no Task persisted.

Verification:
- Before the fix, the focused regression failed as expected: old-token request returned HTTP 201 after rotation.
- After the fix, `node --test test/http-server.test.js` passed all 10 tests, including the new in-flight rotation regression.
- Final verification on commit `1eaa1c04`: Windows local suite 118 passed, 3 skipped, 0 failed; `npm run check` and `git diff --check` passed; GitHub Actions Node 24/26 Linux and Windows all passed.

Residual risk:
- A synchronous operation that has already passed authorization and begun execution cannot be interrupted mid-operation by a later rotation; JavaScript event-loop execution serializes that operation with the rotation handler. Requests still awaiting their body are now checked after receipt. Independent security review remains pending.

### SEC-AUTO-001 - Dashboard refresh could repopulate data after Disconnect

Severity: **Low**
Status: **Remediated; expanded local regression coverage and supported-runtime CI passed; independent review pending**

Evidence:
- `dashboard/dashboard.js` previously allowed `refresh()` to update the DOM after its four parallel API requests completed, without checking whether the Operator session that initiated the refresh was still active.
- `disconnect()` cleared the token and rendered empty states but did not cancel or invalidate in-flight refreshes.

Impact:
- A response arriving after Disconnect could repopulate operational data in the page after the user had ended the dashboard session. This was a local browser data-retention/UI-state issue; it did not bypass API authorization or restore the cleared Operator token.

Remediation:
- Give each connected session an epoch and each refresh an AbortController.
- Abort the active refresh on Disconnect and when a newer refresh/session supersedes it.
- Capture the initiating token and signal for requests; only the still-current session/refresh may render data, report errors, or update button state.
- Clear any displayed error during Disconnect.

Verification:
- Added `test/dashboard-session.test.js`, which starts all four API requests, disconnects, then deliberately resolves the mocked requests successfully despite their aborted signals. It verifies that task/participant/event tables, routing metrics, status, and button state remain disconnected/empty. Additional tests cover late request errors after Disconnect and ensure an older session cannot overwrite a newer session.
- Focused regression test passed locally. Full Windows local suite on the current local worktree: 121 passed, 3 skipped, 0 failed (124 total). `npm run check` and `git diff --check` passed. A separate regression in `test/http-server.test.js` was made deterministic by ending the in-flight request body only after the token-rotation response, rather than relying on competing timers.
- Local runtime was Node.js 22.23.2, below the declared Node >=24.15.0 engine; supported-runtime CI for the original SEC-AUTO-001 fix passed both full Node 24/26 × Linux/Windows runs [42499872878](https://github.com/ijoolaie/Raya-Control-Center/actions/runs/42499872878) and [42499868351](https://github.com/ijoolaie/Raya-Control-Center/actions/runs/42499868351). The expanded regression changes are included in PR head `bcd559845990479fb33760471f389d0b2b5e0c20` and passed two complete Node 24/26 Linux/Windows CI matrices (8/8 jobs total; runs 42567422511 and 42567415316).

Residual risk:
- AbortController is best-effort cancellation; the session/refresh epoch checks are the enforcement mechanism that prevents late responses from mutating the DOM. Independent security review remains pending.

### SEC-AUTO-001 expanded regression and supported-runtime verification - bcd5598

- Added separate regressions for late API errors after Disconnect and stale responses from an older session arriving after a newer session starts; retained the late-success-after-Disconnect regression.
- Stabilized the in-flight token-rotation HTTP regression by holding the old request body open until the rotation response completes, removing timer-order dependence.
- Local Windows full suite: 121 passed, 3 skipped, 0 failed (124 total); `npm run check` and `git diff --check` passed. Local Node 22.23.2 is below the declared Node >=24.15.0 engine.
- Commit `bcd559845990479fb33760471f389d0b2b5e0c20` passed both full Node 24/26 x Linux/Windows CI runs: [42567422511](https://github.com/ijoolaie/Raya-Control-Center/actions/runs/42567422511) and [42567415316](https://github.com/ijoolaie/Raya-Control-Center/actions/runs/42567415316). All 8/8 job executions succeeded.
- The independent security review remains pending; CI and implementer-authored tests are not independent verification.

### PR-head synchronization and verification - e236c27

- Documentation synchronization commit: `e236c2785412a6b5a5d610c8b9a99dbf8ffb6d49`; implementation code is unchanged from `bcd5598`.
- Fresh local Windows validation on this checkout: `npm test -- --test-concurrency=1` — 121 passed, 3 skipped, 0 failed (124 total); `npm run check` and `git diff --check` passed. Local Node 22.23.2 is below the declared Node >=24.15.0 engine.
- Both CI runs for exact PR head `e236c2785412a6b5a5d610c8b9a99dbf8ffb6d49` passed the full Node 24/26 x Linux/Windows matrix: [42569062230](https://github.com/ijoolaie/Raya-Control-Center/actions/runs/42569062230) and [42569057493](https://github.com/ijoolaie/Raya-Control-Center/actions/runs/42569057493), 8/8 job executions successful.
- Independent security review remains pending; local tests and CI do not constitute independent verification.

### Authoritative PR-head verification - 33aada8

This section supersedes earlier notes that identify `bcd5598` or `e236c27` as the current PR head, or state that CI for `33aada8` is pending.

- Current PR head: `33aada816360b247383c1796a4727a9d2115f9b0` (documentation-only synchronization; implementation code is unchanged from `e236c27`).
- CI for exact current head passed all four Node 24/26 x Linux/Windows jobs in [42569592118](https://github.com/ijoolaie/Raya-Control-Center/actions/runs/42569592118).
- The preceding implementation/test head `bcd5598` passed both complete matrices [42567422511](https://github.com/ijoolaie/Raya-Control-Center/actions/runs/42567422511) and [42567415316](https://github.com/ijoolaie/Raya-Control-Center/actions/runs/42567415316); `e236c27` passed both [42569062230](https://github.com/ijoolaie/Raya-Control-Center/actions/runs/42569062230) and [42569057493](https://github.com/ijoolaie/Raya-Control-Center/actions/runs/42569057493).
- Local Windows suite on `e236c27`: 121 passed, 3 skipped, 0 failed (124 total); `npm run check` and `git diff --check` passed. Node 22.23.2 is below the declared Node >=24.15.0 engine; CI provides supported Node 24/26 coverage.
- Independent security review remains pending. The reviewer must fetch and review the exact PR head at review start. CI and implementer tests are not independent verification.

### Current implementer verification - 2026-11-09 - PR head df6f9a9

- Exact PR head: `df6f9a981e5cba24d8ca3e8697e9abfbd99890c7`.
- Since implementation/test head `bcd559845990479fb33760471f389d0b2b5e0c20`, only the two security-review documentation files changed; application source and tests are unchanged.
- Fresh local checks: `npm run check` passed; `npm test -- --test-concurrency=1` reported 121 passed, 3 skipped, 0 failed (124 total); `git diff --check` passed. Local Node 22.23.2 is below the declared Node >=24.15.0 engine; this local run is supplemental only.
- Exact-head CI runs [42606770468](https://github.com/ijoolaie/Raya-Control-Center/actions/runs/42606770468) and [42606777734](https://github.com/ijoolaie/Raya-Control-Center/actions/runs/42606777734) each passed the complete Node 24/26 x Linux/Windows matrix (8/8 successful job executions total).
- Limited implementer source reinspection revisited HTTP Host/request-target and bearer parsing, post-body Operator authorization, database path checks, SQLite runtime/maintenance locks, and Worker environment sanitization. No additional confirmed issue is recorded from this limited pass; this is not exhaustive and does not constitute independent verification.
- Local automated security scanners `gitleaks`, `semgrep`, `codeql`, `osv-scanner`, and `trivy` are not installed and have not been run. No lockfile-backed npm dependency audit is available because this repository has no `package-lock.json` and declares no external npm dependencies.
- No independent reviewer has submitted a review. Independent security review remains pending; this status is not a certification or proof of absence of vulnerabilities. PR #1 remains Open, Draft, and Unmerged; API remains loopback-only. No live `.data`, ACLs, credentials, or network binding settings were changed.

### Automated security workflow - first successful runs (2026-11-09)

- Added `.github/workflows/security.yml` with Gitleaks full-history scanning and CodeQL JavaScript/TypeScript analysis. Actions are pinned to release commit SHAs; Gitleaks comments and SARIF artifact uploads are disabled.
- Gitleaks passed in both Security Scans runs [42608720608](https://github.com/ijoolaie/Raya-Control-Center/actions/runs/42608720608) and [42608727762](https://github.com/ijoolaie/Raya-Control-Center/actions/runs/42608727762).
- CodeQL completed and uploaded results in both runs. The logged scan covered 36/36 JavaScript files and 1/1 HTML files. The available connector did not expose the code-scanning alert inventory; successful analysis must not be interpreted as zero alerts. Review alerts in [GitHub Code Scanning](https://github.com/ijoolaie/Raya-Control-Center/security/code-scanning).
- CI runs [42608720748](https://github.com/ijoolaie/Raya-Control-Center/actions/runs/42608720748) and [42608727733](https://github.com/ijoolaie/Raya-Control-Center/actions/runs/42608727733) passed all four Node 24/26 x Linux/Windows jobs in each run.
- These are automated/implementer checks, not an independent security review. Independent review remains pending; PR #1 remains Open, Draft, and Unmerged; API remains loopback-only.

### PR CodeQL alert result - 2026-11-09 - head 558a783

- The GitHub `CodeQL` Check Run for PR #1 at exact head `558a7835b0abac498137d711ac6c87623ff1bb5c` completed successfully and reported: **No new alerts in code changed by this pull request**. Annotation count: 0.
- Scope limitation: this means no new CodeQL alerts were reported in the PR's changed code. It does not prove that the default branch has no existing open alerts. The full branch alert inventory still needs review in GitHub Security > Code scanning.
- CI runs [42608970562](https://github.com/ijoolaie/Raya-Control-Center/actions/runs/42608970562) and [42608964114](https://github.com/ijoolaie/Raya-Control-Center/actions/runs/42608964114) passed all four Node 24/26 x Linux/Windows jobs. Security Scans [42608970625](https://github.com/ijoolaie/Raya-Control-Center/actions/runs/42608970625) and [42608964174](https://github.com/ijoolaie/Raya-Control-Center/actions/runs/42608964174) also completed successfully.
- Independent security review remains pending. No independent reviewer has been identified or submitted a report.

### Dashboard Participant capability management - implementer verification

- Added an Operator-only editor to the existing Participant inspector; it reuses the existing `POST /participants/{id}/capabilities` route and does not add a new authorization path or mutate Participant credentials.
- The UI shows the exact added/removed capability sets before submission, rejects malformed/duplicate identifiers and more than 64 entries client-side (the API remains authoritative), requires a separate acknowledgement, and presents a final native confirmation containing the Participant identity and diff.
- The editor is hidden while a Participant is loading and for disabled/revoked Participants. Session/selection checks prevent stale inspection responses from enabling edits for a different Participant. Closing or disconnecting clears editor state. The service transaction also rechecks Participant status and rejects capability changes for disabled/revoked Participants, closing the stale-editor/revocation race at the API boundary.
- The existing service transaction records `participant.capabilities_updated` with previous/current values and `affects: future_claims_only`; active Leases are preserved by the existing service behavior. Capabilities remain scheduling metadata, not authorization scopes.
- Added DOM-harness coverage for diff rendering, duplicate rejection, confirmation gating, the exact authenticated POST body, refreshed Participant state, and audit history. Focused dashboard tests passed 7/7 on the local Windows host.
- This is implementer-authored UI and regression evidence only. Local Windows full-suite verification on Node 22.23.2 (below the declared Node >=24.15.0 engine): 139 passed, 3 skipped, 0 failed (142 total); `npm run check`, syntax checks, and `git diff --check` passed. The follow-up active-status guard commit d9347732f5d538fab7105f369443e26b5de05a05 passed both full Node 24/26 x Linux/Windows CI matrices: push [42814969212](https://github.com/ijoolaie/Raya-Control-Center/actions/runs/42814969212) and pull_request [42814976477](https://github.com/ijoolaie/Raya-Control-Center/actions/runs/42814976477), all 4/4 jobs in each run. Security Scans also completed successfully on push [42814969238](https://github.com/ijoolaie/Raya-Control-Center/actions/runs/42814969238) and pull_request [42814976304](https://github.com/ijoolaie/Raya-Control-Center/actions/runs/42814976304), with CodeQL JavaScript analysis and Gitleaks successful in both runs. These automated results do not replace independent security review, which remains pending. No live `.data`, ACLs, credentials, or API binding settings were changed.

### Capability editor - isolated Chrome acceptance (2026-11-10)

- Ran Chrome 157 headless against the actual dashboard and HTTP server, with a fresh in-memory SQLite database and loopback-only listener. The fixture Participant and Operator token existed only in this isolated test process.
- Verified successful Operator login, opening an active Participant inspector, exact sorted Added/Removed diff, acknowledgement gating, final confirmation text, successful API update, refreshed capability display, and the `participant.capabilities_updated` audit row rendered in the browser.
- Verified both localStorage and sessionStorage remained empty and that closing the inspector/disconnecting hid the editor and cleared its textarea and Operator-token input.
- Assertions passed. The temporary acceptance script and isolated Chrome profile were removed. No live `.data`, ACLs, credentials, or network binding settings were accessed or modified.
- This is implementer-run acceptance evidence, not independent security review. PR #1 remains Open, Draft, and Unmerged; the API remains loopback-only pending independent review.

### Implementer raw HTTP parser regression sweep (2026-11-10)
- Added a raw-TCP regression test for duplicate Host headers, userinfo Host authorities, integer/hex/octal IPv4 spellings, trailing-dot hostnames, invalid ports, absolute-form and network-path request targets, backslashes, fragments, Transfer-Encoding plus Content-Length ambiguity, duplicate Content-Length, and obsolete folded headers.
- The focused HTTP suite passed 16/16 tests. Full local suite passed 140, skipped 3, failed 0 (143 total); `npm run check` and `git diff --check` passed.
- The sweep ran on local Node 22.23.2, below the declared Node >=24.15.0 engine. Supported-runtime CI must verify the added test on Node 24/26 and Linux/Windows.
- Follow-up URL-normalization probes found that WHATWG URL parsing normalized percent-encoded dot segments before route matching (for example, `/control/v1/participants/%2e%2e/health` reached the health route). This was not an authentication bypass—the health route is intentionally public—but it was a non-canonical path interpretation risk.
- Added pre-parse canonical path validation. Literal/encoded `.` and `..` segments and encoded slash/backslash separators are now rejected before URL normalization. Regression cases cover mixed-case encoded dot segments, literal dot segments, and encoded separators.
- Focused HTTP tests passed 16/16. Full local suite passed 140, skipped 3, failed 0 (143 total) on the final rerun; `npm run check` and `git diff --check` passed. One initial full-suite run had a transient existing concurrency assertion mismatch (`lease_mismatch` vs `invalid_transition`); immediate full rerun passed.
- Local runtime is Node 22.23.2, below declared Node >=24.15.0; supported-runtime CI must verify this change on Node 24/26 and Linux/Windows. This is implementer-run evidence, not independent security review. The review gate remains open; API remains loopback-only.

### Implementer HTTP disconnect side-effect regression (2026-11-10)
- Added a raw TCP regression that starts an authenticated `POST /tasks` with a declared body length larger than the bytes sent, then closes the client socket mid-body.
- The isolated in-memory database is checked after the abort: no Task row is created. A subsequent health request succeeds, showing that the listener remains usable after the aborted upload.
- Focused HTTP suite: 17/17 passed. Full local suite: 141 passed, 3 skipped, 0 failed (144 total). `npm run check` and `git diff --check` passed.
- The local runtime is Node 22.23.2, below the declared Node >=24.15.0 engine. The immediately preceding exact head `d5ac3c8632cda99805305e758f1932c27598dca4` passed CI and Security Scans on both push and pull_request events: CI [42826765931](https://github.com/ijoolaie/Raya-Control-Center/actions/runs/42826765931), [42826776228](https://github.com/ijoolaie/Raya-Control-Center/actions/runs/42826776228); Security Scans [42826765818](https://github.com/ijoolaie/Raya-Control-Center/actions/runs/42826765818), [42826776444](https://github.com/ijoolaie/Raya-Control-Center/actions/runs/42826776444). Each CI run passed Node 24/26 x Linux/Windows; each Security Scans run completed successfully.
- This new test has not yet been pushed or run in supported-runtime CI. It is implementer-run evidence only. No runtime source, live `.data`, ACLs, credentials, or API binding settings were changed. Independent human security review remains pending; PR #1 remains Open, Draft, and Unmerged; API remains loopback-only.

### Implementer HTTP keep-alive and pipelining regression (2026-11-10)
- Added a raw TCP test that sends two pipelined health requests over one HTTP/1.1 connection: the first requests keep-alive and the second explicitly requests close.
- The test verifies both responses are returned, the response connection policies match the requests, and the configured header/request/keep-alive timeouts remain 10s/30s/5s. No runtime configuration change was needed.
- Focused HTTP suite: 18/18 passed. Full local suite: 142 passed, 3 skipped, 0 failed (145 total). `npm run check` and `git diff --check` passed.
- This commit's CI and Security Scans will be run on supported Node 24/26 and Linux/Windows after push. Previous commit `36b1770e9097b04aee0fdaf5634b3f211c3ee7bf` passed all four CI/Security push and pull_request workflows.
- Implementer-run evidence only; independent human security review remains pending. PR #1 remains Open, Draft, and Unmerged; API remains loopback-only. No live `.data`, ACLs, credentials, or API binding settings were changed.

### Implementer HTTP Expect: 100-continue body-limit regression (2026-11-10)
- A raw TCP probe confirmed Node's default HTTP behavior sent `100 Continue` for a request declaring a 20,000-byte body, before the API's existing 16 KiB streaming body limit could reject it.
- Added an explicit `checkContinue` handler. Declared Content-Length values above 16 KiB now receive `413 Payload Too Large` with `Connection: close` before the server invites upload; accepted-size requests receive `100 Continue` and proceed through the existing request handler and streaming body limit.
- Added an isolated in-memory SQLite raw-TCP regression proving early rejection, absence of a task side effect, and continued health of the listener.
- Focused HTTP suite: 19/19 passed locally on Node 22.23.2 (below declared Node >=24.15.0); supported-runtime Node 24/26 Linux/Windows CI is required after push.
- This is implementer-run evidence only. Independent human security review remains pending; PR #1 remains Open, Draft, and Unmerged; API remains loopback-only. No live `.data`, ACLs, credentials, or network binding settings were changed.

### Implementer HTTP resource-limit verification (2026-11-10)
- Verified the existing Node HTTP parser rejects a request header exceeding the configured 8 KiB `maxHeaderSize` with `431 Request Header Fields Too Large`; the raw-TCP regression now covers this boundary.
- Verified `maxRequestsPerSocket = 100` is enforced in practice: 100 pipelined health requests receive `200 OK`, and request 101 receives `503 Service Unavailable` with `Connection: close`. Added a raw-TCP regression and explicit assertions for the configured header-size and per-socket request limits.
- Existing time bounds remain `headersTimeout = 10s`, `requestTimeout = 30s`, and `keepAliveTimeout = 5s`. No arbitrary concurrent-connection cap was added: this service binds only to `127.0.0.1`, and no evidence justified a new compatibility-impacting limit.
- Full local suite: 144 passed, 3 skipped, 0 failed (147 total); HTTP suite: 20/20 passed; `npm run check` and `git diff --check` passed. Local Node is 22.23.2, below declared Node >=24.15.0; supported-runtime CI is required after push.
- Implementer-run evidence only; independent human security review remains pending. PR #1 remains Open, Draft, and Unmerged; API remains loopback-only. No live `.data`, ACLs, credentials, or remote binding settings were changed.

### Chunked Expect body-limit regression (2026-11-10)
- Added a raw-TCP case for `Expect: 100-continue` with chunked transfer encoding, where no Content-Length is available for preflight rejection.
- Confirmed the server sends `100 Continue`, then enforces the existing streaming 16 KiB limit and returns `413 Payload Too Large` when the chunked JSON body exceeds it; the in-memory task table remains unchanged.
- Focused HTTP suite: 21/21 passed. Full local suite: 145 passed, 3 skipped, 0 failed (148 total); `npm run check` and `git diff --check` passed. Local Node 22.23.2 remains below the declared Node >=24.15.0 engine; supported-runtime CI is required.
- This is implementer-run evidence only. Independent human security review remains pending. PR #1 remains Open, Draft, and Unmerged; API remains loopback-only.

### Supported-runtime CI and Security Scans — e0ed184
- Exact implementation head `e0ed184e4ea7dfd66f17ec5a30cf8a14465b3ca9` passed both CI events: Push [42854922674](https://github.com/ijoolaie/Raya-Control-Center/actions/runs/42854922674) and Pull Request [42854943126](https://github.com/ijoolaie/Raya-Control-Center/actions/runs/42854943126). Each completed all four Node 24/26 × Linux/Windows jobs successfully.
- Security Scans also passed on both events: Push [42854923220](https://github.com/ijoolaie/Raya-Control-Center/actions/runs/42854923220) and Pull Request [42854942863](https://github.com/ijoolaie/Raya-Control-Center/actions/runs/42854942863). Both CodeQL JavaScript analysis and Gitleaks succeeded in each run.
- This verifies automated workflows for the exact implementation head, including the chunked streaming body-limit regression. It does not replace independent human security review, which remains pending.
- PR #1 remains Open, Draft, and Unmerged; API remains loopback-only.

### Latest PR-head verification — 2026-11-11 — cda54be

- Exact PR head: `cda54be60baabd7e839246c2661010db3afe6a7e`. This documentation-only commit corrected the README and Operations guide so both accurately describe the Participant capability editor and controlled blocked-Task requeue; no application source or test code changed.
- CI passed on both push [42895848466](https://github.com/ijoolaie/Raya-Control-Center/actions/runs/42895848466) and pull_request [42895860177](https://github.com/ijoolaie/Raya-Control-Center/actions/runs/42895860177). Each passed Node 24/26 × Linux/Windows (4/4 jobs; 8/8 total).
- Security Scans passed on push [42895848388](https://github.com/ijoolaie/Raya-Control-Center/actions/runs/42895848388) and pull_request [42895860146](https://github.com/ijoolaie/Raya-Control-Center/actions/runs/42895860146). CodeQL JavaScript analysis and Gitleaks succeeded in both runs.
- The working tree is clean and local `HEAD` matches `origin/bootstrap/project-foundation` at this exact commit. PR #1 remains Open, Draft, and Unmerged; the API remains bound to loopback.
- These are automated CI/security results, not an independent security review. No independent reviewer has submitted a report; the review gate remains pending. No live `.data`, ACLs, credentials, or API binding settings were changed.

### Latest PR-head verification — 2026-11-11 — 298df35

- Exact PR head: `298df35484e9657206ca79ba5b04a629eddaea62`. This documentation-only commit synchronized the security review register with the preceding verified head `cda54be`; application source and tests are unchanged.
- Exact-head CI passed on push [42897060373](https://github.com/ijoolaie/Raya-Control-Center/actions/runs/42897060373) and pull_request [42897068342](https://github.com/ijoolaie/Raya-Control-Center/actions/runs/42897068342). Each passed Node 24/26 × Linux/Windows (4/4 jobs; 8/8 total).
- Security Scans passed on push [42897060257](https://github.com/ijoolaie/Raya-Control-Center/actions/runs/42897060257) and pull_request [42897068519](https://github.com/ijoolaie/Raya-Control-Center/actions/runs/42897068519). CodeQL JavaScript analysis and Gitleaks succeeded in both runs.
- GitHub reports no submitted PR reviews or review comments; no independent reviewer is recorded. Independent security review remains pending and must begin against the exact then-current PR head.
- PR #1 remains Open, Draft, and Unmerged. API remains loopback-only. No application source, tests, live `.data`, ACLs, credentials, or network binding settings were changed.

### Owner decision and AI-assisted review checkpoint — 2026-11-11

- Project owner decision: a third-party/human independent security review is not required for the current project workflow. The owner will perform the final review with AI assistance. This supersedes earlier roadmap and handoff statements that made an independent reviewer a project gate; those older entries remain as historical records.
- Review classification: **owner-led AI-assisted internal security review**. Do not describe it as an independent review, penetration test, certification, or proof that the application is vulnerability-free.
- Exact review baseline: PR #1 head 9469925d1f2e6c0529e0dc2abea107224a82be0c.
- Initial source areas inspected: src/http-server.js, src/operator-auth.js, src/server-runtime.js, src/database-runtime-lock.js, src/control-center.js, src/db.js, src/cli.js, examples/reference-worker/worker.mjs, examples/reference-worker/environment.mjs, and dashboard/dashboard.js.
- Initial pass focused on Host/request-target validation, bearer-token handling and rotation, post-body authorization checks, participant/lease validation, capability-aware claim selection, database path checks and runtime locks, CLI URL restrictions, Worker credential sanitization, and dashboard session-epoch handling. No confirmed exploitable finding was established in this limited first pass. This is not a completion claim; backup/restore fault paths, full browser-origin behavior, and broader adversarial testing remain for subsequent review stages.
- Local verification on the Windows host: npm run check passed; npm test -- --test-concurrency=1 passed 145, skipped 3, failed 0 (148 total). Runtime was Node v22.23.2, below the supported minimum >=24.15.0; treat this local run as diagnostic only, not supported-runtime verification.
- Exact-head GitHub verification: CI Push and Pull Request each passed 4/4 jobs (Node 24/26 × Linux/Windows); Security Scans Push and Pull Request each passed CodeQL JavaScript analysis and Gitleaks (2/2 jobs each).
- PR #1 remains Open, Draft, and Unmerged. API remains bound to 127.0.0.1. Remote ingress, tunnels, reverse proxies, and port forwarding remain disabled and out of scope. No live .data, ACLs, credentials, or API binding settings were changed during this review checkpoint.
