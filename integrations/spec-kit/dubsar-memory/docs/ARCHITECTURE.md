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

The extension ships the sealed DUBSAR **JavaScript** runtime under `runtime/`,
and the status script resolves it from its own location:

```js
path.join(here, "..", "runtime", "bin", "dubsar.mjs")
```

Never through `PATH`. A `dubsar` binary found on `PATH` could be anything; a
runtime shipped inside the artifact is the one that was reviewed and sealed.

This is not an embedded Node binary. The host must provide `node` ≥ 20, as
declared under `requires.tools` in `extension.yml`. The packaged files are the
DUBSAR continuity CLI and its modules; they are executed with the system Node.

The extension source in this repository contains **no copy** of the runtime.
`tools/build-spec-kit-extension.mjs` copies it in at packaging time, verifying
each file against `FILES.sha256.json` on the way, so there is one source of
truth and a build fails loudly if the package drifts.

## Spec Kit root isolation

The general DUBSAR locator may walk parent directories until it finds `.dubsar`
or `.dubsar-project` (or hits a `.git` boundary). That remains useful for
ordinary DUBSAR checkouts.

The Spec Kit status adapter is stricter. It treats the directory that owns the
nearest `.specify/` as the only allowed `project_root`. If locate returns a
workspace whose `project_root` is not exactly that directory, the adapter
reports `dubsar.present: false` with `reason: WORKSPACE_NOT_FOUND`, exposes no
foreign `project_id` / mission / path, and does not spawn `resume`, `route`, or
`precedents` against the ignored workspace. Explicit `init` must target that
same Spec Kit root so `.dubsar/` is created beside `.specify/`, not in a parent.

Cursor skills installed for this extension are provided by Spec Kit's extension
registry integration. Their absence from `cursor-agent.manifest.json` (which
lists core Spec Kit skills) is expected, not a packaging defect.

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
