# Independent Security Review Handoff

Status: **Prepared; independent review not yet performed**
Target commit: `1eaa1c04bb3bb3e3e6737f1ead3dcaf01b98bf03`
Repository: `ijoolaie/Raya-Control-Center`
Branch: `bootstrap/project-foundation`
PR: [#1](https://github.com/ijoolaie/Raya-Control-Center/pull/1) — keep Open, Draft, Unmerged.
Deployment constraint: loopback-only. No remote ingress, tunnel, reverse proxy, or port-forwarding.

## Purpose

This is a handoff for a reviewer independent of the implementation. Internal code inspection, regression tests, browser acceptance, and CI are supporting evidence only. They are not an independent security review, penetration test, certification, or proof that no vulnerabilities exist. The reviewer must inspect the exact target commit, challenge the threat model, reproduce important claims, and issue their own report.

## Scope

Review the exact SHA above unless a later SHA is explicitly agreed. Confirm `git rev-parse HEAD` before testing.

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
17. Can untrusted API data reach HTML/script or URL sinks, or unsafe browser storage? Does disconnect clear sensitive state?
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
npm ci
npm run check
npm test -- --test-concurrency=1
git diff --check
```

Recorded evidence for the target commit:
- Windows local suite: 118 passed, 3 skipped, 0 failed (121 total).
- `npm run check` and `git diff --check`: passed.
- GitHub Actions Node 24/26 on Linux/Windows: all four matrix combinations passed.
- Isolated Chrome 157 acceptance: valid/invalid Operator auth, routing metrics, capability columns, filters, 390px layout, disconnect clearing, and empty local/session storage passed. This was functional DOM/layout acceptance, not pixel-level visual review.

These are author-provided results. The reviewer must rerun and record independent results. Three Windows skips are POSIX-specific permission/fsync tests; Linux CI exercises platform-specific cases.

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
