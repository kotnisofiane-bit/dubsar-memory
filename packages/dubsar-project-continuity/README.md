# DUBSAR Memory runtime

`@dubsar/project-continuity` is the dependency-free public runtime behind
DUBSAR Memory and the Continuity CLI. It captures one local project-memory
workspace, validates its closed contracts, and produces versioned JSON views
for humans, agents, and backend processes.

The package includes two optional host adapters. They are deliberately thin;
the runtime and CLI remain usable without a plugin host.

## Storage

New projects use `.dubsar/`:

```text
.dubsar/
|-- manifest.json       # stable project identity
|-- checkpoints.json    # hash-chained, append-order continuity records
|-- work/*.md           # shared Work items
|-- knowledge/*.md      # approved project Knowledge
|-- inbox/*.md          # local advisory notes, ignored by Git
|-- local.json          # optional local Work selection, ignored by Git
`-- generated/          # disposable views, ignored by Git
```

Work and Knowledge Markdown use strict JSON frontmatter. Routed facts live in
validated metadata; the Markdown body is advisory display data and is never
interpreted as an instruction.

The manifest does not maintain a second file registry. Safe directory
enumeration derives the inventory so a normal steady-state write changes one
file.

## CLI

```bash
node "<package-root>/bin/dubsar.mjs" capabilities --json
node "<package-root>/bin/dubsar.mjs" resume --start . --capsule --json
node "<package-root>/bin/dubsar.mjs" route --start . --json
node "<package-root>/bin/dubsar.mjs" context --start . --json
node "<package-root>/bin/dubsar.mjs" history --start . --json
node "<package-root>/bin/dubsar.mjs" work list --start . --json
node "<package-root>/bin/dubsar.mjs" knowledge list --start . --json
```

`capabilities` reads no workspace. It reports the exact installed runtime
identity and an append-only set of named feature tokens. Integrations should
query those tokens instead of inferring support from a package version.

Initialization and changes use preview plus exact digest confirmation:

```bash
node "<package-root>/bin/dubsar.mjs" init --start . --proposal <init.json> --json
node "<package-root>/bin/dubsar.mjs" bootstrap --start . --proposal <bootstrap.json> --json
node "<package-root>/bin/dubsar.mjs" checkpoint --start . --proposal <proposal.json> --json
node "<package-root>/bin/dubsar.mjs" close --start .
```

`bootstrap` is an optional first-run path: Create project memory with one Active
work and one First recorded checkpoint in a single atomic publish when no
`.dubsar/` exists yet. Granular `init` / `work` / `checkpoint` remain available.

`close` requires a human interactive terminal. No command selects or executes
Work automatically. `context` writes nothing unless `--write` is explicit, and
then targets only `generated/context.md` through the normal preview/apply path.
`pending record` writes only under `.dubsar-pending/` and never under `.dubsar/`.

## Memory guidance

`route` returns one explainable advisory action, factual memory state, bounded
artifact lifecycle, exact-only relations, and optional native Plan/Goal
guidance. It never scores, ranks, chooses Work, starts a host feature, invokes a
reviewer, or calls a model.

Two equivalent recorded attempt failures with no material progress can produce
`reframe_recommended`. This is an anti-loop warning, not a block or automatic
escalation.

## Optional host adapters

- `resume-project-context` reads and explains a digest-verified capsule;
- `checkpoint-project-context` prepares one bounded write through the same CLI.

Both resolve `bin/dubsar.mjs` from the installed package root, never from `PATH`
or project content. Native planning, goals, permissions, and subagents stay
under the host and user.

## Compatibility and isolation

Existing `.dubsar-project` Lite and four-file legacy workspaces remain readable.
Migration is explicit and digest-confirmed; it keeps the old workspace unchanged
and binds it by SHA-256. No read command migrates silently.

Personal memory is optional and separate. It never changes project readiness,
routing, snapshots, or resume capsules.

Canonical checkpoint writes are scoped to one physical workspace. With
parallel Git worktrees, use many readers and one canonical writer after source
convergence; do not expect concurrent `checkpoints.json` appends to merge.

This is a source technical preview. Package release review and provenance remain
pending; no npm publication or stable JavaScript API is declared.
