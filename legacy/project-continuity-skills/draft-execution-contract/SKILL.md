---
name: draft-execution-contract
description: Define the exact scope, permitted actions, exclusions, validation, evidence, recovery expectations, and stop rules for one project lot. Use when asked for an execution contract, preflight boundary, or safe implementation agreement immediately before material project work.
---

# Draft Execution Contract

## Objective

Translate one candidate lot into an explicit, reviewable local work agreement.

## Inputs

- the approved `mission.json`;
- `lots.json` with exactly one `candidate` lot;
- known targets, protected areas, validation methods, evidence requirements,
  recovery expectations, and authority constraints.

## Workflow

1. Select exactly one `candidate` lot.
2. Resolve its concrete target paths or systems.
3. List allowed actions narrowly. Keep read-only inspection separate from
   mutation.
4. List forbidden actions and protected areas.
5. Record validation commands or observable checks.
6. Define the evidence files that must exist at completion.
7. Record rollback or recovery expectations for each material mutation.
8. Add stop conditions for ambiguity, unexpected changes, failing validation,
   or missing authority.
9. Ask for approval before execution begins.

## Review gate

For material boundaries, permissions, migrations, deployments, or recovery
choices, follow [the common review protocol](../../hermes-skills/dubsar-project-continuity/references/review-protocol.md).
Select the smallest relevant set, one reviewer by default and at most three
only for cross-cutting current-scope risk. Use a challenger only when the
bounded execution decision remains contested.

## Output

Write `execution-contract.json`:

```json
{
  "format": "dubsar.execution-contract/1",
  "mission_id": "same-as-mission",
  "lot_id": "selected-lot",
  "contract_id": "local-stable-id",
  "targets": [],
  "allowed_actions": [],
  "forbidden_actions": [],
  "protected_areas": [],
  "validation": [],
  "required_evidence": [],
  "recovery_expectations": [],
  "stop_conditions": [],
  "status": "draft"
}
```

## Limits

- Keep the contract in `draft` state until the user approves it.
- Do not invent unresolved targets, permissions, validation, or recovery steps.
- Before approval, say exactly which actions become authorized, whether the
  result becomes usable immediately, what remains forbidden, and that execution
  will not begin automatically.
- Do not execute the lot; the contract records a boundary and grants no new
  authority.

## Example invocation

`Use $draft-execution-contract to bound the candidate lot before implementation, including proof, recovery expectations, and stop rules.`
