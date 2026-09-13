# Codex / Herdr adapter (local)

This document describes the **local** Codex/Herdr path added to My Work. It is
not a second ticket product. Tickets remain `dubsar.tickets/1` in
`.dubsar/tickets.json`. Cursor receipts stay `dubsar.cursor-*-receipt/1`. Local
Codex receipts are a distinct contract and are never rewritten as Cursor
receipts.

## Protocol actually used (verified Herdr CLI)

## Protocol (Herdr host, Codex `--json` identity)

Herdr hosts the workspace/pane. It is **not** a durable session registry. Isolated
vendor observation: `herdr agent start … -- exec -- PROMPT` can succeed and
return `agent_started` (`result.agent`, argv, type) **without** `session_ref`.
After a short task, `agent get` is `agent_not_found` because the occupant name is
cleared on exit. Native Codex history still has `session_meta.id`. Do not treat
`agent_not_found` as a lost Codex session. Do not auto-approve dialogues, use
`--last`, recreate a missing session, or `workspace close`.

My Work therefore:

1. `herdr workspace create --cwd <authorized_realpath> --label <ticket> --no-focus`  
   `herdr_id` = `workspace_id/pane_id` from that JSON. Confinement is realpath, not
   MCP `cwd` alone.
2. Supervises **`codex exec --json -- <prompt>`** in that workspace (non-interactive).  
   Session identity is collected from structured events (`session_meta.id`) as
   soon as they are emitted. Prompt as argv; omitting it fails like vendor Codex.
3. Persists that identity in the existing My Work ticket **and** in a supervisor
   record under `allocation_root` (outside the Codex-writable workspace). No second
   ticket registry.
4. Continuation: **`codex exec resume <EXACT_ID> --json -- <prompt>`**  
   Same ticket and same id. Never `--last`.
5. Stop observes the **supervised process** (already finished / interrupted /
   unknown). Stop is never mission success. Unknown observation is ambiguous and
   does not relaunch.

### Qualification commands for Work (vendor binaries, isolated temp repo)

These are the candidate commands; running them on a real machine is a
`local_install` human gate. CI doubles do not replace them.

```bash
herdr workspace create --cwd "$TMP" --label DUB-001 --no-focus
codex exec --json -- "Write DIAG006_OK"
# expect NDJSON session_meta.id; a later `herdr agent get` may be agent_not_found
codex exec resume "$SESSION_ID" --json -- "second turn"
# never: codex exec resume --last
```

CI uses `tests/helpers/herdr-protocol/herdr.mjs` and
`tests/helpers/codex-protocol/codex.mjs` — protocol doubles, not vendor binaries.

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

CI uses protocol doubles via `DUBSAR_HERDR_BIN` and `DUBSAR_CODEX_BIN`. Green
CI is **simulated code qualification**, not a vendor-binary or VPS/Hermes
pilot. The Hermes → My Work → Codex/Herdr path remains a **mandatory**
qualification under `local_install` / `vm_cloud` gates — not abandoned.

## Public launch path

`launch_codex_mission` is the single public call: validate
`dubsar.codex-local-contract/1`, persist one `DUB-###` plus `codex_contract`,
trace argv, then exactly one Herdr workspace plus supervised `codex exec --json`
session.
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

- **BLOQUANT_LOT**: durable Codex identity from `exec --json` (not Herdr
  `session_ref` / `agent get`); supervisor stop observation; fixtures matching
  `agent_not_found` after short tasks — addressed in this correction.
- **Qualification restante (gates, pas abandon)**: binaires Herdr/Codex vendor,
  Hermes conteneur → MCP My Work → Codex, pilote VPS.
- **NON_PERTINENT**: UI, multi-user, providers, CI workflow edits, OAuth repair.
