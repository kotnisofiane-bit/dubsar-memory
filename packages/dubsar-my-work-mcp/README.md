# DUBSAR My Work MCP

Private local stdio MCP for ChatGPT Work. The public launch path is
`launch_cursor_mission`: persist one DUB ticket and issue exactly one remote
Controller `create_dubsar_work_cursor_agent` call. Work does not call Cursor
MCP separately.

Local CLI:

```bash
node packages/dubsar-my-work-mcp/bin/dubsar-my-work-mcp.mjs connect
node packages/dubsar-my-work-mcp/bin/dubsar-my-work-mcp.mjs status
```

OAuth credentials stay in the machine-local store documented in
`docs/MY_WORK_MCP.md`. They are never committed. See that document for the
Controller argument boundary.
