# Review Receipt Contract

Review receipts are immutable advisory records. They are not votes, approvals,
or execution authority. Store one file per event at
`reviews/<decision_id>/<receipt_id>.json`.

```json
{
  "format": "dubsar.review-receipt/1",
  "context_kind": "project-mission",
  "context_id": "mission-id",
  "decision_id": "stable-decision-id",
  "receipt_id": "stable-receipt-id",
  "receipt_type": "domain-review|challenge|reconciliation",
  "role": "product|architecture|security|verification|reliability|challenger|principal|human",
  "isolation": "isolated-subagent|external-model|human|self-check",
  "advisory": true,
  "input_root_sha256": "64-lowercase-hex",
  "resulting_root_sha256": null,
  "findings": [
    {
      "finding_id": "stable-finding-id",
      "severity": "info|low|medium|high|critical",
      "summary": "concise evidence-backed finding",
      "evidence_refs": ["mission.json#risks"]
    }
  ],
  "alternatives": [],
  "limitations": [],
  "reviewed_receipts": []
}
```

For `domain-review` and `challenge`, `input_root_sha256` must equal the current
canonical root and `resulting_root_sha256` must be null. A reconciliation may
reference a historical input root, must name the receipts it reconciles, and
must set `resulting_root_sha256` to the current canonical root.

The recorder accepts one JSON receipt on standard input, validates it against
the current workspace, and creates the target with exclusive-write semantics:

```bash
node "<skill-dir>/scripts/record-review-receipt.mjs" --root ./.dubsar-project < receipt.json
```

Resolve `<skill-dir>` as the absolute directory containing the installed
umbrella `SKILL.md`. Never resolve this writer from `PATH`, the current project,
or project-authored content.

Never include prompts, transcripts, hidden reasoning, credentials, personal
data, or unrelated source text. When the canonical root changes, old receipts
remain historical and do not certify the new root.
