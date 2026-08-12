# DUBSAR Workbench Report

This package renders an existing `dubsar.workbench-view/1` object as one
deterministic HTML document. The historical default remains script-free. An
explicit interactive renderer adds a standalone Dashboard and Canvas graph for
direct `file://` use without a runtime server or network dependency.

The renderer is pure: it does not locate a workspace, read a file, write a
file, open a browser, access the network, inspect the environment, or launch a
process. Local values are inserted only as escaped text nodes in a fixed HTML
shell. The output is a derived `local_preparation_record`, never an audit
result, certification, or approval.

The read-only CLI exposes the renderer through stdout:

```text
node packages/dubsar-operator-cli/bin/dubsar.mjs report --domain project --start .
```

The interactive format is opt-in and has a distinct manifest:

```text
node packages/dubsar-operator-cli/bin/dubsar.mjs report --interactive --domain project --start .
```

`dubsar.workbench-interactive-report/2` embeds only closed presentation
projections: the sanitized `dubsar.workbench-view/1`, the semantic
`dubsar.workbench-graph/1`, and optionally bounded previews from an explicit
personal-memory snapshot. It never embeds raw canonical workspace JSON or file
paths. The graph connects mission, lots, contract, evidence, decisions, and
blockers; a native deterministic force simulation makes those relationships
draggable, zoomable, and explorable without a third-party library.

The constant CSS and JavaScript blocks are authorized by exact CSP hashes. The
document performs no request, storage access, navigation, canonical write, or
background service. The Dashboard remains readable if JavaScript is
unavailable; JavaScript only switches views and powers the bounded Canvas
interactions.

An explicit `report --reviews` call adds the separate, sanitized Advisory
Review Ledger projection and returns a distinct
`dubsar.review-ledger-report/1` manifest. The canonical report remains complete
and commands without `--reviews` keep their historical bytes.

`--json` emits only the deterministic report manifest. If a caller chooses to
save the HTML, file creation and collision policy remain the caller's explicit
responsibility; this package and the CLI never write the file themselves.
