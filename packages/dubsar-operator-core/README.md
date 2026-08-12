# DUBSAR Operator Core

This development package is the deterministic, read-only core of the local
DUBSAR Workbench. It is separate from the `dubsar-local-operator` Agent Skills
bundle and has no runtime dependency, network access, subprocess execution,
environment access, HTTP server, MCP server, host adapter, or canonical writer.

The pipeline is deliberately one-way:

```text
locate -> bounded byte snapshot -> domain evaluation -> dubsar.workbench-view/1
```

`inspectWorkspace` remains the canonical-only default and never enumerates
`reviews/**`. The separate `inspectWorkspaceWithReviews` API performs that same
single canonical capture first, then optionally reads the exact-depth local
receipt tree into a deeply frozen `dubsar.review-ledger-view/1` companion. The
companion is advisory: its available, degraded, or unavailable state never
changes canonical integrity, readiness, blockers, next action, formats, or
errors.

The Review Ledger validates and reduces receipt fields before returning them,
uses deterministic receipt-set and projection digests, and exposes only closed
diagnostics. It does not write, import a recorder, dereference evidence, invoke
a reviewer or model, read personal memory, inspect environment state, start a
process, or access a network. Its filesystem identity checks are bounded,
observational, and fail closed; they are not a kernel-grade guarantee against a
privileged actor racing and restoring an entire directory tree.

Every canonical JSON file is captured once through a file handle. The raw
bytes used for parsing also produce the file and root digests. Audit artifacts
are captured under separate per-file, count, and aggregate limits, but their
content is never copied into the read model.

The first implementation uses Node ESM with JSDoc-compatible contracts so the
runtime stays dependency-free on Node 20. Handwritten declaration files are
intentionally avoided. A pinned development-only TypeScript checker may be
added after the domain contracts stabilize; it must not become a runtime
dependency.
