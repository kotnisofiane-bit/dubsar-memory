# DUBSAR Project Continuity

A dependency-free local runtime and two lightweight skills for carrying a
verified project summary across sessions and coding hosts.

New projects use `.dubsar/`, a human-readable project-memory format:

```text
.dubsar/
|-- manifest.json       # stable project identity
|-- checkpoints.json    # append-order continuity records
|-- work/*.md           # shared work items
|-- knowledge/*.md      # explicitly promoted project knowledge
|-- inbox/*.md          # local advisory notes, ignored by Git
|-- local.json          # optional local work selection, ignored by Git
`-- generated/          # disposable views, ignored by Git
```

Markdown files use one strict JSON frontmatter object. Work and Knowledge are
inventoried from safe filenames, so creating one item never requires a fake
multi-file transaction. Existing `.dubsar-project` Lite and four-file legacy
workspaces remain readable. Migration is explicit, digest-confirmed, and keeps
the old workspace unchanged as immutable migration evidence.

## Active skills

- `$resume-project-context`: reads a digest-verified capsule and explains the
  recorded mission, work package, blockers, evidence state, and next action.
- `$checkpoint-project-context`: previews one bounded update and applies it only
  after explicit confirmation of the exact digest.

The package does not require reviewers, subagents, a backend, MCP, hooks, or a
global CLI. Native planning and goals remain host features. Resume may suggest
planning when work is broad and a goal when long work needs a measurable stop.

## CLI

```bash
node "<plugin-root>/bin/dubsar.mjs" init --start . --proposal <init.json> --json
node "<plugin-root>/bin/dubsar.mjs" resume --start . --capsule --json
node "<plugin-root>/bin/dubsar.mjs" route --start . --json
node "<plugin-root>/bin/dubsar.mjs" work list --start . --json
node "<plugin-root>/bin/dubsar.mjs" knowledge list --start . --json
node "<plugin-root>/bin/dubsar.mjs" inbox list --start . --json
node "<plugin-root>/bin/dubsar.mjs" context --start . --json
node "<plugin-root>/bin/dubsar.mjs" history --start . --json
node "<plugin-root>/bin/dubsar.mjs" lots --start . --json
node "<plugin-root>/bin/dubsar.mjs" precedents --start . --lot <lot-id> --json
node "<plugin-root>/bin/dubsar.mjs" checkpoint --start . --proposal <proposal.json> --json
node "<plugin-root>/bin/dubsar.mjs" close --start .
node "<plugin-root>/bin/dubsar.mjs" migrate --to-memory-vnext --start . --json
```

`resume`, `route`, `history`, `lots`, and `precedents` are read-only. `init` and
`checkpoint` require a preview and exact digest confirmation. `close` requires a human TTY.
No command selects or executes a work package automatically.

In a vNext workspace, one local work item may be selected explicitly. That
selection changes only the contextual digest; it never changes the shared
snapshot or chooses work for another developer. Project Knowledge reaches a
context only when an approved entry is explicitly linked by the selected work.
When `local.json` is absent after a clean clone, the selection is simply null;
the user may select a Work explicitly on that machine.

`context` writes nothing by default. `context --write` uses the same
preview/digest/apply protocol and writes only `generated/context.md`. It never
copies data into `AGENTS.md`, `CLAUDE.md`, or Cursor rules.

Two equivalent unsupported `attempt` checkpoints for the same action, gate,
failure fingerprint, and unchanged material state yield advisory
`reframe_recommended`. They do not block work or invoke reviewers.

`route` exposes Memory Guidance v2: one explainable advisory action, a factual
memory state, an artifact lifecycle projection, exact-only relations, and
optional native Plan/Goal guidance. It never scores, ranks, chooses work, or
activates a host tool.

Personal memory is optional, separate from project state, and never included in
project readiness or capsules.

Earlier workflow skills are preserved under the repository-level `legacy/`
directory but are not packaged or exposed by host manifests.

This vNext snapshot is local development work. Its release provenance is
`draft/pending`; no publication is authorized by the current manifests.
