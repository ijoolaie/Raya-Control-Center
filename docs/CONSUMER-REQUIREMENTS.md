# Consumer Integration Requirements v1

Status: requirements baseline; no external consumer implementation is authorized by this document.
Scope: Raya Control Center repository only. Raya-Agent and Raya-MCP remain separate future consumers.

## 1. Authority and trust boundaries

Raya Control Center (the Raya Control Plane subsystem) is the sole authority for Participant identity, credential verifiers, Task state, assignment, Lease state, cancellation state, and the append-only event journal.

Consumers MUST:
- Treat Control Center responses as authoritative; local queue views and cached Task state are advisory only.
- Never write directly to the Control Center SQLite database.
- Never invent or reuse Participant IDs, Lease IDs, or credentials.
- Never treat a timeout, process crash, or lost HTTP response as proof that an operation did or did not commit.
- Keep credentials out of URLs, Task payloads/results, progress details, events, logs, prompts, and model-visible output.
- Stop Task mutations immediately after lease loss, expiry, revocation, or a `409 lease_mismatch`.
- Use the loopback API only. Remote access, tunnels, reverse proxies, and multi-machine use are out of scope until a separate transport/security decision is approved.

The current API binds to loopback and is not a remote-access security boundary. Do not expose it by changing the bind address or forwarding its port.

## 2. Current authorization facts (normative)

The implemented API currently has two distinct credential classes:
- Operator Bearer: management and control-plane operations.
- Participant Bearer plus a separate `X-Lease-Token`: worker operations bound to one active lease.

Current route boundary:
| Operation | Required credential |
|---|---|
| Register/revoke/list/read Participants | Operator Bearer |
| Create/read/list Tasks | Operator Bearer |
| Request Task cancellation | Operator Bearer |
| Read event history and reconcile expired leases | Operator Bearer |
| Claim a Task | Participant Bearer with `tasks:claim` |
| Start, heartbeat, progress, complete, fail, acknowledge cancellation | Participant Bearer plus matching active Lease token |
| Read own lease/cancellation status | Participant Bearer plus matching active Lease token |

Important implementation limitations:
- Participant `kind` (`worker`, `adapter`, `operator_client`) is descriptive metadata, not an authorization policy or task-routing filter.
- Claim selection takes the highest-priority oldest queued Task whose `requiredCapabilities` are all present in the authenticated Participant's stored capabilities. Empty requirements preserve legacy behavior: any active Participant with `tasks:claim` may claim the Task. Participant `kind` remains descriptive and is not a routing filter.
- The Control Center maintains bounded Participant capability metadata and Task required-capability metadata for scheduling. This does not replace Worker-side validation: each Worker must still validate Task type and payload against its own allowlist/schema; unsupported work must fail safely and must never be executed.
- The only currently enforced Participant scope is `tasks:claim`, checked when claiming.
- Other worker lifecycle actions are protected by Participant authentication and matching active Lease ownership, not by separate per-action scopes.
- Arbitrary scope strings may be stored, but an unrecognized scope grants no implemented capability.
- A Participant credential never grants Operator endpoints, regardless of its kind or scope list.
- Do not describe the current implementation as having fine-grained scopes such as `tasks:complete`, `tasks:cancel`, or `events:read`; those policies do not yet exist.

Any future introduction of per-action scopes MUST include route-level enforcement, a documented scope-to-route matrix, negative authorization tests, and a migration/compatibility decision before consumers rely on it.

## 3. Raya-Agent worker requirements

A future Raya-Agent worker SHOULD be provisioned as a dedicated Participant:
- `kind: worker`
- Minimum current scope: `tasks:claim`
- One Participant identity per independently revocable worker instance or security boundary; do not share a token across unrelated hosts/processes.
- Participant token stored in the worker host's protected secret configuration and never placed in source control or task data.

Required worker sequence:
1. Receive a provisioned Participant token from an operator-controlled setup step.
2. Claim using `POST /control/v1/tasks/claim`.
3. If no Task is available, back off with bounded jitter; do not spin or infer work from local caches.
4. Keep the Lease token in memory for the active Lease lifetime; do not persist it in ordinary files or logs.
5. Start the claimed Task, then perform only the work described by the validated Task type and payload.
6. Send progress only when useful; progress does not extend the Lease.
7. Heartbeat before Lease expiry while work remains active. The worker must account for network delay and must not assume a heartbeat succeeded without its response.
8. Poll lease status for cooperative cancellation at a bounded interval appropriate to the work.
9. On cancellation, stop safely and acknowledge only after the worker has stopped its own work. Acknowledgement does not roll back external side effects.
10. Complete or fail with bounded, non-secret result/diagnostic data.
11. Discard the Lease token after terminal completion, failure, cancellation, or lease loss.

