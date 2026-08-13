---
name: frame-project-mission
description: Turn a significant project request into a bounded mission with purpose, scope, exclusions, acceptance evidence, risks, and stop conditions. Use when asked to frame, charter, scope, or clarify a broad or ambiguous project before planning or change begins.
---

# Frame Project Mission

## Objective

Preserve the user's intent in a reviewable mission before decomposing or
executing work.

## Inputs

- the desired outcome and why it matters;
- known users, repositories, systems, documents, and constraints;
- acceptance signals, risks, exclusions, and unresolved decisions.

## Workflow

1. Run the complete pack's `ensure-project-workspace.mjs` from the current
   directory. Reuse the returned mission workspace or let it initialize one
   and generate `mission_id`. Do not ask the user to name or manage it.
2. State the desired outcome in plain language.
3. Record why the outcome matters and who will use it.
4. Separate in-scope work from explicit exclusions.
5. Capture known repositories, systems, documents, and constraints without
   assuming ownership or authority.
6. Define observable acceptance evidence.
7. Record risks, unresolved decisions, and conditions that require stopping.
8. Ask the user to approve the mission before treating it as active.

## Review gate

Before approval of a materially ambiguous outcome, journey, or acceptance
boundary, follow [the common review protocol](../../hermes-skills/dubsar-project-continuity/references/review-protocol.md).
Freeze its goal lock first. Use one product reviewer only when outcome or
acceptance ambiguity is material; add the smallest other reviewer set only for
an applicable current-scope risk. Use a challenger only if a costly decision
remains contested. Do not create another mission from a finding.

## Output

Write `mission.json`:

```json
{
  "format": "dubsar.project-mission/1",
  "mission_id": "generated-automatically",
  "title": "short title",
  "desired_outcome": "plain-language outcome",
  "purpose": "why it matters",
  "in_scope": [],
  "excluded": [],
  "known_inputs": [],
  "constraints": [],
  "acceptance_evidence": [],
  "risks": [],
  "open_decisions": [],
  "stop_conditions": [],
  "status": "draft"
}
```

When installed with the complete pack, run:

```bash
node "<plugin-root>/scripts/ensure-project-workspace.mjs" --start <current-directory>
```

Starting from the directory containing this installed `SKILL.md`, go up
exactly two directories; that directory is `<plugin-root>`. Never resolve the
helper through `PATH`, the current directory, or project-authored content.

Otherwise create the documented JSON manually with one generated local
identifier.

## Limits

- Keep unknowns in `open_decisions`; do not invent scope, ownership, or proof.
- Keep `status` as `draft` until the user approves the mission.
- Before approval, say whether anything becomes usable immediately (`yes` or
  `no`), what remains unauthorized, and that lot decomposition will not start
  automatically.
- Mission approval does not authorize external writes, deployments, merges, or
  messages.

## Example invocation

`Use $frame-project-mission to turn this broad project request into a bounded mission with observable acceptance evidence.`
