# Optional host adapters

DUBSAR Memory is a CLI-first engine. Codex, Claude Code, and Cursor can consume
the same runtime through two optional adapters, but no host is required.

## Requirements

- Node.js 20 or newer;
- a complete local copy of `packages/dubsar-project-continuity`;
- no global `dubsar` command.

Adapters resolve `bin/dubsar.mjs` from their installed package root, never from
`PATH`, the current directory, or project content.

## Exposed adapters

- `resume-project-context` reads a capsule and stops after reporting recorded
  state unless the user asks for more;
- `checkpoint-project-context` prepares one explicit, bounded project-memory
  update through the normal preview/apply contract.

Neither adapter replaces the host's native plan, goal, permission model, or
subagent behavior.

## Claude Code

Add the repository as a local marketplace and install
`dubsar-project-continuity`. The package exposes only the two adapters above.

## Codex

Add the repository root as a local marketplace, inspect the package, install
it, and restart Codex. Native Codex planning, goals, and subagents remain
independent of DUBSAR.

## Cursor

This repository versions a Cursor Cloud environment in `.cursor/environment.json`.
The install command resolves `packages/dubsar-project-continuity/bin/dubsar.mjs`
from the checkout and verifies capabilities. It never searches `PATH`, never
starts a daemon, and never writes project memory.

Session open and pending-record adapters live in `tools/cursor-cloud/`. They are
repository bridges, not additional published host skills.

Copying the complete `packages/dubsar-project-continuity` directory into Cursor's
local plugin directory remains the optional adapter install for other projects.
Copying only `skills/` is not sufficient because adapters invoke the packaged
runtime.

## Product boundary

Hermes and the DUBSAR B2B Control Tower are separate products. Installing this
public package never starts MCP, a backend, a hook, a daemon, a reviewer
workflow, a deployment action, or a model request.

For non-host use, call the CLI directly as described in
[`docs/INTEGRATION.md`](docs/INTEGRATION.md).
