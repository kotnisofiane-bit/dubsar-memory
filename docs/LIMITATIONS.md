# Known limits

DUBSAR Memory is a technical preview. These constraints are intentional or
unresolved and should be understood before production use.

## Capacity

The current `.dubsar/` contract allows at most:

- 256 Work items;
- 256 Knowledge entries;
- 128 canonical checkpoints;
- 16 references on a Work item;
- 8 verified references on a checkpoint.

The engine is designed for a bounded synthesis, not an append-only lifetime log.
Projects approaching a limit need an explicit archival/compaction design; the
preview does not silently discard records.

## Search and recall

Recall is exact and local. The engine can relate identical digests, explicit
references, Work identifiers, and recorded resolution links. It does not use
embeddings, semantic similarity, recency scoring, ranking, or a model.

This means it abstains when no exact relation exists. That is safer for project
continuity but insufficient for a large legal, scientific, or enterprise
document corpus.

## Time

Checkpoint order is append order. DUBSAR does not invent timestamps or claim
that append order is a real chronology. The snapshot digest proves byte
identity, not age, freshness in wall-clock time, or external validity.

## Verification

A verified reference means that the recorded local bytes matched during the
checkpoint workflow. It does not prove that the content is correct, complete,
approved, legally applicable, deployed, merged, or safe.

## Concurrency

Writers use locks, live reinspection, exact digests, temporary exclusive files,
and atomic replacement. They intentionally do not implement distributed locks
or multi-machine transactions. Put each writable project workspace on a local
filesystem with normal atomic-rename semantics.

Those locks are scoped to one workspace root. Separate Git worktrees therefore
have separate locks and must not append canonical checkpoints concurrently.
`checkpoints.json` is one tracked, strictly positional hash chain: two branches
that append from the same parent each create a valid child at the same index,
but Git cannot merge those children into one valid chain. Keeping both entries
without choosing an order is rejected as `MEMORY_CHECKPOINTS_INVALID`.

The supported rule for parallel worktrees is currently **many readers, one
canonical writer after explicit convergence**. Read or resume from any
worktree, merge the intended source changes, then preview and apply exactly one
canonical checkpoint from the retained worktree. Do not use concurrent
`checkpoint_append` operations as branch-local journals that are expected to
merge later. A valid relinearization would require an explicit ordering choice
and new digests for the displaced entry and its descendants; DUBSAR does not do
that automatically.

Lot 1 recording is available through `pending record`: it writes only
`.dubsar-pending/<declared_source>/<checkpoint_id>.md`. Those candidates are
Git-tracked advisory facts and never change `.dubsar/`, integrity, readiness,
capsules, or routing. Projection and promotion remain future lots; see the
[parallel-worktree checkpoint ADR](DUBSAR_PARALLEL_WORKTREE_CHECKPOINTS_ADR.md).

## Interfaces

- Node.js 20+ is required;
- Windows and Chrome receive the most Workbench testing;
- the JSON CLI is the supported integration boundary for the preview;
- the JavaScript module graph and HTML data contracts may still evolve before
  a stable release;
- no npm package is published yet.

## Product scope

DUBSAR is not an agent framework, database, vector store, source synchronizer,
OCR pipeline, policy gateway, CI system, secrets manager, or deployment tool.
It can provide bounded memory to those systems, but it must not inherit their
authority.

## Personal memory

Personal memory is separate, opt-in, local advisory state. It is not linked
automatically to project memory and never affects readiness, routing, capsules,
or the Workbench project graph. Its cross-project promotion model remains a
separate product decision.
