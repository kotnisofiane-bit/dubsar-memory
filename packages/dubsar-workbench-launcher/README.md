# DUBSAR Workbench Launcher

This private local package is the explicit effect boundary for the Workbench.
It stores an explicit local project registry at
`%LOCALAPPDATA%\DUBSAR\Workbench\projects.json`, regenerates one self-contained
HTML5 fallback report in that directory, then opens the exact bytes in Google Chrome.
The first launch opens the fixed Windows folder picker when the registry is
empty. The management entry can add, remove, list, or verify up to 16 roots.

The launcher is separate from `@dubsar/operator-cli`: the CLI remains
stdout-only and read-only. The launcher alone may create its fixed output
directory, atomically replace the registry or report, and start Chrome without a shell.
By default it uses the separate Workbench server on capability-bound
`127.0.0.1` routes for both direct `--start` and registered-project launches.
It has no outbound network
client, backend, MCP connection, canonical writer, daemon, or background
service. `--file` preserves direct-file opening as an explicit fallback.

The default Continuity Dashboard never includes personal memory. Each invalid
or missing root is shown as unavailable without hiding the other projects, and
no local root is embedded in the HTML. A direct `--start` launch builds the same
Dashboard for one ephemeral project entry; it does not alter the saved registry.

Registered-project launches open Chrome in guest mode so ordinary extensions
and history are not part of the report path. Direct `--start` launches open the
loopback URL in normal Chrome so local developer tools and explicitly installed
browser extensions remain available. The URL token is never included in
the result envelope or logs. A successful launch means the exact response was
handed to Chrome's transport; it does not claim that Chrome rendered every
pixel. The live session closes after the Dashboard heartbeat disappears or its
absolute lease expires; reopen the launcher to start a new session.

The historical personal-memory report is used only when `--memory-root` is
supplied explicitly. Capture is
limited to the five fixed Markdown files and the report marks it as private,
advisory data with a digest separate from canonical project evidence.
