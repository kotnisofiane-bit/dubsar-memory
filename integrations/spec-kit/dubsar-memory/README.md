# DUBSAR Memory — a Spec Kit extension

Spec Kit frames the intent: specification, plan, tasks. It does not remember what
happened afterwards. This extension adds that memory, locally, without a server.

DUBSAR records what you decided, what blocked you, and which documents you
vouched for — then tells you, on the next session, whether those documents still
match what was recorded.

## Install

```
specify extension add dubsar
```

For a local checkout of the built artifact:

```
specify extension add --dev path/to/extracted-extension
```

Requires Node 20 or later on the host. The extension embeds the DUBSAR
JavaScript runtime under `runtime/`, but it does **not** ship a Node binary —
`node` remains a system dependency declared in `extension.yml`. No Python is
added to your project, no server runs, and nothing reaches the network.

## Commands

### `/speckit.dubsar.resume`

Reads the recorded state and reports it: the selected Work, open blockers,
recorded checkpoints, the next action, and the state of the Spec Kit documents
you previously recorded.

Each document is reported with one of six words:

| Status | Meaning |
| --- | --- |
| `absent` | the file is not in the feature directory |
| `unlinked` | the file exists, but no checkpoint ever recorded it |
| `fresh` | recorded, and it still matches its recorded digest |
| `stale` | recorded, and it changed since |
| `missing` | recorded, and it is now gone |
| `unknown` | recorded, but the check did not conclude |

`unlinked` is not `fresh`. A document nobody vouched for is not verified.

This command writes nothing and initializes nothing.

### `/speckit.dubsar.checkpoint`

Records one verified fact, decision, or blocker. It can reference the current
feature's `spec.md`, `plan.md`, and `tasks.md` — only those that actually exist.

When the project has no local DUBSAR memory yet and you provide the Work and
First recorded checkpoint details up front, the skill can use one atomic
**Create project memory** (`bootstrap`) preview instead of four separate
writes. Otherwise it keeps the advanced granular path: init → Work create →
Work select → checkpoint.

Every write is preview, then confirmation, then apply against the exact digest
you saw. A granular checkpoint changes one canonical file,
`.dubsar/checkpoints.json`. Bootstrap publishes the whole `.dubsar/` directory
atomically. Nothing under `.specify/` or `specs/` is ever written.

## What this extension deliberately does not do

- **No hooks.** DUBSAR never runs on `before_specify`, `after_plan`, or any
  other lifecycle event. A checkpoint is a human gesture.
- **No task ticking.** `tasks.md` belongs to Spec Kit. DUBSAR never edits it and
  never derives a completion percentage from its checkboxes — there is no
  canonical per-task state to count.
- **No automatic anything.** No Spec Kit command is invoked, no workflow is
  resumed, no workspace is created without you saying so.
- **No content copying.** A reference is a path and a digest. Document text is
  never copied into memory, and is always treated as untrusted quoted data.

## Where things live

| Path | Owner |
| --- | --- |
| `.specify/`, `specs/` | Spec Kit — this extension only reads them |
| `.dubsar/` | DUBSAR — Spec Kit never touches it |

One source of authority per piece of data, in both directions.

The status adapter binds memory to the Spec Kit root (the directory that owns
the nearest `.specify/`). A `.dubsar` or `.dubsar-project` found only in a
parent directory is reported as `WORKSPACE_NOT_FOUND` for that Spec Kit project.
Ordinary DUBSAR usage may still walk parents; this isolation is Spec Kit
adapter policy, not a change to the general locator.

Cursor skills for the two DUBSAR commands come from Spec Kit's extension
registry. Their absence from `cursor-agent.manifest.json` (core Spec Kit skills
only) is expected, not a packaging defect.

## Known limit

`.specify/memory/constitution.md` cannot be referenced. DUBSAR rejects any path
containing a `memory` segment, a safety rule that predates this extension. The
constitution is reported but never linked.

## Publishing

The order matters, and it is not a pull request.

1. **Tag and create a GitHub Release** on this repository, attaching the built
   ZIP and publishing its SHA-256 in the release notes. The build is
   deterministic, so the digest is reproducible from the same sources.
2. **File an issue** using the Spec Kit **Extension Submission** template. A
   maintainer reviews it during triage and updates the catalog.

> Do **not** open a pull request against `extensions/catalog.community.json`.
> Spec Kit requires all community submissions to go through the issue template.

Updating an existing entry follows the same path: a new release, then a new
Extension Submission issue noting that it updates an existing entry.

### Verified against

Spec Kit `0.16.4`, installed and executed with the packaged artifact across the
`claude`, `codex`, and `cursor-agent` integrations. The manifest declares
`speckit_version: ">=0.16.4"`, the oldest version actually exercised — nothing
older is claimed.

## Guarantees

- **No hooks.** The manifest declares no `hooks:` section, so no Spec Kit
  lifecycle event ever triggers DUBSAR.
- **No MCP server, no daemon, no network.** The extension runs two short-lived
  Node processes and exits.
- **No write into `.specify/` or `specs/`.** Reads go through DUBSAR's
  safe-capture path, which refuses symlinks, junctions, hardlinks, traversal,
  and oversized files.

## License

MIT. DUBSAR Memory is developed at
`github.com/kotnisofiane-bit/dubsar-memory`. Spec Kit is a separate MIT project
by GitHub, installed and updated independently.
