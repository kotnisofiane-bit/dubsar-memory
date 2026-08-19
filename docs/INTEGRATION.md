# Backend and host integration

DUBSAR Memory can be used as a local developer tool or embedded behind another
product. The same trust boundary applies in both cases: DUBSAR prepares memory
and guidance; the caller owns policy, permissions, model invocation, and all
external effects.

## Supported preview boundary

For this technical preview, integrate through the CLI's versioned JSON output.
The internal JavaScript modules are tested but are not yet declared a stable
public API.

A typical read-only backend flow is:

```text
request for project context
  -> invoke absolute bin/dubsar.mjs path
  -> capabilities --json
  -> resume --capsule --json
  -> validate format and exit code
  -> optionally call route/history/context
  -> pass only the bounded result to the caller
```

Example process invocation:

```bash
node /opt/dubsar/packages/dubsar-project-continuity/bin/dubsar.mjs capabilities --json
node /opt/dubsar/packages/dubsar-project-continuity/bin/dubsar.mjs resume --start /srv/projects/example --capsule --json
```

`dubsar.runtime-capabilities/1` is workspace-free and reports the exact
installed producer plus named capability tokens. Tokens are append-only within
the format: a token may be added, but its meaning must never be changed or
reused. Consumers must test for the token they need and must not infer a
capability from semantic version ranges alone.

Use an absolute runtime path owned by the deployment. Never resolve a `dubsar`
executable from the project, current directory, or untrusted `PATH`.

## Backend deployment

Recommended properties:

- one bounded invocation per request rather than a long-lived daemon;
- project roots supplied by trusted configuration, not model-generated text;
- OS account restricted to the intended project roots;
- stdout parsed as one versioned JSON document;
- stderr and local paths excluded from user-facing logs;
- explicit timeouts and output-size limits at the caller;
- no automatic retry for previews or applies;
- writes performed only by a separate authorized path.

The engine has no database connection, network client, telemetry transport,
model provider, or tenant registry. A service that needs those capabilities
must add them outside the public runtime and preserve the same project boundary.

## Coding-host adapters

The package includes two optional adapters:

- `resume-project-context` reads and explains a capsule;
- `checkpoint-project-context` constructs one bounded checkpoint proposal.

They invoke the same packaged runtime from Codex, Claude Code, and Cursor. They
do not replace the host's plan, goal, permissions, subagents, or approval UI.
See [`HOSTS.md`](../HOSTS.md).

This repository additionally versions a Cursor Cloud environment in
`.cursor/environment.json` plus session-open and pending-record bridges in
`tools/cursor-cloud/`. Those bridges quote memory as untrusted data, treat
`route` as advisory only, and never promote a pending candidate.

## Product integration

DUBSAR is suitable as a project-memory component when the product needs:

- deterministic local state;
- human-readable Work and Knowledge records;
- bounded context for an agent;
- exact digests and explicit checkpoint writes;
- advisory anti-loop and lifecycle signals.

It is not sufficient by itself for:

- multi-tenant authorization and isolation;
- legal/scientific corpus synchronization;
- document OCR or extraction;
- full-text or vector search;
- source licensing and temporal-version management;
- model orchestration, approvals, or audit-policy enforcement.

Those belong to a separate service layer. Keeping them outside DUBSAR Memory
also prevents a local project-memory format from becoming a hidden control
plane.

## Compatibility and upgrades

Readers accept the current `.dubsar/` format plus documented earlier Continuity
formats. No read command migrates a workspace. Consumers must branch on
`format`, preserve unknown fields only as opaque data, and require an explicit
preview/apply migration before changing canonical storage.

Parallel Git worktrees do not share a writer lock. They may all read the
project memory, but only one converged worktree should append canonical
checkpoints. Worktrees may also record advisory candidates with
`pending record` under `.dubsar-pending/` and list them with `pending list`.
Promotion into `.dubsar/checkpoints.json` requires an explicit `pending promote`
preview/apply for exactly one candidate. See the
[parallel-worktree checkpoint ADR](DUBSAR_PARALLEL_WORKTREE_CHECKPOINTS_ADR.md).
