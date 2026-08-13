# Public boundary

This repository contains the public DUBSAR Memory engine and its first local
developer workflow, DUBSAR Continuity.

## Included

- the dependency-free Memory/Continuity runtime and CLI;
- two optional resume and checkpoint host adapters;
- deterministic project views and resume capsules;
- the `.dubsar/` Work, Knowledge, checkpoints and local-selection model for new projects;
- read compatibility for two-file Continuity Lite and unchanged legacy workspaces;
- the local read-only Workbench and Windows launcher;
- optional personal memory with a separate fixed local root and no project
  authority;
- synthetic fixtures, tests, inventories, and conformance gates.

## Excluded

- the private DUBSAR B2B Core and Control Tower;
- Hermes orchestration and production agent governance;
- Audit Readiness and Local Operator from the active marketplace and release
  registry. Historical Audit Readiness sources remain frozen for compatibility
  tests and are not an active product;
- MCP servers, hooks, connectors, network services, billing, and deployment;
- mandatory reviewers, challengers, subagents, or review waves;
- private routing topology, weights, scoring, and governance structures;
- claims of certification, compliance, approval, or completed work.

## Authority

Project files are the only project authority. Capsules, routes, dashboards,
personal memory, and agent summaries are derived or advisory. They never
authorize an execution, merge, publication, or deployment.

The runtime is offline. Read commands do not modify projects. Initialization,
migration, Work, Knowledge, checkpoint and generated-context writes require a
byte-specific preview and explicit confirmation. Each steady-state apply
changes one file. Migration publishes one new directory atomically and retains
the old workspace. Personal memory is opt-in, stored separately, and never
influences project readiness or routing.

The runtime never writes `AGENTS.md`, `CLAUDE.md`, Cursor rules, Git hooks, or
branch metadata. Native Plan, Goal and subagent capabilities remain under the
host and user; DUBSAR can only emit bounded advisory recommendations.

## Provenance

No code from internal experiments or private DUBSAR products is copied into
this public branch. Conceptual provenance and the clean-room boundary are
recorded in `docs/CONCEPTUAL_PROVENANCE.md`.
