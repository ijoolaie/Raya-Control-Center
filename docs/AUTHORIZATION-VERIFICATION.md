# Authorization and HTTP Boundary Verification

Date: 2026-11-06
Branch: bootstrap/project-foundation
Base commit: b40e8440075199e2ee4b2f3d3dca7abf676a679d

## Added automated coverage
- Operator bearer cannot call participant claim route.
- Participant bearer cannot read operator event history or create tasks.
- Participant without `tasks:claim` receives 403 / `insufficient_scope`.
- Participant with the required scope can claim a task.
- Wrong lease token receives 409 / `lease_mismatch`.
- Correct lease token permits the matching participant to start its claimed task.
- Operator bearer cannot use a participant lease on worker lifecycle routes.
- Malformed JSON, array JSON, and unsupported Content-Type are rejected.
- Validation responses do not disclose credential values, request body contents, or stack traces.

## Verification
- `npm test`: 26/26 passing on local Node.js 22.23.2.
- `npm run check`: passed.
- `git diff --check`: passed.
- No request logger is currently installed in the HTTP handler. This is documented as an intentional safe default; structured logging remains deferred until an allowlisted, redacted event schema is designed.

## Scope
This verification is limited to the local HTTP/API authorization boundary and its current validation behavior. It is not a full penetration test, remote-ingress approval, or production security certification.
