# DUBSAR Operator CLI

This development CLI exposes the read-only Operator Core through `locate`,
`status`, `resume`, `validate`, `doctor`, `reviews`, `report`, `ui`, `catalog`,
`capsule`, `history`, `lots`, and `precedents`. It also exposes the explicit
`checkpoint` writer plus the human-only `close` and `memory` flows. JSON output never includes the
absolute workspace root, canonical documents, artifact content, credentials,
or personal memory.

```bash
node packages/dubsar-operator-cli/bin/dubsar.mjs status --start . --json
node packages/dubsar-operator-cli/bin/dubsar.mjs ui --start . --domain project
node packages/dubsar-operator-cli/bin/dubsar.mjs reviews --start . --domain project
node packages/dubsar-operator-cli/bin/dubsar.mjs ui --reviews --start . --domain project
node packages/dubsar-operator-cli/bin/dubsar.mjs catalog --registry C:\path\to\projects.json --json
node packages/dubsar-operator-cli/bin/dubsar.mjs capsule --registry C:\path\to\projects.json --project project-id --json
node packages/dubsar-operator-cli/bin/dubsar.mjs resume --start . --domain project --capsule --json
node packages/dubsar-operator-cli/bin/dubsar.mjs history --start . --json
node packages/dubsar-operator-cli/bin/dubsar.mjs lots --start . --json
node packages/dubsar-operator-cli/bin/dubsar.mjs precedents --start . --lot lot-id --json
node packages/dubsar-operator-cli/bin/dubsar.mjs checkpoint --start . --proposal C:\path\to\proposal.json --json
node packages/dubsar-operator-cli/bin/dubsar.mjs close --start .
node packages/dubsar-operator-cli/bin/dubsar.mjs memory init
```

The CLI does not initialize a workspace, open a browser, launch an agent, or
contact an external network service. The `checkpoint` engine is the only canonical writer:
preview is read-only, and apply requires the exact preview digest before it
atomically replaces only `evidence.json` or `lots.json`. `close` is an
interactive TTY frontend to an evidence-only checkpoint; it never transitions
a lot. Personal-memory writes target only the fixed Windows private root and
are implemented by the separate `@dubsar/personal-memory` package. `report` emits deterministic
script-free HTML on stdout; `report --json` emits only its byte count, SHA-256
digest, renderer identity, and source snapshot digest.

The separate private `@dubsar/workbench-launcher` package owns the explicit
double-click workflow that regenerates the standalone interactive HTML and
opens Chrome. Keeping that effect boundary separate preserves this CLI's
read-only contract.

`ui` is the only inbound-network exception. It snapshots and renders before
listen, then serves only that immutable HTML on a random IPv4 loopback port and
unguessable path. It prints the URL once, installs no daemon, and stops on a
signal, five minutes of inactivity, or a thirty-minute absolute lifetime.

The Review Ledger is explicit opt-in. `reviews`, `report --reviews`, and
`ui --reviews` read the bounded advisory receipt projection only after the
canonical snapshot succeeds. Review data never changes canonical integrity,
readiness, blockers, next action, or exit status. Commands without the option
remain byte-compatible and never enumerate `reviews/**`.

`catalog` reads only the explicitly supplied, closed registry and isolates an
unavailable project from the others. `capsule` emits one digest-verified,
path-free resume capsule no larger than 8 KiB. Neither command writes files,
discovers projects, reads personal memory, or contacts a network.

`resume --capsule` emits `dubsar.resume-capsule/2` for the current project. It
includes only bounded mission, active-lot, decision, blocker, freshness, and
next-action data. Artifact paths, raw files, personal memory, logs, secrets, and
reviewer text are excluded.

`history` exposes stable append indexes without claiming timestamps. `lots`
lists active, eligible, blocked, waiting, complete, and unknown packages but
never ranks or selects one. `precedents` returns at most three exact matches
from the current project only; zero matches is normal.
