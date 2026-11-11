# Optional Third-Party Security Review Handoff

Status: **Optional handoff; no third-party review requested by the project owner**
Review target: the latest PR head at the time the independent review begins. The reviewer must fetch the current head SHA from PR #1 immediately before checkout and record that exact SHA in the report; do not rely on a SHA copied from this document.
Capability-routing implementation commit: `1eaa1c04bb3bb3e3e6737f1ead3dcaf01b98bf03`
The review target is the exact PR-head SHA recorded by the reviewer before testing; it includes all changes present on the branch at that time.
Repository: `ijoolaie/Raya-Control-Center`
Branch: `bootstrap/project-foundation`
PR: [#1](https://github.com/ijoolaie/Raya-Control-Center/pull/1) — keep Open, Draft, Unmerged.
Deployment constraint: loopback-only. No remote ingress, tunnel, reverse proxy, or port-forwarding.

## Purpose

This document is retained only as an optional handoff if the project owner later chooses to request third-party review. The current project process is owner-led AI-assisted review. Internal code inspection, regression tests, browser acceptance, and CI are supporting evidence only; they are not a penetration test, certification, or proof that no vulnerabilities exist. The owner may use this scope as a checklist, but no external reviewer is required.

## Scope

Immediately before testing, fetch PR #1 and record its current `head.sha` as the review target. Check out that exact SHA and confirm `git rev-parse HEAD` matches it. Do not review only the earlier implementation commit; the PR head at review start is authoritative.

In scope:
- HTTP lifecycle, loopback binding, Host/request-target parsing, limits, errors, and authentication timing.
- Operator, Participant, and Lease credentials, rotation, revocation, scopes, and stale-authorization behavior.
- Task state transitions, atomic claim/Lease creation, cancellation, reconciliation, and capability-aware routing.
- SQLite migrations/transactions, audit immutability, runtime and maintenance locks, crash recovery, backup, and restore.
- Dashboard authentication, browser storage, DOM rendering, security headers, and explicit Operator state-changing controls.
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

### Latest PR-head verification - e236c27

- Exact PR head: `e236c2785412a6b5a5d610c8b9a99dbf8ffb6d49` (`Update security review evidence for PR head`). This is a documentation-only synchronization commit; implementation code is unchanged from `bcd5598`.
- The current PR head was fetched from GitHub and confirmed to match local `HEAD` and `origin/bootstrap/project-foundation`.
- Fresh local Windows validation on this checkout: `npm test -- --test-concurrency=1` — 121 passed, 3 skipped, 0 failed (124 total); `npm run check` and `git diff --check` passed. Local Node 22.23.2 remains below the declared Node >=24.15.0 engine.
- CI for exact head `e236c2785412a6b5a5d610c8b9a99dbf8ffb6d49`: [42569062230](https://github.com/ijoolaie/Raya-Control-Center/actions/runs/42569062230) and [42569057493](https://github.com/ijoolaie/Raya-Control-Center/actions/runs/42569057493) both passed the complete Node 24/26 x Linux/Windows matrix (8/8 job executions total).
- These checks are implementation/CI evidence only. Independent security review remains pending and must begin by fetching the then-current PR head SHA.
- PR #1 remains Open, Draft, and Unmerged. API remains loopback-only. No live `.data`, ACLs, credentials, or network binding settings were changed.

### Authoritative review handoff status - PR head 33aada8

This section supersedes all earlier statements in this document that describe `bcd5598` or `e236c27` as the current PR head, or describe CI for `33aada8` as pending.

- Current PR head verified against GitHub and local `HEAD`: `33aada816360b247383c1796a4727a9d2115f9b0`.
- Commit `33aada8` changes documentation only; no application source or tests changed relative to `e236c27`.
- CI for exact current head passed: workflow [42569592118](https://github.com/ijoolaie/Raya-Control-Center/actions/runs/42569592118), all four jobs successful (Node 24/Linux, Node 24/Windows, Node 26/Linux, Node 26/Windows).
- The immediately preceding implementation/test head `bcd5598` passed two complete CI matrices (8/8 jobs total): [42567422511](https://github.com/ijoolaie/Raya-Control-Center/actions/runs/42567422511) and [42567415316](https://github.com/ijoolaie/Raya-Control-Center/actions/runs/42567415316). The documentation-only `e236c27` also passed two complete matrices: [42569062230](https://github.com/ijoolaie/Raya-Control-Center/actions/runs/42569062230) and [42569057493](https://github.com/ijoolaie/Raya-Control-Center/actions/runs/42569057493).
- Local Windows test result on `e236c27`: 121 passed, 3 skipped, 0 failed (124 total); `npm run check` and `git diff --check` passed. Local Node 22.23.2 is below the declared Node >=24.15.0 engine; supported-runtime CI supplies Node 24/26 coverage.
- Worktree was clean at the verified head before this documentation correction. No live `.data`, ACLs, credentials, or API binding settings were changed.
- Review instructions remain unchanged: reviewer must fetch PR #1 immediately before review, record the exact then-current head SHA, check out that SHA, and independently rerun the review. No independent review has yet been performed. CI and implementer-authored tests are not independent verification.
- PR #1 remains Open, Draft, and Unmerged. API remains loopback-only.

### Current verification and review status - 2026-11-09 - df6f9a9

- Exact PR head confirmed from GitHub and local `HEAD`: `df6f9a981e5cba24d8ca3e8697e9abfbd99890c7`.
- Changes since implementation/test commit `bcd559845990479fb33760471f389d0b2b5e0c20` are documentation-only (`docs/INDEPENDENT-SECURITY-REVIEW-HANDOFF.md` and `docs/SECURITY-REVIEW.md`); application source and tests are unchanged.
- Exact-head CI passed twice: [42606770468](https://github.com/ijoolaie/Raya-Control-Center/actions/runs/42606770468) and [42606777734](https://github.com/ijoolaie/Raya-Control-Center/actions/runs/42606777734). Each run passed Node 24/Linux, Node 24/Windows, Node 26/Linux, and Node 26/Windows (8/8 successful job executions total).
- Fresh local validation on this checkout: `npm run check` passed; `npm test -- --test-concurrency=1` reported 121 passed, 3 skipped, 0 failed (124 total); `git diff --check` passed. The local runtime was Node 22.23.2, below the declared Node >=24.15.0 engine. Three platform-specific POSIX tests were skipped on Windows; supported-runtime Linux CI is the relevant platform coverage.
- Implementer source reinspection on this exact checkout revisited HTTP Host/request-target and bearer parsing, post-body Operator authorization, database path checks, SQLite runtime/maintenance lock boundaries, and reference Worker credential stripping. No additional confirmed vulnerability is recorded from this limited pass. This is not a complete adversarial review and is not independent verification.
- `gitleaks`, `semgrep`, `codeql`, `osv-scanner`, and `trivy` are not installed in the local environment; none is claimed to have run. The repository has no `package-lock.json` and declares no external npm dependencies, so an npm audit would not provide a lockfile-backed dependency assessment.
- GitHub reports no requested reviewers, submitted PR reviews, or review comments as of this check. Independent security review remains **pending**; the reviewer must fetch and record the then-current PR head before beginning.
- PR #1 remains Open, Draft, and Unmerged. API remains loopback-only. No `.data`, ACLs, credentials, or network binding settings were changed.

### Automated security workflow first-run evidence - 2026-11-09 - PR head 4242010

- Added `.github/workflows/security.yml`. It runs Gitleaks against full Git history and CodeQL JavaScript/TypeScript analysis on pushes, pull requests, weekly schedule, and manual dispatch. Action dependencies are pinned to release commit SHAs; Gitleaks PR comments and SARIF artifact uploads are disabled.
- Security workflow runs [42608720608](https://github.com/ijoolaie/Raya-Control-Center/actions/runs/42608720608) and [42608727762](https://github.com/ijoolaie/Raya-Control-Center/actions/runs/42608727762) both completed successfully. Gitleaks passed in both runs. CodeQL completed and uploaded its analysis results in both runs; the logged analysis covered 36/36 JavaScript files and 1/1 HTML files.
- The available GitHub connector did not expose the CodeQL alert inventory/count. A successful analysis upload is not evidence of zero alerts. The reviewer/operator must inspect [GitHub Code Scanning](https://github.com/ijoolaie/Raya-Control-Center/security/code-scanning) and triage any reported alerts.
- CI runs [42608720748](https://github.com/ijoolaie/Raya-Control-Center/actions/runs/42608720748) and [42608727733](https://github.com/ijoolaie/Raya-Control-Center/actions/runs/42608727733) both passed the complete Node 24/26 x Linux/Windows matrix (8/8 successful job executions per run).
- These automated checks supplement but do not replace independent security review. No independent reviewer has submitted a report. PR #1 remains Open, Draft, and Unmerged; API remains loopback-only.

### Latest PR CodeQL check result - 2026-11-09 - head 558a783

- GitHub Check Run `CodeQL` for PR #1 on exact head `558a7835b0abac498137d711ac6c87623ff1bb5c` completed successfully with summary: **No new alerts in code changed by this pull request**; annotations count was 0.
- This result applies to newly changed code in PR #1 only. It does not establish that the default branch has no pre-existing open CodeQL alerts. The full branch alert inventory remains to be reviewed in GitHub Security > Code scanning.
- Both CI runs [42608970562](https://github.com/ijoolaie/Raya-Control-Center/actions/runs/42608970562) and [42608964114](https://github.com/ijoolaie/Raya-Control-Center/actions/runs/42608964114) passed all four Node 24/26 x Linux/Windows jobs. Both Security Scans runs [42608970625](https://github.com/ijoolaie/Raya-Control-Center/actions/runs/42608970625) and [42608964174](https://github.com/ijoolaie/Raya-Control-Center/actions/runs/42608964174) completed successfully with Gitleaks and CodeQL jobs successful.
- Independent security review remains pending. The repository commit list currently shows only the project owner as a contributor; no independent reviewer is identified or requested. PR #1 remains Open, Draft, and Unmerged.

### Current independent-review handoff status — 2026-11-11 — 298df35

- Current PR head verified against GitHub, local `HEAD`, and `origin/bootstrap/project-foundation`: `298df35484e9657206ca79ba5b04a629eddaea62`.
- Exact-head CI passed on both push [42897060373](https://github.com/ijoolaie/Raya-Control-Center/actions/runs/42897060373) and pull_request [42897068342](https://github.com/ijoolaie/Raya-Control-Center/actions/runs/42897068342), covering Node 24/26 × Linux/Windows (8/8 successful jobs total).
- Exact-head Security Scans passed on both push [42897060257](https://github.com/ijoolaie/Raya-Control-Center/actions/runs/42897060257) and pull_request [42897068519](https://github.com/ijoolaie/Raya-Control-Center/actions/runs/42897068519); CodeQL and Gitleaks succeeded in both.
- GitHub currently shows no submitted PR reviews or review comments and no independent reviewer identified. The handoff package is prepared, but no independent security review has been performed.
- Reviewer must fetch PR #1 immediately before review, record its then-current head SHA, check out that exact SHA, and independently test the documented scope. Do not rely on the SHA in this note if the PR advances.
- PR #1 remains Open, Draft, and Unmerged. API remains loopback-only. No live `.data`, ACLs, credentials, or API binding settings were changed.
