# Raya Control Center Reference Worker

A small, independently runnable Participant worker for validating the v1 HTTP integration contract. It is intentionally limited to two harmless task types and never executes shell commands, scripts, prompts, or arbitrary code from task payloads.

## Requirements

- Node.js 24.15.0 or newer (Node.js 26 is preferred).
- A running Raya Control Center API reachable at its loopback URL.
- A Participant registered with the `tasks:claim` scope.

## Register a worker

From the repository root, with the API running and your Operator token available:

```powershell
$env:RAYA_CC_OPERATOR_TOKEN = "<operator-token>"
npm run cli -- participant register --name "reference-worker" --kind worker --scope tasks:claim
```

Save the returned Participant token securely. It is displayed only once. Do not put it in source files, command history, screenshots, or logs.

## Create a harmless demo task

```powershell
npm run cli -- task create --type demo.echo --payload '{"value":"hello from Raya"}'
```

The only supported task types are:

- `demo.echo`: returns the payload's `value` field as data; it does not interpret it.
- `demo.delay`: waits for `durationMs` (integer 0..5000), polling cancellation and renewing its lease while it waits.

Unknown task types fail safely. Task payloads are never treated as instructions or executable content.

## Run

```powershell
$env:RAYA_CC_URL = "http://127.0.0.1:4317/control/v1"
$env:RAYA_CC_PARTICIPANT_TOKEN = "<participant-token>"
# Remove the Operator token from this shell before starting the lower-trust Worker.
Remove-Item Env:RAYA_CC_OPERATOR_TOKEN -ErrorAction SilentlyContinue
node examples/reference-worker/worker.mjs
```

Optional environment variables:

| Variable | Default | Bounds / meaning |
|---|---:|---|
| `RAYA_CC_URL` | `http://127.0.0.1:4317/control/v1` | API base URL |
| `RAYA_CC_PARTICIPANT_TOKEN` | required | Participant Bearer token; never logged |
| `RAYA_CC_POLL_MS` | `1000` | Empty-queue polling interval, 100..60000 ms |
| `RAYA_CC_LEASE_MS` | `30000` | Lease duration, 3000..3600000 ms |
| `RAYA_CC_MAX_TASKS` | unlimited | Optional positive integer; useful for one-shot runs |

The worker uses only the Participant token and per-task X-Lease-Token. At startup it removes an inherited RAYA_CC_OPERATOR_TOKEN from its own environment. Also remove the Operator token from the launching PowerShell environment before starting the Worker; this defense-in-depth step does not protect against privileged launch-time hooks such as injected Node preload modules or a compromised same-user process. The worker cannot register participants or create tasks.

## Lifecycle and failure policy

1. Claim one task; an empty queue is normal.
2. Start the task using the returned lease.
3. For `demo.delay`, poll lease status for cooperative cancellation and renew the lease periodically.
4. Report progress, then complete; acknowledge cancellation when requested.
5. If the lease is stale, stop mutating the task.
6. If a mutation's network outcome is ambiguous, do not replay it. The worker abandons that task; Control Center lease reconciliation blocks uncertain work instead of blindly retrying it.
7. SIGINT/SIGTERM stops new claims. An in-flight task is not falsely marked successful; its lease is left for normal expiry/reconciliation unless cancellation was requested.

The worker intentionally does not auto-retry a failed claim request because the server may have committed a claim before the response was lost.
