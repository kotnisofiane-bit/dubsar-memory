# DUBSAR Audit Readiness

Portable Agent Skills for preparing a bounded automation or AI-agent audit
from user-approved local evidence.

## Skills

| Skill | Use |
| --- | --- |
| `$dubsar-audit-readiness` | Run the complete preparation workflow |
| `$frame-audit-scope` | Define the objective, evidence, exclusions, and limits |
| `$inventory-automations` | Build an evidence-linked automation inventory |
| `$map-sensitive-actions` | Map material effects and human review points |
| `$review-evidence-gaps` | Separate support, contradictions, gaps, and limits |
| `$export-audit-bundle` | Export a validated deterministic review bundle |

The workflow produces five case-linked JSON documents, a deterministic
human-readable preparation summary, and can package them with approved
evidence for human review. It does not produce an audit verdict.
The helper generates one local `case_id` automatically and reuses it for the
same case across conversations and context compression. It searches only from
the current directory to the nearest Git project root and chooses the nearest
ancestor `.dubsar-audit`. Users do not need to choose or remember the
identifier.

Material gates freeze the user goal, supported environment, acceptance surface,
artifact digest, and review budget before selecting the smallest relevant
reviewer set. One review wave, one correction, and one revalidation are the
default; unresolved applicable findings stop the phase rather than creating a
new case. A challenger is optional and bounded. The principal agent reconciles
every favorable or adverse final-gate review; no majority vote or severity
label grants approval.

One directory scope has one active audit workspace. If the request is a
genuinely different case, confirm that separation before reuse, then create an
exact `.dubsar-audit` marker inside a dedicated in-project directory. Do not
delete, overwrite, or recycle the previous case identifier.

## Local helpers

From the target project's root, point to the installed pack:

```bash
node /absolute/path/to/dubsar-audit-readiness/scripts/ensure-audit-workspace.mjs --start .
node /absolute/path/to/dubsar-audit-readiness/scripts/validate-audit-workspace.mjs --root ./.dubsar-audit
node /absolute/path/to/dubsar-audit-readiness/scripts/render-audit-summary.mjs --root ./.dubsar-audit --output ./audit-summary
node /absolute/path/to/dubsar-audit-readiness/scripts/export-audit-bundle.mjs --root ./.dubsar-audit --output ./audit-bundle
node /absolute/path/to/dubsar-audit-readiness/scripts/record-review-receipt.mjs --root ./.dubsar-audit < receipt.json
```

The `ensure` helper returns only an opaque identifier and a path relative to
the supplied `--start`. The host resolves that path locally before invoking
another helper; it does not need to expose an absolute path. The scripts use
Node.js built-ins only, perform no network calls, and refuse unsafe paths,
links, partial workspaces, identity conflicts, or destructive overwrites.

## Boundaries

The pack does not connect to production services, request credentials, run or
modify an automation, decide legal compliance, certify a system, upload a
bundle, or communicate with a production DUBSAR service. It includes no hooks,
MCP server, network integration, DUBSAR Core dependency, or canonical session
record. It contains doctrine and local preparation helpers only.

## Hosts

The same `skills/` directory is used by Codex, Claude Code, Cursor, and
other Agent Skills hosts through their repository-level manifests. Hermes uses
the self-contained umbrella skill mirrored under the repository root
`skills/` directory.

## Status

Public beta v0.2.0 under the MIT License. The package includes reviewed
clean-room provenance and a deterministic release inventory. See the
repository-level `PUBLIC_BOUNDARY.md`.
