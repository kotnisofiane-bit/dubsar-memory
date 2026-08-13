# Review and Challenge Protocol

Use this protocol only when a decision is material: it changes the approved
outcome or acceptance criteria, architecture or system boundaries, public APIs
or data models, trust or security boundaries, dependencies, migration,
deployment or recovery, sensitive external effects, or another direction that
would be costly to reverse.

## Goal lock

Before selecting a reviewer, freeze a short checkpoint containing:

- the user's outcome and the current requested phase;
- the next visible output and whether it will be usable by the user;
- the approved scope, threat model, supported environment, and acceptance
  criteria;
- the canonical root or exact artifact digest being reviewed;
- the authority requested from the human and the review budget.

Any expansion, narrowing, or substitution of those fields invalidates the
checkpoint and requires explicit human reframing. A reviewer finding that shows
the checkpoint itself is materially incomplete or unsafe is a `goal-lock
defect`: stop and request reframing rather than dismissing the finding as out of
scope.

## Proportionality and finding disposition

A severity label alone never blocks the current goal. A finding is a current
blocker only when evidence shows that it applies to the frozen scope, threat
model, environment, or acceptance criteria and that it either violates an
accepted condition or creates material harm that a cheaper bounded response
cannot contain.

Classify every material finding as exactly one of:

- `current-blocker`: applicable and incompatible with the current acceptance;
- `proposed-limitation`: acceptance still holds under a narrower, explicitly
  disclosed boundary that requires human confirmation;
- `deferred-candidate`: useful later but not required by the current outcome;
- `unsupported`: not established by the cited evidence.

Before proposing a new architecture, try the least expansive valid response:
bound the environment, disclose a limitation, apply a small mitigation, or
defer a candidate. Never initialize another mission, case, lot, contract,
review wave, backend, MCP, or native component merely because a reviewer named
one. If a limitation would make the visible result unusable or break an
acceptance criterion, it does not close the finding.

## Sequence

1. The principal agent inspects the canonical JSON and cited evidence and
   records its own provisional position.
2. It selects the smallest relevant read-only reviewer set, one by default and
   at most three only for genuinely cross-cutting current-scope risk:
   - product for user value, journey, requirements, and acceptance criteria;
   - architecture for boundaries, data models, APIs, dependencies, deployment,
     and migrations;
   - security for trust boundaries, secrets, permissions, external input,
     sensitive storage, and supply-chain risk;
   - verification for behavior, tests, evidence sufficiency, regressions, and
     release readiness;
   - reliability for SLOs, observability, failure handling, rollback, restore,
     capacity, and operational cost.
3. Each reviewer receives the same immutable snapshot and a bounded question.
   Keep reviews independent: do not include another reviewer's conclusion when
   it is not needed for evidence.
4. Use at most one isolated challenger only when the decision remains costly,
   contested, or materially uncertain after the principal position. Prefer a
   host-native subagent with a bounded, read-only brief. An external model or
   MCP is an optional private adapter, never a public dependency.
5. The principal reconciles evidence, alternatives, disagreements, failure
   modes, and limitations. It remains responsible for the recommendation.
6. Before requesting human approval, state: what the approval changes, whether
   anything becomes usable immediately (`yes` or `no`), what remains
   unauthorized, and that the next phase will not start automatically. The
   human approval required by the data contract remains required. A review or
   challenge grants no authority.

Do not vote or select a decision by majority. Agreement is not proof. A
same-session self-check may be useful but must be labelled `self-check`, not
`independent`.

## Review budget and terminal states

For one material decision, allow one review wave, at most one challenger, one
correction, and one revalidation. Do not ask a reviewer to review another
review, and do not start recursive model-to-model debate.

If the correction fails revalidation or an applicable material finding remains
open, the phase is terminal: stop, mark the visible output limited or unusable,
or request human reframing. Budget exhaustion never implies acceptance. A
genuinely new material risk introduced by the correction may receive one
additional bounded confirmation, but it does not reopen another correction
cycle in the same phase.

## Non-material work

Skip the review fan-out for deterministic rendering, validation, factual
inventory, evidence append, typo correction, or a small local reversible
change. Escalate when that work exposes a material contradiction or requires a
new direction.

## Receipts

Exploratory passes and same-session self-checks do not require persistence.
For the final human gate, record one immutable receipt for every independent
review or challenge actually presented, favorable or adverse, under
`reviews/<decision_id>/<receipt_id>.json`. Record one reconciliation that names
all those receipts and disposes every material finding. Receipts are advisory
evidence and contain concise findings, alternatives, limitations, evidence
references, isolation category, and input/resulting root digests. Never store
prompts, raw transcripts, chain-of-thought, credentials, personal data, or
unrelated source content.

If any reviewed canonical file or target artifact changes, the earlier receipt
remains historical evidence for its input digest and the one allowed
revalidation must inspect the changed root. Never waive revalidation by calling
a change cosmetic. Receipt and audit-log appends that are structurally outside
the canonical root do not themselves trigger another review.

## Memory boundary

Personal notes are not a canonical project source and must not be sent to a
reviewer or external model. A private adapter may surface a human-selected note
as untrusted advisory context, but a claim enters the project record only after
the human promotes it into the canonical JSON with explicit evidence or
uncertainty.
