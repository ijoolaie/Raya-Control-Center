# Security Model

## Threat model
The initial deployment assumes a single trusted machine but does not assume every local process or registered participant is trusted. A compromised participant must not gain operator privileges or mutate tasks it does not own.

## Required controls
1. **Loopback binding:** API listens on 127.0.0.1 and/or ::1 only by default. No wildcard bind.
2. **Scoped credentials:** distinct credentials per participant and purpose; least privilege; revocable.
3. **Credential storage:** store only a suitable verifier/hash. Never log or persist plaintext participant or lease tokens.
4. **Lease enforcement:** every worker mutation checks participant identity, task ownership, and current lease.
5. **Input validation:** strict schemas, bounded payload sizes, allowlisted task types, safe serialization.
6. **Audit:** append-only events for authentication failures, authorization decisions, claims, renewals, transitions, cancellation, revocation, and operator actions.
7. **Redaction:** no full prompts, transcripts, hidden reasoning, secrets, raw tool arguments, or file contents in logs/events.
8. **Filesystem:** database and credential material use restrictive local permissions; backups are protected.
9. **Safe errors:** do not reveal token verifiers, stack traces, SQL details, or internal filesystem paths to clients.
10. **Dependency hygiene:** supported/pinned dependencies, automated audit, minimal dependency surface.

## Operator and participant separation
Operator actions are distinct from worker actions. A worker must not be able to register privileged participants, revoke unrelated identities, change global policy, or inspect sensitive audit data unless explicitly granted a scope.

## Remote access
Remote ingress is disabled in MVP. Any future remote mode requires a separate threat-model review, authenticated transport, TLS, credential rotation, replay protection, origin policy, and explicit operator enablement.

## Cancellation and process control
A cancellation request is a coordination signal, not proof that external execution stopped. The UI/API must distinguish requested, acknowledged, and reconciled outcomes.

## Security acceptance tests
- revoked/disabled participants cannot authenticate or act;
- insufficient scopes are rejected;
- stale/foreign lease tokens are rejected;
- secrets do not appear in logs or event payloads;
- non-loopback bind configuration is rejected unless a future remote mode is explicitly enabled;
- unauthorized state transitions are rejected.
