# My Work MCP (local stdio)

The local My Work MCP is a closed stdio server for ChatGPT Work. ChatGPT Work
calls **`launch_cursor_mission` once** to persist one `DUB-###` ticket and issue
exactly one remote `create_dubsar_work_cursor_agent` request. Later follow-ups
use **`continue_cursor_mission`**, which issues exactly one
`create_dubsar_work_cursor_agent_run` request. Work does not call Cursor MCP
separately and does not expose the Controller tool names as My Work tools.

`contract_fingerprint` and `receipt_bounds` stay local. The Controller receives
only the existing `prepare_cursor_mission.arguments` object on launch, and the
same persisted arguments plus `agent_id`, `correction_number`, and `prompt` on
continuation.

New contracts send `correction_budget: "uncapped"` and expect Controller PR26
launch receipt bounds that also contain `correction_policy: "uncapped"`.
`continue_cursor_mission` retransmits that persisted contract with
`correction_budget: "uncapped"` and a caller-supplied positive
`correction_number` (including 4 and 5). It never allocates a ticket, never
calls `create_dubsar_work_cursor_agent` again, and never invents an agent,
branch, or PR. Legacy numeric budget `3` tickets remain readable; continuation
refuses them with `MY_WORK_CORRECTION_BUDGET_CAPPED` and does not rewrite them
to uncapped.

Controller run receipts (`dubsar.cursor-run-receipt/1`) keep the same
`agent_id` and contract fingerprint, add `bounds.correction_number`, and are
recorded beside the initial launch receipt. Receipt shape for those run
receipts is taken from the Codex GitHub observation of Controller
`createDubsarWorkCursorAgentRun` (reader SHA
`9ea48ce17735b6585cf5816060afc4345b1a50cf`); this session did not read that
private repository.

## Start

```bash
node packages/dubsar-my-work-mcp/bin/dubsar-my-work-mcp.mjs
```

Framing is MCP 2024-11-05 stdio: newline-delimited JSON-RPC on stdin/stdout.
`Content-Length` frames are still accepted for compatibility.

## Connect the Controller (local CLI)

Credentials are stored only on this machine, never in the repository:

`DUBSAR_MY_WORK_CONFIG_DIR/credentials.json` when that environment variable is
set, otherwise `~/.dubsar/my-work-controller/credentials.json` (mode `0600`).

Configure endpoints in the environment (public client id, no client secret):

- `DUBSAR_CONTROLLER_URL`
- `DUBSAR_CONTROLLER_AUTHORIZATION_ENDPOINT`
- `DUBSAR_CONTROLLER_TOKEN_ENDPOINT`
- `DUBSAR_CONTROLLER_CLIENT_ID`

```bash
node packages/dubsar-my-work-mcp/bin/dubsar-my-work-mcp.mjs connect
node packages/dubsar-my-work-mcp/bin/dubsar-my-work-mcp.mjs status
```

`connect` starts a loopback redirect, prints a browser URL (PKCE), and stores
tokens locally. `status` reports connection without printing tokens (`[redacted]`).

Set `DUBSAR_MY_WORK_OPEN_BROWSER=0` to print the URL without spawning a browser.

## Tool surface

| Tool | Mutation |
| --- | --- |
| `list_tickets` | no |
| `get_ticket` | no |
| `launch_cursor_mission` | creates exactly one `DUB-###` and issues exactly one Controller launch |
| `continue_cursor_mission` | continues an existing ticket through exactly one Controller run; no ticket/agent allocation |
| `prepare_cursor_mission` | creates exactly one `DUB-###` and persists Controller arguments plus local metadata (no network) |
| `attach_cursor_receipt` | attaches a Controller receipt, or no-op when identical |
| `sync_cursor_status` | applies existing Cursor/GitHub mapping to the current receipt run |

Every tool requires an explicit selected project: `start`, `allocation_root`,
and `project_id`. Incomplete missions, invalid 40-hex SHAs, unsafe relative
paths, contradictory repository URLs, `correction_budget` other than
`uncapped`, or a missing project fail before a ticket write. Persisted tickets
and receipts that still carry numeric `correction_budget` `3` remain readable
and are never rewritten to uncapped.

`launch_cursor_mission` and `continue_cursor_mission` talk to the remote
Controller over Streamable HTTP: `Accept: application/json, text/event-stream`.
Each issues exactly one `tools/call`. After a request is submitted, an
ambiguous or mismatched Controller response records a bounded failure,
fabricates no receipt, and later calls for that same launch or
`correction_number` return `MY_WORK_LAUNCH_NOT_RETRYABLE` or
`MY_WORK_CONTINUE_NOT_RETRYABLE` without a second request.

## What is forwarded to the Controller

`launch_cursor_mission` copies **only** `prepare_cursor_mission.arguments` into
`create_dubsar_work_cursor_agent`. It must not add, drop, or rebuild fields.
`continue_cursor_mission` copies those same persisted arguments into
`create_dubsar_work_cursor_agent_run` and adds only `agent_id` (from the
initial launch receipt), `correction_number`, and `prompt`.
`contract_fingerprint` and `receipt_bounds` are **local metadata**.

A successful launch receipt is attached only when `ticket_id`,
`target_repository_url`, `repository_refs`, the complete Controller
`receiptBounds` object, and `contract_fingerprint` match the persisted
metadata. A successful run receipt must also match the persisted `agent_id`
and the requested `correction_number`. The initial launch receipt stays on
`cursor_launch`; later validated run receipts are appended (`cursor_run` plus
activity). After MCP restart, `get_ticket.attached_receipt` and
`sync_cursor_status` use the current run (`cursor_run` when present, otherwise
the launch receipt).

`get_ticket` returns `prepared_contract` with `arguments`,
`contract_fingerprint`, and `receipt_bounds`, plus `attached_receipt`,
`attached_launch_receipt`, and `attached_run_receipts`.

Merge, local install, deployment, publication, VM/cloud, secrets, backend
switch, and scope extension stay human gates.

## Tests

```bash
node --test tests/my-work-mcp.test.mjs tests/my-work-mcp-e2e.test.mjs
```
