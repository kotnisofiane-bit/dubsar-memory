# DUBSAR Memory documentation

This index separates the supported product documentation from engineering
records retained for review and compatibility.

## Start here

- [Getting started](GETTING_STARTED.md) — run the example, initialize a project,
  create and select Work, then resume it.
- [CLI reference](CLI_REFERENCE.md) — read commands, explicit writes, JSON
  conventions, and exit behavior.
- [Project memory architecture](MEMORY_ARCHITECTURE.md) — canonical files,
  digests, Work, Knowledge, checkpoints, and migration.
- [Backend and host integration](INTEGRATION.md) — use DUBSAR from a worker,
  VM, product backend, Codex, Claude Code, or Cursor.
- [Workbench guide](WORKBENCH.md) — open and interpret the optional read-only
  Dashboard.
- [Known limits](LIMITATIONS.md) — current capacity, non-goals, and production
  constraints.

## Trust and project boundaries

- [`PUBLIC_BOUNDARY.md`](../PUBLIC_BOUNDARY.md) defines the public/private
  product boundary.
- [`SECURITY.md`](../SECURITY.md) explains vulnerability reporting and data
  handling expectations.
- [Conceptual provenance](CONCEPTUAL_PROVENANCE.md) records the independent
  public implementation boundary.
- [`RELEASE_CHECKLIST.md`](../RELEASE_CHECKLIST.md) separates source preview,
  package release, and stable-product decisions.

## Engineering records

The remaining ADRs, conformance contracts, pilot protocols, and ledgers in
this directory document design validation. They are useful to maintainers but
are not required to install or use DUBSAR Memory. Some describe historical
formats retained only for compatibility; the current `.dubsar/` contract and
CLI behavior always take precedence.

- [Parallel-worktree checkpoints](DUBSAR_PARALLEL_WORKTREE_CHECKPOINTS_ADR.md)
  records the verified merge failure, the current single-writer rule, and a
  contract-first candidate/promotion design that is not implemented.
