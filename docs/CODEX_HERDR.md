# Codex / Herdr adapter (local)

This document describes the **local** Codex/Herdr path added to My Work. It is
not a second ticket product. Tickets remain `dubsar.tickets/1` in
`.dubsar/tickets.json`. Cursor receipts stay `dubsar.cursor-*-receipt/1`. Local
Codex receipts are a distinct contract and are never rewritten as Cursor
receipts.

## Protocol actually used

Manual observation (outside this lot) showed:

1. `codex exec` starts one session in an authorized workspace.
2. `codex exec resume <SESSION_ID>` resumes **that** session after disconnect
   or process stop.
3. Files and session identity survive disconnect and interrupt.
4. A logging error at stop was observed on the real host. A stop result is
   **not** mission success.

This repository's adapter traces the argv **before** spawn, then issues exactly
one `exec` or one `exec resume <id>`. It does **not**:

- close a homonym workspace;
- recreate a missing session;
- auto-approve a Codex dialogue;
- retry after an ambiguous result;
- treat `PROOF.md` or an agent declaration as success.

## Linux development install (this lot)

Prerequisites: Node.js 20+, a git clone of `dubsar-memory`.

```bash
node packages/dubsar-my-work-mcp/bin/dubsar-my-work-mcp.mjs --profile hermes
```

Default profile keeps Cursor tools. Hermes profile exposes only:

- `list_tickets`
- `get_ticket`
- `launch_codex_mission`
- `continue_codex_mission`
- `stop_codex_mission`

No SSH, arbitrary shell, Docker socket, or Herdr socket is published to
Hermes.

Tests use a fake executor (`DUBSAR_CODEX_EXECUTOR=fake` or the in-process test
hook). They do **not** prove a VPS, a container Hermes, or a real Codex binary.

## Public launch path

`launch_codex_mission` is the single public call: it validates
`dubsar.codex-local-contract/1`, persists one `DUB-###` ticket plus a
`codex_contract` intention, traces the command, then starts exactly one Codex
session through the configured executor. Dedup is bounded: a matching
fingerprint reuses the ticket; a submitted launch without a valid receipt is
not retryable.

`get_ticket` after restart returns the contract, activity, authorized
workspace, Herdr id, and Codex session id.

`continue_codex_mission` resumes by the persisted Codex id only.

`stop_codex_mission` interrupts that execution, keeps files and history, and
always reports `mission_success: false`.

## Gates still remaining (real Hermes / VPS pilot)

The following are **not** proven by mocks or this repository's CI:

| Gate | Status |
| --- | --- |
| `local_install` of Codex CLI + Herdr on a Linux machine | remaining |
| Hermes container wired to this stdio MCP | remaining (no E2E Hermes in this lot) |
| Real `codex exec` / `codex exec resume` on that host | remaining |
| VPS / `vm_cloud` | remaining, human gate |
| Secrets, deployment, publication, merge | human gates, out of this lot |
| Logging-error-on-stop on the real binary | remaining to observe |

Do not treat a green `npm test` as a VPS pilot.

## Findings classification used in this lot

- **BLOQUANT_LOT**: missing ticket identity, Cursor receipt falsification, silent new session, Hermes socket exposure. Addressed in code.
- **REPORTE_POST_LOT**: real Codex/Herdr install, Hermes container, VPS, stop-logging on the real binary.
- **NON_PERTINENT**: UI refactor, multi-user, new providers, CI workflow edits, memory migration.
