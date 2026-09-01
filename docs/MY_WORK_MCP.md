# My Work MCP (local stdio)

The local My Work MCP is a closed stdio server for ChatGPT Work. ChatGPT Work
calls **`launch_cursor_mission` once**. That call persists one `DUB-###` ticket
and issues exactly one remote `create_dubsar_work_cursor_agent` request. Work
does not call Cursor MCP separately.

`contract_fingerprint` and `receipt_bounds` stay local. The Controller receives
only the existing `prepare_cursor_mission.arguments` object, unchanged.

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
| `prepare_cursor_mission` | creates exactly one `DUB-###` and persists Controller arguments plus local metadata (no network) |
| `attach_cursor_receipt` | attaches a Controller receipt, or no-op when identical |
| `sync_cursor_status` | applies existing Cursor/GitHub mapping |

Every tool requires an explicit selected project: `start`, `allocation_root`,
and `project_id`. Incomplete missions, invalid 40-hex SHAs, unsafe relative
paths, contradictory repository URLs, `correction_budget` other than `3`, or a
missing project fail before a ticket write.

`launch_cursor_mission` talks to the remote Controller over Streamable HTTP:
`Accept: application/json, text/event-stream`. The delivered Controller
(`createMcpHandler` from `@modelcontextprotocol/server` 2.0.0) rejects the
previous JSON-only request with HTTP 406 and answers a compatible request with
`text/event-stream`. The local client decodes that SSE JSON-RPC result. It
still issues exactly one `tools/call`.

It fails with `MY_WORK_CONTROLLER_NOT_CONNECTED` before a launch request when
no local credentials exist. After a request is submitted, an ambiguous or
mismatched Controller response is `MY_WORK_LAUNCH_AMBIGUOUS` (or the attach
mismatch code), records a bounded failure, fabricates no receipt, and later
calls return `MY_WORK_LAUNCH_NOT_RETRYABLE` without a second request.

## What is forwarded to the Controller

`launch_cursor_mission` copies **only** `prepare_cursor_mission.arguments` into
`create_dubsar_work_cursor_agent`. It must not add, drop, or rebuild fields.
`contract_fingerprint` and `receipt_bounds` are **local metadata**: persist them
on the ticket, then match the real Controller receipt against them. They are
not tool arguments.

```json
{
  "name": "create_dubsar_work_cursor_agent",
  "arguments": {
    "ticket_id": "DUB-001",
    "target_repository_url": "https://github.com/owner/repo",
    "pr_repository_url": "https://github.com/owner/repo",
    "repository_refs": [
      { "repository_url": "https://github.com/owner/repo", "starting_sha": "<40 hex>" }
    ],
    "allowed_paths": ["packages/dubsar-my-work-mcp/**"],
    "mission": "…",
    "acceptance_criteria": ["…"],
    "expected_evidence": ["…"],
    "required_capabilities": ["…"],
    "preferred_plugins": [],
    "required_plugins": [],
    "human_gates": [
      "merge",
      "local_install",
      "deployment",
      "publication",
      "vm_cloud",
      "secrets",
      "backend_switch",
      "scope_extension"
    ],
    "correction_budget": 3
  }
}
```

Local metadata returned beside `arguments` (never passed to the Controller):

```json
{
  "contract_fingerprint": "sha256:<64 lowercase hex>",
  "receipt_bounds": {
    "allowed_paths": ["packages/dubsar-my-work-mcp/**"],
    "auto_create_pr": true,
    "correction_budget": 3,
    "human_gates": ["merge", "local_install", "deployment", "publication", "vm_cloud", "secrets", "backend_switch", "scope_extension"],
    "pr_repository_url": "https://github.com/owner/repo",
    "stateless": true,
    "work_on_current_branch": false
  }
}
```

The fingerprint is `sha256:` plus SHA-256 of `JSON.stringify` of an object
built in this exact key order (Controller `src/dubsar-work.ts`):
`acceptance_criteria`, `allowed_paths`, `correction_budget`,
`expected_evidence`, `human_gates`, `mission`, `preferred_plugins`,
`pr_repository_url`, `required_capabilities`, `required_plugins`,
`repository_refs`, `target_repository_url`, `ticket_id`. No extra fields, no
stable key sort. Frozen vector:
`packages/dubsar-my-work-mcp/vectors/controller-canonical-v1.json`
(`sha256:56ada5fb957c3c84449688dc79169e093ee4b7d6d05dc0cfc64be9c0db89f574`,
Controller revision `9c5cd6536ebfa5c582a00a9d66cdff1560dd469c`).

A successful Controller receipt is attached only when `ticket_id`,
`target_repository_url`, `repository_refs`, the complete Controller
`receiptBounds` object, and `contract_fingerprint` match the persisted
metadata. `launch_cursor_mission` then returns `ticket_id`, `agent_id`,
`run_id`, and `source_url`. These survive MCP restart (`cursor_contract`
activity, `launch_submitted`, and `cursor_launch`). The ticket state is
`In Progress`.

`get_ticket` returns `prepared_contract` with `arguments`,
`contract_fingerprint`, and `receipt_bounds`, plus `attached_receipt`.

`attach_cursor_receipt` remains available for receipts obtained outside the
combined launch tool. Any divergence fails without writing.

Merge, local install, deployment, publication, VM/cloud, secrets, backend
switch, and scope extension stay human gates.

## Tests

```bash
node --test tests/my-work-mcp.test.mjs tests/my-work-mcp-e2e.test.mjs
```
