# Development guide

## Supported local environment

- Windows is the currently exercised development and CI platform.
- Node.js 24.15.0 or newer is required; Node.js 26 Active LTS is preferred.
- npm 10 or newer.
- Git.
- No third-party runtime npm dependencies are currently required. The application uses Node built-ins, including `node:sqlite`.

Do not treat a successful run on an older local Node version as supported-runtime evidence. The CI matrix on Node 24 and Node 26 is authoritative for those runtime versions.

## Checkout and install

```powershell
git clone https://github.com/ijoolaie/Raya-Control-Center.git
Set-Location Raya-Control-Center
git switch bootstrap/project-foundation
node --version
npm --version
npm install
```

The project is private (`private: true`). Do not publish it to npm. Work only in this repository for Control Center changes. Raya-Agent and Raya-MCP are consumers/adapters and are outside this repository's implementation scope.

## Validate changes

Run the complete local validation before committing:

```powershell
npm test
npm run check
git diff --check
```

The test suite includes SQLite, HTTP protocol, authorization, worker-process, backup/restore, crash-boundary, and Windows ACL-helper coverage. Tests use disposable temporary directories and databases. Do not point tests at `.data` or any real application database.

CI currently runs the syntax check, complete test suite, and Windows data ACL helper test on Node 24 and Node 26. Do not claim a platform/runtime as verified unless it has actually been exercised.

## Run locally

Use an isolated database path for development and smoke tests:

```powershell
$env:RAYA_CC_DATABASE = Join-Path $env:TEMP 'raya-control-center-dev.sqlite'
$env:RAYA_CC_PORT = '14317'
```

On first start, the application generates an Operator token and prints it once. Save it in a password manager; never commit it, paste it into chat, or capture it in logs. For later starts, provide the saved token through the environment without writing it into source files:

```powershell
$env:RAYA_CC_OPERATOR_TOKEN = '<saved-token>'
npm start
```

The server must remain bound to `127.0.0.1`. Verify health locally at `http://127.0.0.1:14317/control/v1/health`. Do not use tunnels, reverse proxies, port forwarding, wildcard binds, or remote ingress.

For operational use, token rotation, database maintenance, dashboard access, and crash recovery, follow [OPERATIONS.md](./OPERATIONS.md). For API details, use [API-CONTRACT.md](./API-CONTRACT.md) and [INTEGRATION-CONTRACT.md](./INTEGRATION-CONTRACT.md).

## Change and evidence discipline

- Keep implementation, tests, and documentation in the authorized Control Center repository.
- Preserve the loopback-only boundary and separate Operator, Participant, and Lease credentials.
- Do not add arbitrary shell/code execution to the Reference Worker; extend its explicit task allowlist only with reviewed handlers.
- Do not infer that a lock is stale from its presence or absence; verify process ownership and database users before manual recovery.
- Do not add automatic Restore recovery or delete rollback artifacts without a separately reviewed protocol.
- Keep secrets, `.data`, SQLite files, backups, environment files, and generated artifacts out of commits.
- Do not modify actual `.data` permissions or apply the ACL helper without explicit operator approval.
- Report each result as documented, implemented, tested, or operational. CI evidence and local test evidence must be stated separately.
- The independent security review remains a release gate. Internal tests or implementation review do not satisfy that independent-review requirement.

## Internal bundle check

The package is an internal source bundle, not a public npm release. Before preparing one:

```powershell
npm pack --dry-run --json
```

Confirm the allowlist contains runtime source, dashboard, worker example, documentation, scripts, and README only. Confirm tests, test-support, local data, databases, backups, and environment files are excluded. Follow [PACKAGING.md](./PACKAGING.md) for the internal packaging policy and release gates.
