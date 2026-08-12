# `@dubsar/workbench-server`

This private package is the narrow local transport boundary for the DUBSAR
Workbench pilot. It accepts one already-rendered HTML `Buffer`, copies it, and
serves those exact bytes on one unguessable GET route bound to
`127.0.0.1:0`. Its interactive one-shot API also binds the response policy to
the renderer's exact HTML, script, and style digests; it admits only one
successful consumer and closes after that response finishes.

It has no filesystem access, outbound networking, environment access,
subprocess, persistence, browser launch, API route, or business logic. The
foreground session ends after five minutes without a successful page response,
after a non-resettable thirty-minute lifetime, or when its controller is
closed. The launcher-specific one-shot session expires after thirty seconds of
idle time or sixty seconds absolutely and is not a persistent service.

The URL is a local capability, not authentication against another process
running as the same OS user. It must not be logged, persisted, shared, or
published.
