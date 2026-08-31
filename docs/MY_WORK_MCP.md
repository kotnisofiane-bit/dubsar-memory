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
| `prepare_cursor_mission` | creates exactly one `DUB-###` and persists the Controller arguments |
| `attach_cursor_receipt` | attaches a Controller receipt, or no-op when identical |
| `sync_cursor_status` | applies existing Cursor/GitHub mapping |

Every tool requires an explicit selected project: `start`, `allocation_root`,
and `project_id`. Incomplete missions, invalid 40-hex SHAs, unsafe relative
paths, contradictory repository URLs, `correction_budget` other than `3`, or a
missing project fail before a ticket write.

## What Work sends to the Cursor MCP

After the DUB ticket exists, Work calls the existing stateless Cursor DUB
Controller tool `create_dubsar_work_cursor_agent` **once**, using
`prepare_cursor_mission.arguments` as the tool arguments object with **no
reconstruction**. The local server does not launch the agent.

Example (shape and field names; values come from the prepared ticket):

```json
{
  "name": "create_dubsar_work_cursor_agent",
  "arguments": {
    "acceptance_criteria": ["…"],
    "allowed_paths": ["packages/dubsar-my-work-mcp/**"],
    "autoCreatePR": true,
    "bounds": {
      "autoCreatePR": true,
      "max_runs": 1,
      "polling": false,
      "workOnCurrentBranch": false
    },
    "contract_fingerprint": "sha256:<64 lowercase hex>",
    "correction_budget": 3,
    "expected_evidence": ["…"],
    "format": "dubsar.cursor-controller-contract/1",
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
    "linear_issue_id": "KOT-126",
    "mission": "…",
    "preferred_plugins": [],
    "pr_repository_url": "https://github.com/owner/repo",
    "repository_refs": [
      { "repository_url": "https://github.com/owner/repo", "starting_sha": "<40 hex>" }
    ],
    "required_capabilities": ["…"],
    "required_plugins": [],
    "target_repository_url": "https://github.com/owner/repo",
    "ticket_id": "DUB-001",
    "workOnCurrentBranch": false
  }
}
```

`contract_fingerprint` is `sha256:` plus the SHA-256 of the canonical JSON of
that object with the fingerprint field omitted. A frozen inter-repo vector lives
at `packages/dubsar-my-work-mcp/vectors/controller-canonical-v1.json` (Controller
revision `9c5cd6536ebfa5c582a00a9d66cdff1560dd469c`).

`get_ticket` returns `prepared_contract` (full arguments) and
`attached_receipt`. Both survive MCP process restart because they are stored on
the ticket (`cursor_contract` activity and `cursor_launch`).

`attach_cursor_receipt` accepts Controller names unchanged. It attaches only
when `ticket_id`, `target_repository_url`, `repository_refs` (URL + SHA),
the complete `bounds` object, and `contract_fingerprint` match the prepared
contract. A caller-supplied `expected_contract_fingerprint` must equal that
same persisted value. Any divergence fails without writing. Repeats of the same
receipt are idempotent. Caller `human_gates` must include the frozen catalog.

`sync_cursor_status` accepts Work-normalized `trusted_cursor_observer` and
optional `trusted_github_observer` objects and persists state, PR, branch, head
SHA, and merge SHA through the existing ticket engine.

## Tests

```bash
node --test tests/my-work-mcp.test.mjs tests/my-work-mcp-e2e.test.mjs
```
