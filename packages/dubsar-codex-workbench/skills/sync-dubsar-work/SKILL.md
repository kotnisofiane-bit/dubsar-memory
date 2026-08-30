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
3. For each eligible ticket, call `get_cursor_agent_result` exactly once with
   that ticket's persisted `agent_id` and `run_id`. On a temporary reader
   failure, leave the ticket unchanged. Do not retry and do not switch
   backend. Normalize that raw result into the proposal schema below. Do not
   pass the raw MCP payload to the launcher.
4. If that one Cursor result names exactly one pull request for the receipt
   target repository, independently observe that exact repository and PR on
   GitHub once. A repository, PR, branch, or SHA contradiction leaves the
   ticket unchanged. Do not search for another PR or agent.
5. Write a temporary `sync-cursor-status` proposal containing the normalized
   Cursor observation and, when present, the independent GitHub observation.
   Preview then apply through the public launcher CLI:

   ```text
   node "<launcher-bin>" tickets sync-cursor-status --start <root> --allocation-root <allocation-root> --project-id <project_id> --proposal <temporary-file> --json
   node "<launcher-bin>" tickets sync-cursor-status --start <root> --allocation-root <allocation-root> --project-id <project_id> --proposal <temporary-file> --apply --expected-change <change_sha256> --json
   ```

6. Mapping after independent evidence only (canonical KOT-119 order):
   - GitHub-verified merged PR → `Done` with distinct `head_sha` and
     `merge_commit_sha`
   - explicit Cursor `failed` lifecycle → `Blocked` (never `In Review`, even
     with a non-merged open or draft PR)
   - otherwise a GitHub-verified open or draft PR → `In Review`, including
     when the Cursor lifecycle is still `running`
   - closed-unmerged PR → `Blocked`
   - completed without a usable independently verified PR → `Blocked`
   - running without a usable PR → `In Progress`
7. If preview shows an unchanged store, do not apply. A second sync against
   the same normalized evidence must not add activity or rewrite the ticket.
   A change to `head_sha`, branch, PR state, or merge commit must persist a
   new `cursor_sync` activity even when ticket `state`/`pr`/`branch`/`blocker`
   stay the same.
8. Re-read the ticket through `tickets list`. Do not open My Work from this
   skill. `launch-dubsar-work` or `resume-dubsar-workbench` opens My Work
   exactly once after this sync. Closing and reopening must keep the ticket,
   launch receipt, PR, branch, revisions, and synchronized state.

## Normalization (Work → proposal schema)

The launcher accepts only `trusted_cursor_observer` / `trusted_github_observer`
objects. Work performs this exact mapping once. Fail closed (no proposal, no
second read, ticket unchanged) on missing, ambiguous, multiple, or
contradictory values.

### `get_cursor_agent_result`

Call with the persisted pair only. Require the returned identity to equal
that `agent_id` and `run_id`.

| Raw `status` (case-insensitive single token) | `lifecycle` |
| --- | --- |
| `CREATING`, `QUEUED`, `PENDING`, `RUNNING`, `IN_PROGRESS` | `running` |
| `FAILED`, `ERROR`, `CANCELLED`, `CANCELED` | `failed` |
| `FINISHED`, `COMPLETED`, `COMPLETE`, `DONE` | `completed` |

Any other status, a list of statuses, or two conflicting status fields →
fail closed.

PR claim: collect HTTPS GitHub pull-request URLs that match the receipt
`target_repository_url` (`owner/name`, optional `.git`). Zero matches →
`pr: null`. Exactly one match → `pr: { repository, number }` and, when the
result also names one branch for that same PR, `pr.branch`. Two or more
matches, a URL for another repository, or a number that cannot be parsed →
fail closed. Never invent a PR and never query another agent.

Proposal:

```json
{
  "source": "trusted_cursor_observer",
  "ticket_id": "DUB-001",
  "agent_id": "<persisted agent_id>",
  "run_id": "<persisted run_id>",
  "lifecycle": "running|failed|completed",
  "pr": null
}
```

When a single target-repo PR exists, `pr` is
`{ "repository": "owner/name", "number": 12 }` plus optional `"branch"`.

### Independent GitHub PR

Observe only the claimed `repository` and PR number. Map one GitHub object:

| GitHub fields | `state` |
| --- | --- |
| `draft: true` and `state: open` and not merged | `draft` |
| `state: open`, not draft, not merged | `open` |
| `merged: true` or non-null `merged_at` | `merged` |
| `state: closed` and not merged | `closed` |

`draft` plus merged, `open` plus `closed`, or mixed merge flags → fail closed.

Always copy `head.ref` to `branch` and `head.sha` to `head_sha`. `branch`
must be a non-empty valid GitHub head ref for every PR observation; missing
or blank `head.ref`, or a ref that contradicts the Cursor-announced
`pr.branch`, is fail-closed with no ticket mutation. `head_sha` must be
exactly 40 lowercase hex characters for open, draft, closed, and merged.
`starting_sha` on `cursor_launch.repository_refs` is the
`starting_revision` and must not be overwritten or reused as `head_sha`.
`merge_commit_sha` is present only when `state` is `merged`; it is a
distinct field from `head_sha`, must also be 40 lowercase hex, and must not
equal `head_sha`.

Proposal:

```json
{
  "source": "trusted_github_observer",
  "ticket_id": "DUB-001",
  "repository": "owner/name",
  "pr": 12,
  "state": "open|draft|closed|merged",
  "branch": "cursor/work",
  "head_sha": "<40 lowercase hex>",
  "merge_commit_sha": null
}
```

For merged PRs set `merge_commit_sha` to the GitHub merge commit SHA (never
copy `head_sha` into that field; never use the same SHA for both). Persist
`repository`, `pr`, `branch`, and `head_sha` in the ticket activity
evidence. For `Done`, persist both `head_sha` and `merge_commit_sha`.

## Limits

No daemon, webhook, permanent polling, secret, merge, deployment, second
Cursor launch, or automatic retry. Temporary proposals must be outside user
memory and deleted when the workflow stops.
