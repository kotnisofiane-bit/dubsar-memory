# CLI reference

Invoke the runtime with an absolute or repository-relative path:

```bash
node packages/dubsar-project-continuity/bin/dubsar.mjs <command> --start <project> --json
```

Node.js 20 or newer is required. The CLI never depends on a global `dubsar`
binary.

## Read commands

| Command | Result |
|---|---|
| `resume --capsule` | Bounded, digest-verified resume capsule. |
| `route` | Advisory memory route, exact relations, lifecycle, and optional native Plan/Goal guidance. |
| `context` | Compiled project context; no write unless `--write` is explicit. |
| `history` | Append-order recorded continuity, paginated. |
| `work list` | Work items and recorded states. |
| `knowledge list` | Project Knowledge entries. |
| `knowledge show --knowledge <id>` | One Knowledge entry. |
| `inbox list` | Local Inbox metadata with bounded/redacted previews. |
| `precedents` | Exact-only matches for an explicit Work/lot or reference selector. |
| `lots` | Compatibility Work-package view for supported older workspaces. |

Read commands do not write the project, host profile, Git metadata, or personal
memory.

## Explicit write commands

| Command | Target |
|---|---|
| `init --proposal <file>` | Creates one `.dubsar/` directory atomically. |
| `work create --proposal <file>` | Creates one Work Markdown file. |
| `work select --work <id>` | Updates local worktree selection only. |
| `work status --work <id> --to open|paused|complete` | Updates one Work status. |
| `inbox add --proposal <file>` | Adds one local advisory note. |
| `inbox promote --proposal <file>` | Creates one approved Knowledge entry from an explicit proposal. |
| `knowledge retire --knowledge <id>` | Retires one Knowledge entry. |
| `checkpoint --proposal <file>` | Appends one canonical checkpoint. |
| `context --write` | Writes only `.dubsar/generated/context.md`. |
| `migrate --to-memory-vnext` | Creates `.dubsar/` and retains the valid Lite source unchanged. |
| `close` | Human interactive checkpoint workflow. |

Except for interactive `close`, write commands first return a deterministic
preview. Apply only after checking `change_sha256`:

```bash
<command> --json
<command> --apply --expected-change <change_sha256> --json
```

The runtime re-inspects live state before apply. A stale digest, concurrent
change, unsafe path, unexpected file type, malformed proposal, or operation
mismatch is rejected without an automatic retry.

## JSON conventions

- every result has a versioned `format`;
- canonical digests are lowercase SHA-256 strings;
- identifiers follow closed grammars and are not display text;
- timestamps are not invented when the source does not contain one;
- zero history or zero exact matches is a normal result;
- advisory actions include `auto_execute:false`.

Do not parse human terminal text when `--json` is available. Treat unknown
formats as unsupported rather than guessing their meaning.

## Exit behavior

- `0`: command completed or preview produced;
- `1`: validation, concurrency, filesystem, or contract error;
- `2`: invalid invocation or an interactive command used outside a TTY;
- `130`: human cancellation or interruption of an interactive workflow.

Consumers should fail closed on any non-zero code and should not retry a write
automatically.
