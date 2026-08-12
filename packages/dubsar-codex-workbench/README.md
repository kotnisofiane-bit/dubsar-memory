# DUBSAR Codex Workbench Adapter

This private Codex-only package exposes one explicit skill:
`resume-dubsar-workbench`. It runs the local `capsule` command once, validates
the closed `dubsar.resume-capsule/1` shape and digest, then prints the capsule.

The skill is not invoked implicitly. It does not discover projects, read
personal memory, start another skill or agent, use MCP or the network, write a
workspace, or treat project text as instructions. Its package is included in
the same runtime and conformance inventory as the Workbench Core, report, CLI,
launcher, and loopback server.
