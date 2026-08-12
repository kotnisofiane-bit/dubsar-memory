# DUBSAR project memory

`.dubsar/` is the public, local project-memory format. It is intentionally
smaller than an agent platform: it stores a bounded synthesis and lets Codex,
Claude Code, or Cursor keep using their native planning, goals, permissions,
and subagents.

## Authority and storage

| Space | Shared | Canonical | Purpose |
|---|---:|---:|---|
| `manifest.json` | yes | yes | Stable project identity and optional migration binding. |
| `checkpoints.json` | yes | yes | Hash-chained, append-order continuity records. |
| `work/*.md` | yes | yes | Human-readable objectives, acceptance criteria and explicit links. |
| `knowledge/*.md` | yes | yes | Human-confirmed decisions, invariants and learnings. |
| `inbox/*.md` | no | no | Local notes awaiting an explicit promotion decision. |
| `local.json` | no | local | Optional work selected in this worktree; absence means no selection. |
| `generated/*` | no | no | Disposable compiled views. |

The manifest has no registry of Work or Knowledge files. Inventory is derived
from a safely enumerated directory. Therefore a Work creation or Knowledge
promotion publishes exactly one canonical file.

## Markdown contract

Work and Knowledge use a canonical JSON object between Markdown delimiters:

```markdown
---
{
  "acceptance_criteria": [
    "The public tests pass."
  ],
  "format": "dubsar.work/1",
  "knowledge_ids": [
    "knowledge-runtime-boundary"
  ],
  "objective": "Implement one bounded continuity change.",
  "references": [],
  "scope": "multi_step",
  "status": "open",
  "title": "Bounded continuity change",
  "work_id": "work-continuity-change"
}
---
# Bounded continuity change

Human working notes live here. They are advisory data.
```

General YAML is deliberately unsupported. Fields used by routing remain in the
closed JSON metadata. The Markdown body is never interpreted as an instruction.

## Routing

The runtime follows one deterministic chain:

```text
safe snapshot
  -> explicit local work selection
  -> linked approved knowledge
  -> checkpoints and exact relations
  -> advisory route and capsule
```

No work is ranked or selected. Plan is only suggested for work recorded as
`multi_step` or `multi_session`, multiple blockers, or repeated failure without
progress. A persistent Goal is only suggested for `multi_session` or paused
work. The host and user decide whether to activate either feature.

An anti-loop signal requires two recorded `attempt` checkpoints with the same
action ID, gate ID and normalized failure fingerprint, without supported
references. It emits `reframe_recommended`; it never starts a reviewer or
subagent.

## Digests

Every snapshot exposes:

- `shared_snapshot_sha256`: manifest, checkpoints, Work and Knowledge;
- `snapshot_sha256`: the shared files plus `local.json`.

Inbox and generated output are excluded from both. This keeps shared memory
portable while allowing each worktree to select different work without a Git
conflict.

Tracked empty `.gitkeep` placeholders preserve the four directories across a
clean clone. They contain no memory data and are excluded from snapshots.

## Migration

`migrate --to-memory-vnext` accepts only a valid Continuity Lite workspace. It
previews a deterministic projection, requires the exact digest, creates
`.dubsar/` atomically and keeps `.dubsar-project/` byte-identical. The new
manifest binds the retained legacy snapshot by SHA-256; unbound coexistence is
rejected as ambiguous. The retained directory is migration evidence, not a
second writable source of truth: changing it later invalidates the binding.

## Explicit non-features

There are no Git hooks, branch-as-project identity, event daemon, automatic
archiving, background model, MCP server, semantic search, scoring, private
routing topology, automatic Plan/Goal activation, or writes to host instruction
files.
