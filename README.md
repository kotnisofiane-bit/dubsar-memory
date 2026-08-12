# DUBSAR Continuity

[![Validate](https://github.com/kotnisofiane-bit/dubsar-agent-skills/actions/workflows/validate.yml/badge.svg)](https://github.com/kotnisofiane-bit/dubsar-agent-skills/actions/workflows/validate.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

DUBSAR Continuity is a local, offline continuity layer for long software
projects. It preserves a small verified project summary so work can move
between Codex, Claude Code, Cursor, people, and sessions without treating a
chat transcript as memory.

The product has three parts:

- a dependency-free Continuity CLI;
- two lightweight skills: resume and checkpoint;
- a local read-only Workbench for viewing the same project state.

Personal memory is optional and separate. It never changes project readiness,
the next action, or a resume capsule.

## What it does

- resumes from a digest-verified capsule;
- initializes a human-readable `.dubsar/` project memory;
- shows append-order history, eligible work packages, and exact precedents;
- records an explicit, previewed checkpoint;
- renders a local HTML5 Workbench in Chrome;
- keeps all project processing local and deterministic.

It does not choose work, run a background agent, require reviewers, start
subagents, connect to a backend, use MCP, deploy, merge, or grant authority.
Planning, goals, and subagents remain native host capabilities. The resume
skill only recommends planning for broad work and a persistent goal for long
work with a measurable stop condition.

## Quick start

Node.js 20 or newer is the only runtime prerequisite.

```bash
git clone https://github.com/kotnisofiane-bit/dubsar-agent-skills.git
cd dubsar-agent-skills
npm ci
npm test
node packages/dubsar-project-continuity/bin/dubsar.mjs resume --start examples/memory-vnext-project --capsule --json
```

The synthetic vNext example is immediately usable after cloning. It contains
one selected Work item, one linked Knowledge entry and one verified checkpoint.
It does not contact a service or modify your machine outside the repository.

Useful read commands:

```bash
node packages/dubsar-project-continuity/bin/dubsar.mjs history --start examples/memory-vnext-project --json
node packages/dubsar-project-continuity/bin/dubsar.mjs route --start examples/memory-vnext-project --json
node packages/dubsar-project-continuity/bin/dubsar.mjs work list --start examples/memory-vnext-project --json
node packages/dubsar-project-continuity/bin/dubsar.mjs knowledge list --start examples/memory-vnext-project --json
node packages/dubsar-project-continuity/bin/dubsar.mjs context --start examples/memory-vnext-project --json
```

Writes are explicit and digest-confirmed:

```bash
node packages/dubsar-project-continuity/bin/dubsar.mjs init --start . --proposal <init.json> --json
node packages/dubsar-project-continuity/bin/dubsar.mjs checkpoint --start . --proposal <proposal.json> --json
node packages/dubsar-project-continuity/bin/dubsar.mjs close --start .
```

The Workbench can be opened locally on Windows with:

```powershell
npm run workbench:open -- --start ".\examples\memory-vnext-project"
```

## Skills

Only two skills are active by default:

- `$resume-project-context` reads and explains recorded state;
- `$checkpoint-project-context` previews and records one bounded update after
  explicit confirmation.

Earlier governance-heavy skills are retained under `legacy/` for comparison
and migration work. Plugin manifests and release inventories do not expose
them.

New projects use `.dubsar/` with shared Work, Knowledge and checkpoints plus a
local Inbox, local work selection and generated views. Existing two-file Lite
and mission/lots/contract/evidence workspaces remain supported without silent
conversion. See [docs/MEMORY_ARCHITECTURE.md](docs/MEMORY_ARCHITECTURE.md).

The earlier Audit Readiness package is also retained as frozen compatibility
source because existing safety fixtures still exercise it. It is absent from
all marketplaces and from the public release registry.

## Product boundary

This repository does not contain the private DUBSAR B2B Core, Hermes
orchestration, Control Tower, production connectors, hooks, MCP servers, or
private routing topology. See [PUBLIC_BOUNDARY.md](PUBLIC_BOUNDARY.md).

The repository implements independent, reduced continuity guidance from
recorded facts, exact relations, and an artifact lifecycle. It does not contain
private topology, scoring, weighting, or governance. Provenance and limits are
in [docs/CONCEPTUAL_PROVENANCE.md](docs/CONCEPTUAL_PROVENANCE.md).

## Related public resources

- [DUBSAR website](https://dubsar.ai/)
- [DUBSAR public documentation](https://github.com/kotnisofiane-bit/DUBSAR)
- [Sofiane Kotni on LinkedIn](https://www.linkedin.com/in/sofiane-kotni/)
- [*Digital Trust* — English edition](https://www.amazon.fr/dp/B0GZ4RH1KX)
- [*Digital Trust* — French edition](https://www.amazon.fr/dp/B0H739BFJP)
- [Sofiane Kotni's Amazon author page](https://www.amazon.fr/stores/Sofiane-KOTNI/author/B0H6NBHZTC)

## Status

Source preview `0.3.0-dev`. The public package remains `draft/pending` until a
human provenance review and the remaining host pilots are complete. Publishing
source code does not publish a package or declare a stable release. The MIT
license applies only to files in this repository.