Worker safety requirements:
- Validate Task type and payload against a worker-owned allowlist/schema before execution.
- Never execute arbitrary shell commands, code, URLs, or tool names solely because they appear in a Task payload.
- Treat payloads, results, and external content as untrusted data.
- Make external side effects idempotent where possible and persist a worker-side operation key when needed.
- Do not automatically re-run uncertain non-idempotent work after a crash or expired Lease. Leave recovery to an explicit operator decision.
- A worker must not call Operator endpoints or receive the Operator token.

## 4. Raya-MCP adapter requirements

A future Raya-MCP integration MUST be an explicit adapter, not a transparent proxy to the entire Control Center API.

Two distinct modes must not be conflated:

### 4.1 Control-plane tool adapter

This mode exposes a small allowlisted set of operator-approved actions to an MCP client. Examples may include creating a Task, reading bounded Task metadata, requesting cancellation, or reading selected operational status.

Requirements:
- The Operator token remains server-side in the trusted adapter process; it MUST NOT be returned to an MCP client, model, tool result, prompt, or log.
- The adapter MUST implement an explicit tool allowlist with per-tool input schemas, size limits, and output redaction.
- No arbitrary HTTP path, method, header, SQL, filesystem path, or raw API passthrough tool may be exposed.
- Read operations and state-changing operations must be distinguishable in tool metadata and authorization policy.
- Task creation must use a stable idempotency key across retries of the same logical request.
- Cancellation is a request, not proof that a worker has stopped.
- Tool results MUST contain only the minimum data needed by the caller. Do not expose Participant tokens, Lease tokens, Operator credentials, raw database rows, or unrestricted event data.
- Calls must be explicitly initiated and observable. The adapter must not infer or submit hidden reasoning, unseen tool activity, or actions from unrelated conversations.

### 4.2 Participant-side adapter/worker

If an adapter itself claims and executes Tasks, it MUST use a separately provisioned Participant identity and the worker lifecycle rules in section 3. It must not reuse the Operator credential as a Participant credential or share another worker's Lease token.

The same process may not silently combine the two modes. If both are ever required, they need separate credential stores, explicit internal boundaries, and independent authorization tests.

## 5. Retry, idempotency, and recovery

- Task creation: retry only with the same idempotency key and byte-equivalent logical input (same type, canonical payload, and priority).
- Claim/start/heartbeat/progress/complete/fail/cancel-ack: after an ambiguous transport failure, inspect authoritative state or allow Lease reconciliation; do not blindly replay.
- Operator cancellation request and Participant revocation are idempotent under the current API contract.
- Expired or revoked Leases block affected Tasks. The system intentionally does not automatically retry uncertain external work.
- Consumers must distinguish HTTP failure from operation outcome unknown when the connection is lost after request transmission.

## 6. Transport and client behavior

- Current supported endpoint: `http://127.0.0.1:4317/control/v1` (port configurable for local development).
- Current API is loopback-only; no TLS is used on this local transport.
- Clients must enforce bounded connect/request timeouts and bounded response sizes.
- Clients must validate HTTP status and stable `error.code`; they must not parse human-readable messages for control flow.
- Clients must reject unexpected content types and malformed JSON.
- Clients must not automatically follow redirects while sending credentials.
- A client must not log Authorization or `X-Lease-Token` headers.
- No remote or cross-host deployment is supported by this contract.

## 7. Acceptance tests required before a consumer is called integrated

A future consumer integration is not complete until tests demonstrate:
- Dedicated identity provisioning and revocation.
- Operator/Participant credential separation.
- Minimum-scope enforcement and Lease ownership.
- Empty queue, successful claim, and competing claim behavior.
- Heartbeat expiry, lost response, and stale Lease handling.
- Cooperative cancellation and worker acknowledgement.
- Idempotent Task creation across retry.
- Process restart and uncertain non-idempotent work recovery without blind replay.
- Secret redaction from logs, errors, and tool outputs.
- Task-type/payload allowlisting at the execution boundary.
- For MCP: tool allowlist, schema validation, read/write separation, Operator-token isolation, and no arbitrary API passthrough.

## 8. Explicit non-goals

This requirements baseline does not implement or authorize:
- Changes to the Raya-Agent or Raya-MCP repositories.
- Remote access, HTTPS ingress, tunnels, or public binding.
- A dashboard, general-purpose job runner, shell executor, or arbitrary MCP proxy.
- Fine-grained Participant scopes not enforced by the current API.
- Automatic retry of uncertain non-idempotent operations.
- Access to hidden reasoning, unrelated conversations, or unsubmitted actions.
