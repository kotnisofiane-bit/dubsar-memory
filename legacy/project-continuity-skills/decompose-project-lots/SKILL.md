---
name: decompose-project-lots
description: Split an approved mission into small, ordered, independently verifiable lots with dependencies, exclusions, proof, and stop conditions. Use when asked to break down, phase, sequence, or audit a project that is too large for one safe execution pass.
---

# Decompose Project Lots

## Objective

Create the smallest ordered sequence that still produces meaningful,
human-reviewable progress.

## Inputs

- an approved `mission.json`;
- known dependencies, protected areas, and irreversible boundaries;
- existing evidence identifiers, if any.

## Lot design rules

Each lot must:

- have one primary outcome;
- name the files, systems, or artifacts it may touch when known;
- list dependencies and required prior evidence;
- define what it will not do;
- specify a proportional validation method;
- end at a human-reviewable boundary;
- avoid bundling cleanup, feature work, deployment, and migration together.

## Workflow

1. Read the approved `mission.json`.
2. Identify dependency order and irreversible boundaries.
3. Prefer discovery or preservation lots before mutation lots.
4. Give each lot a stable ID and one sentence outcome.
5. Record expected evidence and stop conditions.
6. Leave new lots `planned`. Present eligible lots without ranking them; only a
   separate, explicitly confirmed checkpoint may transition one to `candidate`.

## Review gate

If sequencing fixes architecture, migration, deployment, or recovery choices,
follow [the common review protocol](../dubsar-project-continuity/references/review-protocol.md).
Use one relevant architecture or reliability reviewer by default. Add a
challenger only if an irreversible sequencing choice remains contested. Do not
add a lot solely to implement an out-of-scope reviewer suggestion.

## Output

Write `lots.json`:

```json
{
  "format": "dubsar.project-lots/1",
  "mission_id": "same-as-mission",
  "lots": [
    {
      "lot_id": "local-stable-id",
      "title": "bounded outcome",
      "depends_on": [],
      "in_scope": [],
      "excluded": [],
      "expected_evidence": [],
      "validation": [],
      "stop_conditions": [],
      "status": "planned|candidate|complete"
    }
  ]
}
```

## Limits

- Do not alter the approved mission or execute any lot.
- Keep at most one lot in `candidate` state.
- Before approval, state that the lots are planning artifacts, whether anything
  becomes usable immediately (`no` unless already evidenced), and that no
  contract or lot starts automatically.
- Never mark a lot complete from an intention, plan, or agent statement alone;
  completion requires its declared `observed` or `derived` evidence.

## Example invocation

`Use $decompose-project-lots to split this approved mission into ordered lots with explicit proof and stop conditions.`
