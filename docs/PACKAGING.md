# Packaging and runtime policy

## Distribution decision

Raya Control Center is a private, local-first application, not a public npm library. The package manifest keeps `"private": true` so `npm publish` is rejected. `npm pack` is used only to inspect or produce an internal source bundle; it is not a supported public release channel.

The manifest's `files` allowlist includes only runtime source, dashboard assets, the reference worker, documentation, and the README. Tests, test-support utilities, GitHub workflows, local data, SQLite databases, backups, environment files, and generated coverage are excluded.

## Package verification

From the repository root:

```powershell
npm pack --dry-run --json
```

Verify that the file list contains `src/`, `dashboard/`, `examples/reference-worker/`, and `docs/`, and does not contain `test/`, `test-support/`, `.data/`, `.env`, or any SQLite database/backup.

The runtime has no third-party npm dependencies. The application uses Node built-ins, including `node:sqlite`.

## Runtime support

- Minimum declared runtime: Node.js 24.15.0.
- Preferred runtime: Node.js 26 Active LTS.
- CI currently validates Node 24 and Node 26 on Windows.
- Node 24.15+ exposes built-in SQLite as a Release Candidate API; the project accepts this for the MVP and must reassess before 1.0.
- Do not claim macOS or Linux operational validation until those platforms are added to CI and exercised.

## Local deployment constraints

- Run from the extracted application root so the relative default database path `.data/control-center.sqlite` remains predictable.
- Keep the database, WAL sidecars, backups, and Operator token outside source control and package artifacts.
- The HTTP server must remain bound to loopback. Packaging does not authorize reverse proxies, tunnels, port forwarding, or remote exposure.
- The dashboard is served from package-relative files under `dashboard/`; those files are required at runtime.
- No native compilation or install scripts are required.

## Release gate

Before creating a versioned internal bundle:
1. Run `npm test`, `npm run check`, and `git diff --check`.
2. Run `npm pack --dry-run --json` and inspect the allowlisted contents.
3. Verify Node 24 and Node 26 CI jobs.
4. Perform an isolated startup smoke test using a temporary database and disposable Operator token.
5. Keep `private: true` unless a separate product/security decision explicitly authorizes public distribution.
