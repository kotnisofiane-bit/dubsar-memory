# My Work MCP (local stdio)

The local My Work MCP is a closed stdio server for ChatGPT Work. It never calls
Cursor, GitHub, or Linear, stores no secret, and opens no network socket. Ticket
writes reuse `previewTicketChange` / `applyTicketChange` from
`@dubsar/workbench-launcher`. Status mapping reuses the KOT-119
`sync-cursor-status` operation.

## Start

```bash
node packages/dubsar-my-work-mcp/bin/dubsar-my-work-mcp.mjs
```

Framing is MCP 2024-11-05 stdio: newline-delimited JSON-RPC on stdin/stdout.
`Content-Length` frames are still accepted for compatibility.

## Closed tool surface

| Tool | Mutation |
| --- | --- |
| `list_tickets` | no |
| `get_ticket` | no |
| `prepare_cursor_mission` | creates exactly one `DUB-###` and persists Controller arguments plus local metadata |
| `attach_cursor_receipt` | attaches a Controller receipt, or no-op when identical |
| `sync_cursor_status` | applies existing Cursor/GitHub mapping |

Every tool requires an explicit selected project: `start`, `allocation_root`,
and `project_id`. Incomplete missions, invalid 40-hex SHAs, unsafe relative
paths, contradictory repository URLs, `correction_budget` other than `3`, or a
missing project fail before a ticket write.

## What Work sends to the Cursor MCP

Work copies **only** `prepare_cursor_mission.arguments` into
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

`get_ticket` returns `prepared_contract` with `arguments`,
`contract_fingerprint`, and `receipt_bounds`, plus `attached_receipt`. These
survive MCP restart (`cursor_contract` activity and `cursor_launch`).

`attach_cursor_receipt` attaches only when `ticket_id`,
`target_repository_url`, `repository_refs`, the complete Controller
`receiptBounds` object, and `contract_fingerprint` match the persisted
metadata. A caller-supplied `expected_contract_fingerprint` must equal that
same value. Any divergence fails without writing.

## Tests

```bash
node --test tests/my-work-mcp.test.mjs tests/my-work-mcp-e2e.test.mjs
```
