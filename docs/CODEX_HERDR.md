# Codex / Herdr adapter (local)

This document describes the **local** Codex/Herdr path added to My Work. It is
not a second ticket product. Tickets remain `dubsar.tickets/1` in
`.dubsar/tickets.json`. Cursor receipts stay `dubsar.cursor-*-receipt/1`. Local
Codex receipts are a distinct contract and are never rewritten as Cursor
receipts.

## Protocol actually used (verified Herdr CLI)

Host-side My Work (never Hermes) drives Herdr with the published CLI:

Non-interactive **`codex exec` inside Herdr** needs the prompt **as an argument
at `agent start`**. A later `herdr agent prompt` is too late: Codex exits with
`No prompt provided. Either specify one as an argument or pipe the prompt into
stdin.`, Herdr reports startup timeout, then `agent get` is `agent_not_found`.
Do not “fix” that by lengthening `--timeout`. Do not auto-approve dialogues.
Do not `workspace close` or recreate a missing session.

1. `herdr workspace create --cwd <authorized_realpath> --label <ticket> --no-focus`  
   JSON: `.result.workspace.workspace_id`, `.result.root_pane.pane_id`, cwd.  
   The adapter refuses a cwd that is not the authorized realpath (confinement is
   not `process.cwd` of the MCP alone).
2. `herdr agent start <name> --kind codex --pane <pane_id> -- exec -- <prompt>`  
   Prompt is part of the Codex argv. Omitting it fails closed (no agent).
3. `herdr agent get <name>` captures the **native** Codex session reference.  
   `herdr_id` is `workspace_id/pane_id` from Herdr JSON, never a fabricated
   `herdr-local` / `herdr-DUB-*` constant.
4. Continuation (same session):  
   `herdr agent start <name> --kind codex --pane <same pane> -- exec resume <SESSION_ID> -- <prompt>`  
   A missing session is not recreated. Workspaces are never closed.
5. Stop: `herdr agent send-keys <name> ctrl+c` for **that** agent only.  
   Interrupted is recorded only with **positive proof**: `interrupted: true`
   and `process_exited: true` for the same session id. `running !== true` or a
   missing `running` field is not enough. A logging error still is not mission
   success.

Isolated protocol double (not vendor Herdr):

```bash
export DUBSAR_HERDR_BIN="$PWD/tests/helpers/herdr-protocol/herdr.mjs"
# after workspace create, bare exec must fail (no agent):
node "$DUBSAR_HERDR_BIN" agent start d001 --kind codex --pane <pane> -- exec
# launch with prompt at start:
node "$DUBSAR_HERDR_BIN" agent start d001 --kind codex --pane <pane> -- exec -- "mission text"
# continue same id:
node "$DUBSAR_HERDR_BIN" agent start d001 --kind codex --pane <pane> -- exec resume <SESSION_ID> -- "follow-up"
```

Vendor binary validation remains a `local_install` gate.

## Private Hermes transport (container → My Work on the host)

Hermes must not receive SSH, a general shell, `docker.sock`, or `herdr.sock`.

Host (outside the container):

```bash
node packages/dubsar-my-work-mcp/bin/dubsar-my-work-mcp.mjs \
  --profile hermes \
  --mcp-socket /run/dubsar/hermes.mcp.sock
```

`--mcp-socket` is refused unless the profile is `hermes`. Paths named
`docker.sock` or `herdr.sock` are rejected. The listener is a Unix domain
socket (Linux/macOS). Windows fails closed with
`MY_WORK_HERMES_SOCKET_UNSUPPORTED`. The socket speaks the same MCP JSON-RPC as
stdio (mission tools only). Herdr stays on the host process; Hermes only sees
My Work.

stdio remains valid:

```bash
node packages/dubsar-my-work-mcp/bin/dubsar-my-work-mcp.mjs --profile hermes
```

Wiring a Hermes **container** to that host socket (volume of the MCP socket
only, `--network none`, no Docker/Herdr sockets) is a **human** `local_install`
/ `vm_cloud` step. This repository qualifies the adapter and the socket
boundary; it does not prove a VPS or a live Hermes image.

## Linux development install

Prerequisites: Node.js 20+, Herdr on `PATH` (or `DUBSAR_HERDR_BIN`), Codex
integration (`herdr integration install codex`) for native session ids, a git
clone of `dubsar-memory`.

CI uses `tests/helpers/herdr-protocol/herdr.mjs` via `DUBSAR_HERDR_BIN` — a
protocol double, not the vendor binary. Green CI is **code qualification**, not a
VPS/Hermes pilot.

## Public launch path

`launch_codex_mission` is the single public call: validate
`dubsar.codex-local-contract/1`, persist one `DUB-###` plus `codex_contract`,
trace argv, then exactly one Herdr workspace + `codex exec` session.
Dedup: matching fingerprint reuses the ticket; a submitted launch without a valid
receipt is not retryable.

## What CI does not prove (gates)

| Gate | Status |
| --- | --- |
| `local_install` of vendor Herdr + Codex on a Linux machine | remaining |
| Hermes container attached only to `hermes.mcp.sock` | remaining |
| VPS / `vm_cloud` | remaining, human gate |
| Secrets, deployment, publication, merge | human gates |
| Real binary logging error on stop | remaining to observe on vendor Herdr |

Do not treat `npm test` as a VPS pilot.

## Findings

- **BLOQUANT_LOT**: prompt as `codex exec` argument at `agent start` (not a later
  `agent prompt`); stop requires positive `process_exited` for the targeted
  session — addressed in this correction.
- **REPORTE_POST_LOT**: vendor install, live Hermes image, VPS.
- **NON_PERTINENT**: UI, multi-user, providers, CI workflow edits, OAuth repair.
