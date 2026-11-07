# Security Model

## Threat model
The initial deployment assumes a single trusted machine but does not assume every local process or registered participant is trusted. A compromised participant must not gain operator privileges or mutate tasks it does not own.

## Required controls
1. **Loopback binding:** API listens on 127.0.0.1 only. No wildcard bind.
2. **Host validation:** reject requests whose Host header is not a loopback host.
3. **Scoped credentials:** distinct credentials per participant and purpose; least privilege; revocable.
4. **Credential storage:** store only SHA-256 hashes of high-entropy random tokens. Never log or persist plaintext participant or lease tokens.
5. **Operator separation:** operator token is separate from participant tokens; stored as a hash in the local settings table and shown only at bootstrap/rotation.
6. **Lease enforcement:** every worker mutation checks participant identity, task ownership, active lease status, expiry, and lease token.
7. **Revocation safety:** revoking a participant revokes its active leases and moves affected nonterminal tasks to blocked; uncertain work is not retried automatically.
8. **Input and connection limits:** strict JSON object validation, an 8 KiB header limit, 10-second header receipt timeout (1-second check interval), 30-second request receipt timeout, 16 KiB body limit, bounded task payloads, and parameterized SQL.
9. **Audit:** append-only events for claims, transitions, cancellation, revocation, and reconciliation.
10. **Redaction:** audit events contain bounded operational metadata only; progress text/details, failure reasons, and task results are not copied into the event journal. Callers must still avoid sending secrets in task payloads, progress fields, or results because those operational records are persisted in the Tasks table. No full prompts, transcripts, hidden reasoning, secrets, raw tool arguments, or file contents belong in logs/events. Historical event rows created before this redaction control was introduced are not automatically scrubbed.
11. **Safe errors:** do not reveal token verifiers, stack traces, SQL details, or internal filesystem paths to clients.
12. **Browser isolation:** no CORS is enabled; Host-header validation rejects DNS-rebinding hostnames.
13. **Graceful shutdown:** stop accepting requests, close idle connections, bound active-request drain to 10 seconds, and close SQLite only after HTTP connections are closed.


## Operator and participant separation
Operator actions are distinct from worker actions. A worker cannot register privileged participants, revoke unrelated identities, create tasks, cancel arbitrary tasks, or inspect event history. Worker lifecycle operations require both a participant bearer token and the separate active lease token. The claim operation additionally requires the `tasks:claim` scope.

## Logging policy
The HTTP request handler currently does not emit request logs. Do not add raw request logging. If structured operational logging is introduced later, it must use an explicit allowlist of fields and must never serialize Authorization, X-Lease-Token, request bodies, task payloads/results, or arbitrary error objects. Log event codes and correlation identifiers only where those values are already safe and bounded.

## Remote access
Remote ingress is disabled in MVP. Do not expose the local API through a tunnel, reverse proxy, or port forward. Any future remote mode requires a separate threat-model review, authenticated transport, TLS, credential rotation, replay protection, origin policy, and explicit operator enablement.

## Cancellation and process control
A cancellation request is a coordination signal, not proof that external execution stopped. The API distinguishes requested, acknowledged, and reconciled outcomes.

## Security acceptance tests
- revoked participants cannot authenticate or act;
- operator credentials cannot access participant-only routes;
- participant credentials cannot access operator-only routes;
- participants without `tasks:claim` are rejected;
- stale, missing, or foreign lease tokens are rejected;
- a valid lease holder can perform only its own task lifecycle operations;
- revoking a participant blocks its active tasks;
- non-loopback Host headers are rejected;
- oversized headers are rejected by the HTTP parser;
- oversized, malformed, non-object, and wrong-content-type request bodies are rejected;
- client disconnects during incomplete requests do not cause writes to destroyed responses or crash the server;
- validation errors do not echo credentials or request-body contents;
- API errors do not expose stack traces or internal details;
- event history is append-only.
