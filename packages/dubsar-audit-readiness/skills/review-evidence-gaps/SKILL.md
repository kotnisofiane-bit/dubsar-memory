---
name: review-evidence-gaps
description: Review a local audit-preparation workspace and separate supported observations, reported statements, contradictions, missing evidence, and limitations. Use before presenting readiness findings or exporting a human-review bundle.
---

# Review Evidence Gaps

## Objective

Assess the coherence and support of the preparation, not the compliance or
safety of the target system.

## Inputs

- an explicit local workspace path containing the five initialized case JSON
  files;
- the approved artifacts referenced by `evidence-index.json`;
- recorded scope approval and sensitive-action human review, if provided.

## Workflow

1. Confirm that all five documents use the expected formats and same `case_id`.
2. Verify that approved evidence, inventory sources, inventory items, actions,
   and artifact paths resolve.
3. Verify indexed file digests and reject forbidden, non-regular, escaping, or
   credential-bearing artifacts.
4. Require evidence references for supported observations and preserve
   unsupported statements as `reported` or missing evidence.
5. Separate:
   - supported observations;
   - reported statements;
   - unresolved contradictions;
   - missing required evidence;
   - explicit limitations.
6. Use `not_ready` while approval, required preparation, references,
   contradictions, or required evidence remain unresolved.
7. Use `ready_for_human_review` only when the full preparation is coherent.
8. Run deterministic validation and report every finding and readiness reason.

## Review gate

Before changing the case to `ready_for_human_review`, follow [the common review
protocol](../dubsar-audit-readiness/references/review-protocol.md) with an
independent verification reviewer. Add a challenger only if the readiness
decision remains materially contested. Neither can erase a contradiction or
grant approval, and a failed revalidation leaves the case `not_ready`.

## Deterministic validation

When installed with the complete pack, run
`../dubsar-audit-readiness/scripts/validate-audit-workspace.mjs` with an
explicit `--root`. Treat its output as structural evidence only. If the script
is absent, reproduce the same checks manually and disclose that no executable
validation was performed.

## Output

Write `evidence-review.json`:

```json
{
  "format": "dubsar.evidence-review/1",
  "case_id": "same-as-audit-scope",
  "supported_observations": [
    {
      "statement": "Plain-language observation supported by indexed evidence.",
      "evidence_refs": ["artifact-id"]
    }
  ],
  "reported_statements": [],
  "contradictions": [],
  "missing_evidence": [],
  "limitations": [],
  "preparation_status": "not_ready|ready_for_human_review"
}
```

Do not silently repair evidence or erase a contradiction to obtain readiness.

## Boundaries

- Keep all inspection local and read-only except for the requested
  `evidence-review.json`; make no network calls.
- Do not collect missing evidence, request credentials, or alter source
  artifacts.
- Do not convert a report or assumption into an observation.
- Do not describe `ready_for_human_review` as an audit, compliance, legal, or
  safety verdict.

## Example invocation

> Use `$review-evidence-gaps` to review `./audit-case`, update only its
> `evidence-review.json`, and report every validation finding without filling
> gaps by assumption.
