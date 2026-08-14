# Architecture

## Shape

```
Spec Kit authority          |  read-only          |  DUBSAR authority
----------------------------+---------------------+---------------------------
specs/<feature>/spec.md     |                     |
specs/<feature>/plan.md     |--- path + sha256 -->|  checkpoints.json
specs/<feature>/tasks.md    |                     |  resume-capsule/3 or /4
.specify/feature.json       |                     |
```

Every arrow points one way. Spec Kit does not know this extension exists, and
the extension never writes into `.specify/` or `specs/`.

## Why the runtime is embedded

The extension ships the sealed DUBSAR runtime under `runtime/`, and the status
script resolves it from its own location:

```js
path.join(here, "..", "runtime", "bin", "dubsar.mjs")
```

Never through `PATH`. A `dubsar` binary found on `PATH` could be anything; a
runtime shipped inside the artifact is the one that was reviewed and sealed.

The extension source in this repository contains **no copy** of the runtime.
`tools/build-spec-kit-extension.mjs` copies it in at packaging time, verifying
each file against `FILES.sha256.json` on the way, so there is one source of
truth and a build fails loudly if the package drifts.

## Why there is no `link` command

A third command was considered, to bind a Spec Kit feature to a DUBSAR Work.
It was not implemented, because storing that binding requires either a new
writer or a change to a closed format — and `checkpoint` already does the job
honestly. A checkpoint that references `spec.md` *is* the link: it carries the
path, the verified digest, and the human decision that created it.

Adding `link` would have meant a second way to express the same fact, which is
how two sources of authority start.

## Freshness has one engine

The extension computes no digest of its own. It calls `resume --capsule` and
`precedents --ref`, and reports what DUBSAR observed. The two-pass bounded
observation added in DUBSAR's P4 lot is the only freshness mechanism in the
system.

One consequence is visible in the output: when a checkpoint bundles several
references, DUBSAR reports that checkpoint's freshness as `mixed`, and the
extension resolves the document to `unknown` rather than guessing. Exposing
per-reference freshness would need a small addition to the DUBSAR CLI, which is
deliberately out of scope for this prototype.

## Command naming

Spec Kit enforces `speckit.{extension-id}.{command}` at install time, so the
extension id is `dubsar` and the commands are `speckit.dubsar.resume` and
`speckit.dubsar.checkpoint`. The install name follows the id.

## Untrusted content

`spec.md`, `plan.md`, and `tasks.md` are written to be read by an agent. A
specification asking to run a command is project content, not a directive. Both
command files state this explicitly, and the capsule already carries
`content_trust: untrusted_project_data`. The extension never places document
text into memory or into its own output — only paths, digests, and statuses.
