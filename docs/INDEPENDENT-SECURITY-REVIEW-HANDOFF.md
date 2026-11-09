# Independent Security Review Handoff

Status: **Prepared; independent review not yet performed**
Review target: the latest PR head at the time the independent review begins. The reviewer must fetch the current head SHA from PR #1 immediately before checkout and record that exact SHA in the report; do not rely on a SHA copied from this document.
Capability-routing implementation commit: `1eaa1c04bb3bb3e3e6737f1ead3dcaf01b98bf03`
The review target is the exact PR-head SHA recorded by the reviewer before testing; it includes all changes present on the branch at that time.
Repository: `ijoolaie/Raya-Control-Center`
Branch: `bootstrap/project-foundation`
PR: [#1](https://github.com/ijoolaie/Raya-Control-Center/pull/1) — keep Open, Draft, Unmerged.
Deployment constraint: loopback-only. No remote ingress, tunnel, reverse proxy, or port-forwarding.

## Purpose

This is a handoff for a reviewer independent of the implementation. Internal code inspection, regression tests, browser acceptance, and CI are supporting evidence only. They are not an independent security review, penetration test, certification, or proof that no vulnerabilities exist. The reviewer must inspect the exact target commit, challenge the threat model, reproduce important claims, and issue their own report.

## Scope

Immediately before testing, fetch PR #1 and record its current `head.sha` as the review target. Check out that exact SHA and confirm `git rev-parse HEAD` matches it. Do not review only the earlier implementation commit; the PR head at review start is authoritative.

In scope:
- HTTP lifecycle, loopback binding, Host/request-target parsing, limits, errors, and authentication timing.
- Operator, Participant, and Lease credentials, rotation, revocation, scopes, and stale-authorization behavior.
- Task state transitions, atomic claim/Lease creation, cancellation, reconciliation, and capability-aware routing.
- SQLite migrations/transactions, audit immutability, runtime and maintenance locks, crash recovery, backup, and restore.
- Dashboard authentication, browser storage, DOM rendering, security headers, and read-only behavior.
- CLI credential handling, URL validation, reference Worker environment isolation, packaging, and operational documentation.
- Capability routing introduced in `1eaa1c04`: Operator-only capability assignment, exact subset matching, legacy empty-requirement behavior, routing summary, and future-claims-only semantics.

Not authorized or in scope for enablement:
- Remote access, public binding, tunnels, reverse proxies, port forwarding, or CORS.
- Treating capability labels as a sandbox or execution authorization system.
- Arbitrary code/general-purpose plugin execution by the reference Worker.
- Changes to Raya-Agent/Raya-MCP, live `.data`, or Windows ACLs.

## Threat model and assumptions to challenge

The initial model is a single trusted machine with potentially untrusted or compromised registered Participants. A Participant must not gain Operator privileges, impersonate another Participant, or mutate Tasks outside its active Lease.

Explicit boundaries:
- API binds to `127.0.0.1`; local processes can generally reach it.
- Same-user processes and local administrators are not reliably isolated by this application. SQLite sidecar locks are cooperative coordination, not a security boundary against them.
- Windows data/backup ACL hardening is opt-in/operator-managed and was not applied to live project data in this work.
- POSIX file modes do not protect against root/equivalent privileges.
- Portable Node SQLite open-by-path cannot atomically bind to a previously verified no-follow file descriptor; path validation/open races remain inside the trusted-directory boundary.
- Restore is point-in-time: older Operator/Participant/Lease credentials may reappear. The post-restore recovery procedure is mandatory before reconnecting Workers.
- Capability metadata is a scheduling filter, not proof of Worker identity, trustworthiness, or safe execution.
- Task payloads, progress data, and results are persisted; clients must not put secrets in them.

The reviewer should identify assumptions that are unstated, unrealistic, or inconsistent with the code.

## Priority review questions

### HTTP and credentials
1. Can alternate Host authorities, absolute/network-path request targets, numeric IP aliases, IPv6 forms, userinfo, encoded delimiters, or parser differentials bypass loopback-only intent?
2. Can a hostile local web page or DNS-rebinding scenario reach authenticated routes despite Host checks and no CORS? Test browser-origin behavior, not only raw HTTP.
3. Are body receipt, aborts, keep-alive, timeouts, concurrent requests, and shutdown bounded and race-safe?
4. Can rotation/revocation race with any body-bearing or asynchronous Operator/Participant operation? Can credentials leak through errors, logs, audit, child-process environments, or browser persistence?
5. Are scopes and active Lease ownership revalidated at every mutation?

### Capability routing
6. Can a Participant alter its own capabilities or Task requirements through any non-Operator route, CLI path, replay, malformed JSON, or migration edge case?
7. Does the SQL subset predicate implement exact AND semantics for empty arrays, duplicates/corrupt values, case, JSON typing, and malformed stored rows?
8. Is Task selection plus Lease assignment and audit atomic under concurrent claimers? Can an incompatible high-priority Task be modified while skipped?
9. Do capability changes affect future claims only, with active Leases still governed by existing Lease rules?
10. Is `unmatchedQueuedTasks` consistent with actual eligibility, including inactive Participants, missing `tasks:claim`, empty requirements, and zero eligible Participants?
11. Can capability arrays or summary queries cause unbounded CPU, memory, SQL work, or response size?
12. Are capabilities ever mistakenly treated as authorization, trust, or permission to execute arbitrary payload content?

### Persistence and recovery
13. Can interrupted/repeated migrations, corruption, symlink/junction/hard-link manipulation, path replacement, concurrent backup/restore, or termination expose data or leave ambiguous state?
14. Are audit events append-only under the stated model, and are secrets/free-form untrusted values excluded from new events?
15. Can restore resurrect credentials/leases in a way the recovery procedure fails to contain?
16. Are backup publication, rollback, staging cleanup, and errors safe on Windows and POSIX?

### Dashboard, CLI, Worker
17. Can untrusted API data reach HTML/script or URL sinks, or unsafe browser storage? Does disconnect clear sensitive state? Verify SEC-AUTO-001 against in-flight refreshes and overlapping sessions, including late success/error responses after Disconnect.
18. Can CLI config, environment variables, error responses, process inheritance, or arguments leak credentials?
19. Does the reference Worker constrain supported types/payloads and fail closed? Is its trust boundary accurately documented?

## Known residual risks to verify

- Same-user/admin processes can inspect or interfere with processes and filesystem state.
- SQLite path validation/open race described above.
- Windows ACL hardening remains an operator action; live `.data` was not changed.
- One-time Operator credentials travel over loopback HTTP and are printed once to terminal; transcript capture and same-user inspection are outside the app boundary.
- Restoring old snapshots can resurrect credentials/leases; perform documented recovery and Participant revocation before reconnecting Workers.
- Task payloads/progress/results are persisted and are not automatically secret-scanned or encrypted at rest.
- Capability matching does not sandbox Workers or validate arbitrary payloads.
- No remote deployment mode has been reviewed or enabled.

These are disclosures, not pre-approved findings. Verify accuracy at the target SHA.

## Reproduction evidence supplied by implementer

From a clean checkout of the exact SHA (Node 24.15+; CI also uses Node 26):

```powershell
node --version
git rev-parse HEAD
npm run check
npm test -- --test-concurrency=1
git diff --check
```

The repository currently has no package-lock.json and declares no external npm dependencies. Do not run `npm ci` for this checkout; there is no lockfile. The test and check commands use Node built-ins.

### Latest PR-head evidence — SEC-AUTO-001

- Fix commit: `99187713115f3d722a02fe5baed0db0cd03eb5ce`.
- Dashboard refreshes capture their session epoch and token; Disconnect invalidates the epoch and aborts the in-flight refresh. Late responses must not mutate tables, metrics, status, errors, or button state. Starting a new session invalidates prior refreshes.
- Regression test: `test/dashboard-session.test.js` starts the four API requests, disconnects, then resolves the mocked requests successfully despite abort; it verifies the disconnected UI remains cleared.
- Local Windows full suite on the current local worktree: 121 passed, 3 skipped, 0 failed (124 total); all three dashboard session regressions, the deterministic in-flight token-rotation regression, `npm run check`, and `git diff --check` passed. Local Node was 22.23.2, below the declared Node >=24.15.0 engine. The expanded test refinements are included in PR head `bcd559845990479fb33760471f389d0b2b5e0c20`; both full supported-runtime CI runs [42567422511](https://github.com/ijoolaie/Raya-Control-Center/actions/runs/42567422511) and [42567415316](https://github.com/ijoolaie/Raya-Control-Center/actions/runs/42567415316) passed all four jobs (Node 24/26 × Linux/Windows), 8/8 total.
- Supported-runtime CI: runs [42499872878](https://github.com/ijoolaie/Raya-Control-Center/actions/runs/42499872878) and [42499868351](https://github.com/ijoolaie/Raya-Control-Center/actions/runs/42499868351) both passed all four jobs: Node 24/Linux, Node 24/Windows, Node 26/Linux, Node 26/Windows.
- Reviewer must independently inspect SEC-AUTO-001 on the exact PR head at review start, including late success and error responses after Disconnect and overlapping sessions. These implementer tests and CI are evidence, not independent verification.

Recorded implementation evidence for commit `1eaa1c04bb3bb3e3e6737f1ead3dcaf01b98bf03` (the capability-routing code commit):
- Windows local suite: 118 passed, 3 skipped, 0 failed (121 total).
- `npm run check` and `git diff --check`: passed.
- The documentation handoff commit `7856ae84819f237f78dbdb90eff5f937eda43346` passed all four Node 24/26 × Linux/Windows jobs in workflow run `42493528396`. The subsequent target-correction commit `b4ca0a8863a8ac759eea87fa62f9a91f986075d2` passed all four jobs in workflow run `42494034252`.
- Isolated Chrome 157 acceptance: valid/invalid Operator auth, routing metrics, capability columns, filters, 390px layout, disconnect clearing, and empty local/session storage passed. This was functional DOM/layout acceptance, not pixel-level visual review.

The Chrome acceptance and 118/3 test counts are author-provided evidence for implementation commit `1eaa1c04`; later commits update review-handoff documentation only. These are not independent results. The reviewer must fetch and check out the exact PR head at review start, rerun it, and record that SHA and independent results in the report. Three Windows skips are POSIX-specific permission/fsync tests; Linux CI exercises platform-specific cases.

## Suggested artifacts

Inspect at minimum:
- `src/http-server.js`, `src/control-center.js`, `src/db.js`, `src/operator-auth.js`
- `src/database-runtime-lock.js`, `src/database-maintenance.js`
- `src/db-backup.js`, `src/db-restore.js`, `src/db-restore-inspect.js`, `src/restore-recovery-state.js`
- `src/cli.js`, `src/server.js`, `src/server-runtime.js`
- `examples/reference-worker/worker.mjs`, `examples/reference-worker/environment.mjs`
- `dashboard/dashboard.js` and dashboard HTML/CSS
- relevant `test/` files
- `docs/SECURITY.md`, `docs/SECURITY-REVIEW.md`, `docs/API-CONTRACT.md`, `docs/ARCHITECTURE.md`, `docs/TASK-ROUTING-DESIGN.md`

Do not rely only on tests/checklists; trace trust boundaries and data flows end to end.

## Required reviewer report

For each finding: unique ID/title, severity and rationale, exact SHA and file/line, preconditions/attacker capability, safe local reproduction, impact/exploitability, remediation, and regression-test recommendation.

Also record reviewer identity/independence, date, exact SHA, OS/Node/tools/commands, scope/exclusions, inspected and uninspected areas, findings by severity (including no findings if applicable without claiming proof of absence), retest status, residual risk, and deployment recommendation.

## Guardrails

- PR #1 stays **Open, Draft, and Unmerged** until separately authorized.
- This handoff does not authorize merging, changing Draft state, remote exposure, or modifying other repositories.
- Never include tokens, database contents, user data, or private logs in the package.
- Use disposable isolated databases/directories; do not run destructive review tests against live `.data`.
- Independent security review remains pending. This document is not a completed review or certification.

### Expanded SEC-AUTO-001 regression evidence - current PR head bcd5598

- Exact tested commit: `bcd559845990479fb33760471f389d0b2b5e0c20` (current PR head at the time this evidence was recorded).
- Dashboard session regressions cover late successful responses after Disconnect, late API errors after Disconnect, and an older session attempting to overwrite a newer session.
- The in-flight token-rotation regression now enforces ordering explicitly: keep the old request body open, complete token rotation, then send the remaining body and assert the old request is rejected. This avoids reliance on competing timers.
- Local Windows suite: 121 passed, 3 skipped, 0 failed (124 total); `npm run check` and `git diff --check` passed. Local Node 22.23.2 is below the declared Node >=24.15.0 engine.
- CI run [42567422511](https://github.com/ijoolaie/Raya-Control-Center/actions/runs/42567422511) passed Node 24/Linux, Node 24/Windows, Node 26/Linux, and Node 26/Windows.
- Duplicate CI run [42567415316](https://github.com/ijoolaie/Raya-Control-Center/actions/runs/42567415316) passed the same four jobs. Total: 8/8 successful job executions across both runs.
- Reviewer must still independently inspect the exact PR head at review start and reproduce these cases. These tests and CI are implementer evidence, not independent verification.
