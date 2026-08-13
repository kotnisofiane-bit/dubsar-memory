---
name: inventory-automations
description: Build an evidence-linked inventory of automations, AI agents, workflows, triggers, owners, systems, and dependencies from approved local artifacts. Use when preparing an audit or governance review and the user needs a factual map of what operates across tools.
---

# Inventory Automations

## Objective

Turn heterogeneous local evidence into a stable factual inventory without
discovering or connecting to production systems.

## Inputs

- an approved `audit-scope.json`;
- `evidence-index.json` for the same `case_id`;
- the indexed, user-approved local artifacts;
- an explicit output path for `automation-inventory.json`.

## Evidence discipline

For every field, record one of:

- `observed`: directly supported by a cited local artifact;
- `reported`: stated by a person but not independently shown;
- `unknown`: not established by the available evidence.

Never convert a likely value into an observed fact. Use indexed artifact IDs in
`generated_from` and `evidence_refs`; do not substitute uncatalogued paths or
copy credentials or personal data.

## Workflow

1. Confirm that the scope and evidence index share the same `case_id`.
2. Select only approved indexed artifacts relevant to the scope and cite their
   IDs in `generated_from`.
3. Enumerate only automations and agents supported by those artifacts.
4. For each item, record its purpose, owner, trigger, inputs, outputs, connected
   systems, current state, evidence state, and at least one artifact ID.
5. Record external dependencies separately from the workflow itself.
6. Flag duplicates and ambiguous names without merging them automatically.
7. Record missing ownership, trigger, or destination information in `gaps`.

## Review gate

Factual inventory needs no reviewer. If conflicting evidence would materially
change a system boundary, owner, or dependency, preserve the conflict and route
the decision through [the common review
protocol](../dubsar-audit-readiness/references/review-protocol.md). Do not expand
discovery or initialize another case to resolve it automatically.

## Output

Write `automation-inventory.json`:

```json
{
  "format": "dubsar.automation-inventory/1",
  "case_id": "same-as-audit-scope",
  "generated_from": [],
  "items": [
    {
      "id": "local-stable-id",
      "name": "workflow name",
      "kind": "workflow|agent|scheduled-job|integration|other",
      "purpose": null,
      "owner": null,
      "trigger": null,
      "inputs": [],
      "outputs": [],
      "connected_systems": [],
      "state": "active|inactive|unknown",
      "evidence_state": "observed|reported|unknown",
      "evidence_refs": []
    }
  ],
  "gaps": []
}
```

Sort items by `id` and arrays of strings lexicographically so repeated
generation from the same evidence remains stable.

## Boundaries

- Use only approved local artifacts; make no network calls or production
  discovery.
- Do not run, enable, disable, merge, or modify an automation.
- Do not invent owners, triggers, destinations, evidence links, or operational
  states.
- Do not include credentials, secrets, or unnecessary personal data.

## Example invocation

> Use `$inventory-automations` to build
> `./audit-case/automation-inventory.json` from the approved artifacts indexed
> in `./audit-case/evidence-index.json`, preserving unknown owners as gaps.
