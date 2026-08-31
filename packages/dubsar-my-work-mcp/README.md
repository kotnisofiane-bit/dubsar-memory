# DUBSAR My Work MCP

Private local stdio MCP for ChatGPT Work. It lists and reads DUB tickets, prepares
one bounded Cursor Controller envelope after persisting a ticket, attaches a
verified launch receipt, and applies the existing KOT-119 sync rules.

The process has no outbound network, stores no secret, and does not call Cursor,
GitHub, or Linear. Work supplies observations. See `docs/MY_WORK_MCP.md`.
