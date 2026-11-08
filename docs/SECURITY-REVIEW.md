# Internal Security Review Preparation

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


### SEC-001 â€” Untrusted worker-supplied content is copied into audit event data

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
### SEC-002 â€” Host and request-target parsing accepted alternate authority forms

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

### SEC-003 â€” CLI API override could send the Operator token to a remote host

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

CLI API error messages redact the configured Operator token if a server response echoes it. A local fake-server regression test intentionally echoes the Bearer header in a 500 response and verifies the token does not appear in stdout/stderr. Runtime-lock tests prove recovery is refused while the server is active and succeeds after graceful shutdown, with the recovered token accepted on the next startup. Successful participant-registration responses and the explicit rotation command still display their one-time credentials by design; operators must protect terminal output and avoid transcript/log capture.

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
| Dashboard | Operator token is held in page memory; dynamic values use `textContent`; no HTML injection sinks, console logging, or payload/result rendering | Static asset and source regression checks pass; interactive browser testing remains pending |
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

### SEC-004 — URL canonicalization expanded the exact Host allowlist

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
- Supported-runtime CI run `42477292999` passed on Node 24/26 × Linux/Windows.

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
- Supported-runtime CI run `42478010676` passed on Node 24/26 × Linux/Windows.

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
Status: **Remediated with pre-open path checks; local Windows regression suite passed; supported-runtime CI pending**

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
- Supported-runtime CI verification is pending.

Residual risk:
- These are pre-open checks, not an atomic no-follow open. Portable Node `DatabaseSync(path)` cannot bind SQLite to a previously verified file descriptor; a hostile actor able to replace path components between the final check and SQLite open may still redirect the open. Keep the database parent and its ancestors writable only by trusted principals. This does not defend against a same-user process or local administrator. Independent security review remains pending.