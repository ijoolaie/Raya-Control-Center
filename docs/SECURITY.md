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
8. **Input validation:** strict JSON object validation, bounded request bodies (16 KiB), bounded task payloads, and parameterized SQL.
9. **Audit:** append-only events for claims, transitions, cancellation, revocation, and reconciliation.
10. **Redaction:** no full prompts, transcripts, hidden reasoning, secrets, raw tool arguments, or file contents in logs/events.
11. **Safe errors:** do not reveal token verifiers, stack traces, SQL details, or internal filesystem paths to clients.
12. **Browser isolation:** no CORS is enabled; Host-header validation rejects DNS-rebinding hostnames.

## Operator and participant separation
Operator actions are distinct from worker actions. A worker cannot register privileged participants, revoke unrelated identities, create tasks, cancel arbitrary tasks, or inspect event history. Worker lifecycle operations require both a participant bearer token and the separate active lease token.

## Remote access
Remote ingress is disabled in MVP. Do not expose the local API through a tunnel, reverse proxy, or port forward. Any future remote mode requires a separate threat-model review, authenticated transport, TLS, credential rotation, replay protection, origin policy, and explicit operator enablement.

## Cancellation and process control
A cancellation request is a coordination signal, not proof that external execution stopped. The API distinguishes requested, acknowledged, and reconciled outcomes.

## Security acceptance tests
- revoked participants cannot authenticate or act;
- insufficient scopes are rejected;
- stale/foreign lease tokens are rejected;
- revoking a participant blocks its active tasks;
- non-loopback Host headers are rejected;
- oversized and malformed request bodies are rejected;
- secrets do not appear in logs or event payloads;
- unauthorized state transitions are rejected.
