# Host installation

DUBSAR Continuity ships the same two active skills and the same local runtime
for Codex, Claude Code, and Cursor. Host manifests add no hooks, network
connections, background services, or execution authority.

## Requirements

- Node.js 20 or newer;
- a complete local copy of `packages/dubsar-project-continuity`;
- no global `dubsar` command.

Skills resolve `bin/dubsar.mjs` from their installed plugin root, never from
`PATH` or project content.

## Claude Code

Add the repository as a local marketplace and install
`dubsar-project-continuity`. The plugin exposes only
`resume-project-context` and `checkpoint-project-context`.

## Codex

Add the repository root as a local marketplace, inspect the package, install
it, then restart Codex. Native Codex planning, goals, and subagents remain
independent of DUBSAR.

## Cursor

Copy the complete `packages/dubsar-project-continuity` directory into Cursor's
local plugin directory, then reload the window. Do not copy only `skills/`:
the skills require the packaged runtime.

## Non-goals

Hermes belongs to the separate DUBSAR B2B ecosystem and is not an installation
target of this public developer product. Installing this package never starts
MCP, a backend, a hook, a daemon, a reviewer workflow, or a deployment action.
