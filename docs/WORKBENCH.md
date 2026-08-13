# Workbench guide

The DUBSAR Workbench is an optional technical Dashboard for inspecting project
continuity. It is useful for debugging and portfolio review; it is not required
to use the memory engine.

## Open a project

From the repository root on Windows:

```powershell
npm run workbench:open -- --start "C:\path\to\project"
```

The launcher starts the existing local loopback server on an ephemeral port,
opens Chrome, and prints a bounded launch result. Keep the launcher terminal
open. Closing it ends the local session.

For a persistent local project list:

```powershell
npm run workbench:manage
```

The manager can register project roots for the local launcher. Registration is
Workbench configuration; it does not write project memory.

## Views

### Resume

Shows the selected Work, recorded state, next action, blockers, linked
Knowledge, advisory Plan/Goal guidance, and snapshot identity. The displayed
route never authorizes execution.

### Memory

Shows Work packages, project health, linked Knowledge, and recent recorded
activity. Recent activity is append order, most recently recorded first; it is
not presented as a real-world chronology unless the source explicitly records
time.

### Graph

Shows only bounded project relationships. For a trivial graph, the accessible
relationship list is the default and Canvas is opt-in. Graph layout does not
rank Work or prove causal relevance.

## Read-only guarantee

The Dashboard consumes a projection produced from one project inspection. It
does not read `.dubsar/` files independently, write project files, read Inbox
content, expose personal memory, or call a writer. Live refresh replaces a
project projection only after format, data digest, project identity, and all
snapshot bindings validate together.

All canonical changes still go through the CLI preview/apply workflow or the
human interactive `close` command.

## Troubleshooting

### `LAUNCHER_UNEXPECTED_FAILURE`

Run the command from the repository root after `npm ci`. If the failure
persists, run the targeted launcher tests and keep the original JSON code:

```powershell
npm run test:launcher
```

### npm cannot find `package.json`

PowerShell is in the wrong directory. Change to the cloned repository before
running an npm script.

### `file://` opens instead of loopback HTTP

Use `npm run workbench:open`. Current live Workbench sessions use a tokenized
`http://127.0.0.1:<ephemeral-port>/...` URL. Static `file://` reports are
historical output and do not provide live refresh.

### The Workbench is unavailable but CLI reads work

Treat the CLI as the source integration boundary. The Dashboard is optional;
its failure must not alter or invalidate canonical project memory.
