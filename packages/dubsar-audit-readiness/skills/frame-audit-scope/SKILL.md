---
name: frame-audit-scope
description: Define a bounded, evidence-aware audit scope for automations, AI agents, workflows, or connected business systems. Use when starting an audit preparation, deciding what local evidence may be inspected, recording exclusions, or narrowing an open-ended assessment request.
---

# Frame Audit Scope

## Objective

Create an attributable, reviewable scope before collecting new evidence or
drawing conclusions.

## Inputs

- the business question and candidate systems, automations, agents, and
  processes;
- proposed local evidence sources and how the user supplied them;
- exclusions, time window, limitations, and completion criteria;
- an explicit output path;
- approval attribution only when the user actually approves the scope.

## Workflow

1. Run the complete pack's `ensure-audit-workspace.mjs` from the current
   directory. Reuse the returned audit workspace or let it initialize one and
   generate `case_id`. Do not ask the user to name or manage it.
2. Restate the business objective in one sentence.
3. List the systems, automations, agents, and business processes explicitly in
   scope. Do not add systems merely because they probably exist.
4. Record the approved evidence sources and how each source was provided.
5. Record excluded systems, data, actions, and time periods.
6. Mark every uncertain statement as `unknown` or `reported`, never `observed`.
7. Define what would make the preparation complete enough for human review.
8. Ask the user to approve the scope before suggesting evidence collection.
   Record a role or pseudonymous identifier, an ISO 8601 UTC timestamp, and a
   local approval reference. Do not invent these values.

## Review gate

Before approval of a materially ambiguous purpose, scope, evidence boundary,
or trust boundary, follow [the common review
protocol](../dubsar-audit-readiness/references/review-protocol.md). Freeze its
goal lock first. Use one product or security reviewer by default according to
the actual ambiguity; add a challenger only if a costly boundary remains
contested. Do not create another case from a finding.

## Output

Produce `audit-scope.json` with this stable shape:

```json
{
  "format": "dubsar.audit-scope/1",
  "case_id": "generated-automatically",
  "objective": "bounded business question",
  "in_scope": [],
  "approved_evidence": [],
  "excluded": [],
  "time_window": null,
  "completion_criteria": [],
  "limitations": [],
  "approval": null,
  "status": "draft"
}
```

Use `status: "draft"` and `approval: null` until the user explicitly approves
it. Then record:

```json
{
  "approved_by": "role-or-pseudonymous-id",
  "approved_at": "2026-01-01T12:00:00Z",
  "approval_ref": "local-conversation-or-note-reference",
  "source": "user-provided"
}
```

Approval means only that the preparation scope is accepted; it grants no
execution authority.

When this skill is installed with the complete pack, run:

```bash
node ../dubsar-audit-readiness/scripts/ensure-audit-workspace.mjs --start <current-directory>
```

Otherwise create the documented JSON manually. Never overwrite an existing
workspace.

## Boundaries

- Prefer user-supplied exports, screenshots, logs, configuration files, and
  documentation.
- Keep access local and read-only; make no network calls and request no
  credentials or production secrets.
- Do not run or modify an automation, grant execution authority, classify legal
  compliance, certify safety, or claim that an audit was completed.
- Preserve uncertainty and do not expand the scope without user approval.
- Before approval, say whether anything becomes usable immediately (`no` for a
  scope draft), what remains unauthorized, and that evidence collection will
  not start automatically.

## Example invocation

> Use `$frame-audit-scope` to define a review of the supplied local workflow
> exports for January 2026, exclude production execution and customer content,
> and leave the scope in draft until I approve it.
