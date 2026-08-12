---
name: map-sensitive-actions
description: Map automation or AI-agent actions that can communicate externally, move money, change access, alter data, affect people, or create another material business effect. Use when preparing control points, stop conditions, ownership, and human-review requirements.
---

# Map Sensitive Actions

## Objective

Identify evidence-supported material effects and propose review points without
enforcing controls or approving actions.

## Inputs

- `audit-scope.json`, `automation-inventory.json`, and `evidence-index.json`
  with the same `case_id`;
- approved local artifacts supporting actions or safeguards;
- user-provided control priorities and accountable roles, when available;
- an explicit output path for `sensitive-actions.json`.

## Sensitive action classes

Consider an action sensitive when it can:

- send, publish, approve, or commit a communication;
- create a payment, refund, order, contract, or financial record;
- grant, revoke, or change access and credentials;
- modify, export, retain, or delete business or personal data;
- affect employment, eligibility, pricing, safety, or legal obligations;
- invoke another system that can perform one of these effects.

Do not label ordinary read-only retrieval as sensitive merely because its source
is important. Record confidentiality concerns separately.

## Workflow

1. Start from `automation-inventory.json`.
2. Trace each known trigger to its externally observable effects.
3. Preserve gaps when a branch or destination is unknown.
4. Record the current safeguard only when evidence supports it.
5. Propose a review point, stop condition, and accountable role for each
   material action.
6. Ask a human to confirm priority and whether the map is complete enough for
   the approved scope.

## Review gate

For every material trust boundary or sensitive external effect, follow [the
common review protocol](../dubsar-audit-readiness/references/review-protocol.md).
Use one security reviewer by default. Add architecture or reliability only for
an applicable cross-cutting current-scope risk, and use a challenger only if a
costly control decision remains contested before human confirmation.

## Output

Write `sensitive-actions.json` with one entry per action:

```json
{
  "format": "dubsar.sensitive-actions/1",
  "case_id": "same-as-audit-scope",
  "review_status": "pending|reviewed",
  "actions": [
    {
      "id": "local-stable-id",
      "automation_id": "inventory-item-id",
      "effect": "plain-language effect",
      "classes": [],
      "current_safeguards": [],
      "evidence_refs": [],
      "uncertainties": [],
      "proposed_review_point": null,
      "proposed_stop_condition": null,
      "accountable_role": null,
      "human_status": "unreviewed"
    }
  ]
}
```

Never set `human_status` to an approved state on the user's behalf.
Set the top-level `review_status` to `reviewed` only after a human confirms that
the map is complete enough for the stated scope, including when no sensitive
action was found.

## Boundaries

- Use only approved local evidence and indexed artifact IDs; make no network
  calls.
- Do not execute actions, change safeguards, assign an unconfirmed owner, or
  approve the map for the user.
- Do not treat read-only retrieval as a material effect solely because its
  source is important.
- Do not make legal, compliance, safety, or risk-acceptance decisions.

## Example invocation

> Use `$map-sensitive-actions` to map payment, access-change, and external
> messaging effects in `./audit-case/automation-inventory.json`, then leave all
> human decisions unapproved for the operations lead to review.
