# Codex / Herdr adapter (local)

This document describes the **local** Codex/Herdr path added to My Work. It is
not a second ticket product. Tickets remain `dubsar.tickets/1` in
`.dubsar/tickets.json`. Cursor receipts stay `dubsar.cursor-*-receipt/1`. Local
Codex receipts are a distinct contract and are never rewritten as Cursor
receipts.

## Protocol (observed Herdr + Linux user scope)

Herdr hosts the workspace/pane. It is **not** a durable session registry. After a
short occupant exit, `herdr agent get` is `agent_not_found`. That is not Codex
session loss. Do not auto-approve dialogues, use `--last`, recreate a missing
session, or `workspace close`.

**`herdr exec` is not an established interface** of the installed Herdr. The
adapter must not invent it or treat forwarded CLI stdout as pane occupancy.

Observed primitives:

1. `herdr workspace create --cwd <authorized_realpath> --label <ticket> --no-focus`  
   `herdr_id` = `workspace_id/pane_id`.
2. `herdr pane run <PANE_ID> COMMAND` submits the command into that pane's
   terminal. It does not stream occupant stdout to the My Work process.
3. Occupant `--json` is collected separately:
   `herdr pane read --pane <PANE_ID> --source recent-unwrapped`
4. Live occupancy:
   `herdr pane process-info --pane <PANE_ID>` →
   `result.process_info.foreground_process_group_id`,
   `foreground_processes`, `shell_pid`.

Linux confinement of the occupant (Ctrl+C can orphan `bwrap`/Codex/`sleep`):

```bash
env XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" \
  systemd-run --user --scope --unit="<unique-execution-id>" \
  --property=KillMode=control-group --property=TimeoutStopSec=5s \
  codex exec --json -- "PROMPT"
```

Stop: `systemctl --user stop <scope>`. Proof is `ActiveState=inactive` /
`SubState=dead` and an empty foreground process list — not the Herdr client PID
returning to the shell. `XDG_RUNTIME_DIR` must already exist; it is not invented
and VPS UIDs are not hard-coded. Missing Herdr or systemd `--user` is
`MY_WORK_HERDR_UNAVAILABLE` / `MY_WORK_SYSTEMD_UNAVAILABLE` (no silent fallback).

Resume uses **`thread.started.thread_id`** from pane NDJSON. Native Codex
rollout `session_meta.payload.id` is a different identifier and is not the resume
key. Never `--last`.

`CODEX_HOME` / provider/auth of the service account are **inherited**. Supervisor
NDJSON and `codex-supervisor.json` live under `allocation_root`, outside the
writable workspace. Secrets are not copied.

An interrupt can surface a Codex warning about missing tool output. That is not
mission success.

### Qualification commands (vendor, isolated temp repo, human gate)

```bash
herdr workspace create --cwd "$TMP" --label DUB-001 --no-focus
herdr pane run "$PANE" env XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" \
  systemd-run --user --scope --unit="dubsar-mw-d001-trial.scope" \
  --property=KillMode=control-group --property=TimeoutStopSec=5s \
  codex exec --json -- "Write DIAG006_OK"
herdr pane read --pane "$PANE" --source recent-unwrapped
herdr pane process-info --pane "$PANE"
systemctl --user stop dubsar-mw-d001-trial.scope
herdr pane run "$PANE" env XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" \
  systemd-run --user --scope --unit="dubsar-mw-d001-resume.scope" \
  --property=KillMode=control-group --property=TimeoutStopSec=5s \
  codex exec resume "$THREAD_ID" --json -- "second turn"
```

Package helper (protocol doubles only unless env points at vendor binaries):

```bash
node tools/codex-herdr-qualify-candidate.mjs --simulate
```

`--simulate` is **not** a VPS or Hermes E2E proof.

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

## Linux development install

Prerequisites: Node.js 20+, Herdr on `PATH` (or `DUBSAR_HERDR_BIN`), Codex CLI
with the service-account `CODEX_HOME`, `systemd --user` available, and an
existing `XDG_RUNTIME_DIR`.

CI uses protocol doubles (`DUBSAR_HERDR_BIN`, `DUBSAR_CODEX_BIN`,
`DUBSAR_SYSTEMD_RUN_BIN`, `DUBSAR_SYSTEMCTL_BIN`). Green CI is **simulated code
qualification**, not a vendor-binary, Hermes-container, or VPS pilot.

## Public launch path

`launch_codex_mission` is the single public call: validate
`dubsar.codex-local-contract/1`, persist one `DUB-###` plus `codex_contract`,
trace argv, then exactly one `herdr workspace create` plus `herdr pane run`
of the systemd-scoped `codex exec --json`. Dedup: matching fingerprint reuses
the ticket; a submitted launch without a valid receipt is not retryable.

## What CI does not prove (gates)

| Gate | Status |
| --- | --- |
| `local_install` of vendor Herdr + Codex + systemd --user | remaining |
| Hermes container attached only to `hermes.mcp.sock` | remaining |
| VPS / `vm_cloud` | remaining, human gate |
| Secrets, deployment, publication, merge | human gates |
| Vendor logging warning after interrupt | remaining to observe |

Do not treat `npm test` or `--simulate` as a VPS pilot.

## Findings

- **BLOQUANT_LOT**: `herdr exec` n’est pas une primitive établie — this correction
  uses `pane run` / `pane read` / `process-info` and a systemd `--user` scope.
- **Qualification restante (gates, pas abandon)**: binaires vendor, Hermes
  conteneur → MCP My Work → Herdr pane → Codex configuré, pilote VPS.
- **NON_PERTINENT**: UI, multi-user, providers, CI workflow edits, OAuth.
