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

Framing is MCP JSON-RPC with `Content-Length` headers on stdin/stdout.

## Closed tool surface

| Tool | Mutation |
| --- | --- |
| `list_tickets` | no |
| `get_ticket` | no |
| `prepare_cursor_mission` | creates exactly one `DUB-###` |
| `attach_cursor_receipt` | attaches a Controller receipt, or no-op when identical |
| `sync_cursor_status` | applies existing Cursor/GitHub mapping |

Every tool requires an explicit selected project: `start`, `allocation_root`,
and `project_id`. Incomplete missions, invalid 40-hex SHAs, unsafe relative
paths, contradictory repository URLs, or a missing project fail before a ticket
write.

`prepare_cursor_mission` returns `dubsar.cursor-controller-contract/1` with
`repository_refs` as `{repository_url, starting_sha}`, Controller bounds
(`max_runs: 1`, `polling: false`, `workOnCurrentBranch: false`,
`autoCreatePR: true`), and `contract_fingerprint` equal to `sha256:` plus the
SHA-256 of the canonical JSON body (fingerprint field excluded). Work then
calls the existing stateless Cursor DUB Controller once. The local server does
not launch the agent.

`attach_cursor_receipt` accepts the Controller names unchanged. It attaches
only when `ticket_id` and `contract_fingerprint` match the prepared ticket, sets
`In Progress`, and repeats of the same receipt are idempotent.

`sync_cursor_status` accepts Work-normalized `trusted_cursor_observer` and
optional `trusted_github_observer` objects and persists state, PR, branch, head
SHA, and merge SHA through the existing ticket engine.

Closing the process and starting another one reads the same stores.

## Tests

```bash
node --test tests/my-work-mcp.test.mjs tests/my-work-mcp-e2e.test.mjs
```
