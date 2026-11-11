# Task Routing and Worker Capabilities - Approved Design

Status: approved, implemented, and committed on `bootstrap/project-foundation`. Capability routing, the Operator editor, active-Lease preservation, and isolated Chrome acceptance are recorded in `docs/ROADMAP.md` and `docs/SECURITY-REVIEW.md`. A focused owner-led AI-assisted security review checkpoint is recorded in the security register (2026-11-11).
Scope: Raya Control Center repository only. This design does not authorize changes to Raya-Agent or Raya-MCP.

## 1. Original problem statement

Before capability-aware routing was implemented, the claim operation selected the highest-priority oldest queued Task without considering the claiming Participant's `kind` or capabilities. Every active Participant with `tasks:claim` competed for the same queue. This was a routing/compatibility limitation, not an authorization bypass. The consuming Worker must still validate Task type and payload before execution.

## 2. Goals

- Prevent a Worker from claiming work it has not been provisioned to handle.
- Preserve the existing atomic claim, Lease, and append-only audit guarantees.
- Keep the model small: no broker, scheduler service, plugin registry, or distributed dependency.
- Keep authorization and scheduling separate.
- Preserve existing clients and databases by defaulting legacy records to unrestricted/empty capability requirements.
- Keep task type and payload validation at the Worker execution boundary.

## 3. Approved model

Use explicit capability labels, independent of `kind` and `scopes`:

- Participant `capabilities`: operator-provisioned labels describing work this Participant may claim, for example `content.write`, `image.generate`, `shopify.catalog.read`, `browser.navigate`.
- Task `requiredCapabilities`: labels that must all be present on a Participant for it to claim the Task.

Matching rule: a Participant is eligible only when its capability set is a superset of the Task's required capability set. Matching is exact and case-sensitive after validation/normalization. No wildcard or prefix matching in the first version.

Examples:

| Participant capabilities | Task required capabilities | Eligible |
|---|---|---|
| `[]` | `[]` | Yes |
| `[]` | `[content.write]` | No |
| `[content.write, browser.navigate]` | `[content.write]` | Yes |
| `[content.write]` | `[content.write, image.generate]` | No |

An empty `requiredCapabilities` list means any active Participant with `tasks:claim` may claim the Task. This preserves legacy behavior and makes unrestricted work explicit by default. New integrations should set requirements for work that must be routed.

## 4. Security and trust boundaries

- Only the Operator may assign or change Participant capabilities and Task requirements.
- A Participant must never be able to add capabilities to itself or alter a Task's requirements.
- `capabilities` are scheduling declarations, not authorization scopes and not proof that a Worker is safe or trustworthy.
- `tasks:claim` remains mandatory. A matching capability never grants Operator access or bypasses Lease ownership.
- The Worker must continue validating the Task type and payload against its own allowlist/schema. Capability matching is not permission to execute arbitrary commands, code, URLs, or tool names from payloads.
- Changing a Participant's capabilities affects future claims only. Existing active Leases remain bound to their original Participant and follow current Lease rules; capability changes must not silently reassign or revoke in-flight work.

## 5. Data/API shape

Participant registration (Operator-only) gains optional `capabilities: string[]`, default `[]`.

Task creation (Operator-only) gains optional `requiredCapabilities: string[]`, default `[]`.

Participant and Task read/list responses expose these arrays. The claim endpoint request remains unchanged; the Control Center derives eligibility from the authenticated Participant record rather than trusting client-supplied capability claims.

Implemented validation mirrors the existing bounded identifier style: arrays only, bounded item count, unique values, non-empty strings, restricted ASCII identifiers such as `^[a-z][a-z0-9:._-]{0,79}$`. Set conservative maximums (64 capabilities per Participant and 32 required capabilities per Task) and bound serialized storage.

## 6. Storage and migration

Additive SQLite migration only. Add `capabilities_json TEXT NOT NULL DEFAULT '[]'` to `participants` and `required_capabilities_json TEXT NOT NULL DEFAULT '[]'` to `tasks`. Existing rows therefore retain today's behavior. No credential, Lease, event, or existing Task state migration is required.

The claim transaction must select the highest-priority oldest queued Task whose complete required-capability set is contained in the authenticated Participant's stored capability set. It must skip incompatible queued Tasks without changing their status, timestamps, or audit history. The existing transaction still creates the Lease, assigns the Task, and appends `task.claimed` atomically.

Implementation uses SQLite json_each for exact subset matching inside the existing atomic claim query. The bundled runtime has been exercised by the automated routing tests. Add an index only if measured query plans or realistic queue tests justify it.

## 7. Unmatched work behavior

If no queued Task matches, return the existing empty-claim result (`claim: null`). Do not fail, block, or rewrite unmatched Tasks. They remain queued until a compatible Participant appears or an Operator changes/cancels them. The read-only Dashboard now displays the exact global unmatched-queued count and active claim-capable Participant count through an Operator-only summary endpoint. It also displays Task requirements and Participant capabilities. A per-Task explanation of which capability is missing remains deferred.

## 8. Audit and operational behavior

- Include capability declarations/requirements in the relevant Operator-visible records.
- Capability updates use the implemented Operator-only endpoint and are recorded as append-only `participant.capabilities_updated` events.
- Do not put secrets or credentials in capability labels.
- Do not add verbose per-poll "no matching task" audit events; this would create unbounded noise.
- Preserve deterministic priority ordering among Tasks eligible for the same Participant.

## 9. Original implementation and rollout sequence (completed)

1. Additive migration with empty-array defaults; old databases upgrade and reopen correctly.
2. Operator registration/task creation accept optional arrays; old clients may omit them and retain legacy behavior.
3. Read models and API contract tests cover the capability fields.
4. Capability-aware claim selection runs inside the existing transaction.
5. Tests cover empty requirements, exact matching, multiple required capabilities (AND semantics), incompatible high-priority Task skipping, differently capable Participants competing, revocation/Lease invariants, and legacy rows.
6. Reference-worker examples and docs demonstrate an explicitly provisioned capability without changing the execution allowlist.

No remote exposure, external broker, automatic retry, or changes to other repositories are part of this proposal.

## 10. Deferred decisions and approved choices

- Approved: Participant capabilities are Operator-editable through the dedicated audited endpoint. Changes affect future claims only.
- Deferred: a per-Task explanation identifying which capability prevents a queued Task from matching. The current Dashboard provides aggregate unmatched counts, not per-Task diagnostics.
- Whether any existing Task types should receive default requirements. Recommendation: no implicit mapping in the first migration; preserve existing tasks as unrestricted and have Operators opt in explicitly.

## 11. Non-goals

- Capability labels are not a sandbox, trust score, or fine-grained lifecycle authorization system.
- No automatic capability inference from Participant `kind`, tool names, model names, or Task payload.
- No wildcard matching, priority aging, fairness scheduler, retry policy, or distributed queue.
- No changes to Raya-Agent or Raya-MCP repositories.
