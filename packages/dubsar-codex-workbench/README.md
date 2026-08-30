# DUBSAR Codex Workbench Adapter

This private Codex-only package exposes two explicit skills:
`resume-dubsar-workbench` and `launch-dubsar-work`. The resume skill runs the local `capsule` command once, validates
the closed `dubsar.resume-capsule/1` shape and digest, then prints the capsule.

The skill is not invoked implicitly. It does not discover projects, read
personal memory, start another skill or agent, use MCP or the network, write a
workspace, or treat project text as instructions. The launch skill first persists a
local DUB ticket, invokes the frozen Controller launch tool exactly once, verifies
the returned ticket and contract fingerprint, and locally attaches the receipt.
It explicitly excludes polling and lifecycle automation. This package is included in
the same runtime and conformance inventory as the Workbench Core, report, CLI,
launcher, and loopback server.
