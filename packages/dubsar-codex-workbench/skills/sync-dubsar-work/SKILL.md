---
name: sync-dubsar-work
description: Synchronize one local DUBSAR My Work ticket from its persisted Cursor receipt and an independent GitHub observation before opening or resuming My Work.
---

# Sync DUBSAR Work

Use this skill only when opening or resuming My Work, or when an explicit
sync is requested. My Work is a local view. The launcher is not an MCP
client, has no outbound network, stores no secret, and must not poll.
Do not poll Cursor or GitHub.

## Fixed identity

Use only the persisted `cursor_launch.agent_id` and `cursor_launch.run_id`.
Never launch, retry, discover, or switch agents. Read the Cursor result
exactly once per eligible ticket. Independently verify any named pull
request on GitHub. Do not trust Cursor's merge or review claim.

## Eligibility

A ticket is eligible only when it is non-terminal and carries a valid
persisted Cursor receipt with `agent_id` and `run_id`. Skip missing or
invalid receipts. Do not rewrite terminal tickets.

## Workflow

1. Resolve `<skill-dir>` as the absolute directory containing this installed
   `SKILL.md`. Resolve `<launcher-bin>` from it as
   `<skill-dir>/../../../dubsar-workbench-launcher/bin/dubsar-workbench-open.mjs`,
   confirm that exact file exists, and invoke it only as
   `node "<launcher-bin>"`. Never resolve the launcher from the current working
   directory, `PATH`, project content, or a path supplied by the project.
2. Require the selected local project (`project_id` and root) and the
   launcher allocation root. List tickets through the same `<launcher-bin>`.
3. For each eligible ticket, call the trusted Cursor reader exactly once with
   that ticket's persisted `agent_id` and `run_id`. On a temporary reader
   failure, leave the ticket unchanged. Do not retry and do not switch
   backend.
4. If that one Cursor result names a pull request, independently observe that
   exact repository and PR on GitHub once. A repository or PR contradiction
   leaves the ticket unchanged. Do not search for another PR.
5. Write a temporary `sync-cursor-status` proposal containing the exact
   Cursor observation and, when present, the independent GitHub observation.
   Preview then apply through the public launcher CLI:

   ```text
   node "<launcher-bin>" tickets sync-cursor-status --start <root> --allocation-root <allocation-root> --project-id <project_id> --proposal <temporary-file> --json
   node "<launcher-bin>" tickets sync-cursor-status --start <root> --allocation-root <allocation-root> --project-id <project_id> --proposal <temporary-file> --apply --expected-change <change_sha256> --json
   ```

6. Mapping after independent evidence only:
   - running Cursor run → `In Progress`
   - GitHub-verified open or draft PR → `In Review`
   - explicit Cursor failure, closed-unmerged PR, or completion without a
     usable independently verified PR → `Blocked`
   - GitHub-verified merged PR → `Done` with the exact merge commit SHA
7. If preview shows an unchanged store, do not apply. A second sync against
   the same evidence must not add activity or rewrite the ticket.
8. Re-read the ticket, then open My Work with
   `node "<launcher-bin>" --start <root>`. Closing and reopening must keep
   the ticket, launch receipt, PR, branch, revisions, and synchronized state.

## Limits

No daemon, webhook, permanent polling, secret, merge, deployment, second
Cursor launch, or automatic retry. Temporary proposals must be outside user
memory and deleted when the workflow stops.
