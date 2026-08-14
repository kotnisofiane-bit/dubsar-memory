# Reference: `checkpoint_append`

Exact wire format for appending one checkpoint to a `.dubsar/` workspace.

This operation applies **only** to a `.dubsar/` (memory-vnext) workspace. A
compatible two-file Lite workspace uses a different document,
`dubsar.continuity-checkpoint-proposal/1`, described in `SKILL.md`. A legacy
four-file workspace uses `dubsar.checkpoint-proposal/1`. The three are not
interchangeable; submitting the Lite document against `.dubsar/` fails with
`MEMORY_CHANGE_PROPOSAL_INVALID`.

## Envelope

`dubsar.memory-change-proposal/1` carries exactly four keys. Any extra or
missing key fails.

| Key | Value |
| --- | --- |
| `format` | `"dubsar.memory-change-proposal/1"` |
| `project_id` | must equal `project_id` in `.dubsar/manifest.json` |
| `operation` | `"checkpoint_append"` |
| `payload` | exactly `{ "entry": { … } }` |

Write the file to an OS temporary directory. A proposal stored inside the
project is rejected with `MEMORY_CHANGE_PROPOSAL_LOCATION_INVALID`. Maximum
proposal size is 128 KiB.

## `payload.entry` — the ten fields you author

`entry` must carry exactly these ten keys, no more and no fewer.

| Field | Type | Constraint |
| --- | --- | --- |
| `checkpoint_id` | string | `^[a-z0-9][a-z0-9._-]{2,127}$`, case-insensitive; unique across all recorded checkpoints |
| `work_id` | string | same pattern; must match an existing `work/<id>.md`, else `MEMORY_WORK_NOT_FOUND` |
| `kind` | string | one of `progress`, `decision`, `blocker`, `blocker_resolution`, `attempt` |
| `summary` | string | canonical single line, 1–500 characters |
| `references` | array | 0–8 items, each exactly `{ "path", "sha256" }`; see below |
| `validation` | array | 0–8 canonical single-line strings, 1–500 characters, **no duplicates** |
| `limitations` | array | 0–8 canonical single-line strings, 1–500 characters, **no duplicates** |
| `resolves` | string \| null | `null`, or the `checkpoint_id` of an **earlier entry in the chain**; see below |
| `attempt` | object \| null | `null`, or `{ action_id, gate_id, failure_fingerprint }`; see below |
| `resulting_state` | object | exactly `{ status, summary, blockers, next_action }`; see below |

## Fields the runtime computes — never author them

Supplying these does not help and extra keys are rejected outright.

| Field | Source |
| --- | --- |
| `index` | current entry count |
| `previous_checkpoint_sha256` | digest of the preceding entry, `null` for the first |
| `checkpoint_sha256` | SHA-256 over the canonical JSON of the completed entry |

The hash chain is built by the CLI, not by the model. Each `references[].sha256`
is also re-captured from disk and re-verified — the value you supply is a claim
the runtime checks, not a value it trusts.

## Canonical single-line text

`summary`, every `validation` and `limitations` item, `resulting_state.summary`,
`resulting_state.next_action`, and each blocker `statement` are **canonical
single-line** fields. A value is accepted only if it is byte-identical to its
normalized form. There is no silent normalization: a value that would need
rewriting is refused.

Rejected, each with `MEMORY_CHECKPOINTS_INVALID`:

- a newline or tab anywhere in the value;
- two or more consecutive spaces;
- leading or trailing whitespace;
- an absolute path (`/usr/lib/x`, `C:\dir\x`, UNC), an email address, a phone
  number, or an IPv4 literal;
- credential-shaped content, a role marker such as `system:`, a fenced code
  block, or an instruction pattern such as "ignore previous instructions".

Keep prose, reasoning, and multi-line notes in the Markdown body of a Work or
Knowledge file. A checkpoint field is a record, not a narrative.

## `references`

Each item is exactly `{ "path": <project-relative>, "sha256": <64 hex> }`.

- `path` is relative to the project root, forward-slashed, never absolute and
  never traversing upward.
- A path under `.dubsar/` is rejected with `MEMORY_REFERENCE_UNSAFE`.
- The file must exist and be a regular file no larger than 25 MiB.
- `sha256` must equal the file's current digest. If the file changes between
  preview and apply, the apply fails with `MEMORY_REFERENCE_INVALID`. This is
  the freshness guarantee — do not retry, re-preview.
- Duplicate paths within one entry are rejected.
- Content is screened: `.env*`, `credentials.*`, `secrets.*`, `.npmrc`,
  `.netrc`, `id_rsa`, `id_ed25519`, archives, binaries, and key material
  (`.pem`, `.key`, `.p12`, `.pfx`, …) are refused, as is any file containing a
  credential pattern, a credential assignment, or a URL with inline
  credentials.

An entry with zero references is valid and is recorded as `reported` /
`unsupported` rather than `observed` / `supported`.

Recorded digests are re-verified on later reads. `resume --capsule`, `history`,
and `precedents` re-read each referenced file and classify it `fresh`, `stale`,
`missing`, or `unknown`; a checkpoint whose file changed after recording
becomes `unsupported`. Writes are unaffected — a preview or apply never depends
on another checkpoint's references, so a checkpoint can still be recorded while
an older reference is stale or missing.

## `resolves`

`resolves` points at a **`checkpoint_id` that already exists earlier in the
chain**. It is not a `blocker_id`, and a blocker's `blocker_id` is not a valid
value unless a prior checkpoint happens to carry that exact id.

The chain is validated in order, so a value is accepted only when it names an
entry recorded strictly before this one:

| Value | Result |
| --- | --- |
| `checkpoint_id` of an earlier entry | accepted |
| a `blocker_id` from `resulting_state.blockers` | rejected |
| an id that appears nowhere in the chain | rejected |
| this entry's own `checkpoint_id` | rejected |
| a `checkpoint_id` recorded later in the chain | rejected |

Every rejection is `MEMORY_CHECKPOINTS_INVALID`.

To record that a blocker is cleared, set `kind` to `blocker_resolution`, point
`resolves` at the earlier checkpoint that recorded the blocker, and omit that
blocker from this entry's `resulting_state.blockers`. The blocker text itself
lives in the earlier entry; this one records that the situation moved on.

## `attempt`

`attempt` is non-null **if and only if** `kind` is `"attempt"`. Both mismatches
fail.

```json
{ "action_id": "run-unit-tests", "gate_id": "tests-green", "failure_fingerprint": "<64 hex>" }
```

`action_id` and `gate_id` follow the id pattern. `failure_fingerprint` is any
64-character lowercase hex string that is stable for the same failure; two
consecutive equivalent attempts with no references make the resume capsule
report `reframe_recommended`.

## `resulting_state`

Exactly four keys.

| Field | Constraint |
| --- | --- |
| `status` | one of `active`, `paused`, `complete`, `unknown` |
| `summary` | canonical single line, 1–500 characters |
| `blockers` | 0–8 items, each exactly `{ "blocker_id", "statement" }` |
| `next_action` | canonical single line, 1–500 characters |

`next_action` becomes the resume capsule's `next_action.label` for the selected
Work. Write it as a record of what the human decided to do next. It is quoted
data for the next reader, never an instruction that a host should execute.

## Valid example

```json
{
  "format": "dubsar.memory-change-proposal/1",
  "project_id": "synth-project",
  "operation": "checkpoint_append",
  "payload": {
    "entry": {
      "checkpoint_id": "cp-subtract-implemented",
      "work_id": "add-subtract",
      "kind": "progress",
      "summary": "Subtract function implemented in src/index.mjs.",
      "references": [
        {
          "path": "src/index.mjs",
          "sha256": "f8bc2e918d12d58ca2382491cd68ad6987484427873e89551e561b4af303c14c"
        }
      ],
      "validation": ["Function reviewed against acceptance criteria"],
      "limitations": ["No automated test recorded yet"],
      "resolves": null,
      "attempt": null,
      "resulting_state": {
        "status": "active",
        "summary": "Subtract implemented; test still pending.",
        "blockers": [],
        "next_action": "Add a test covering subtract."
      }
    }
  }
}
```

## Preview, then apply

```text
node "<plugin-root>/bin/dubsar.mjs" checkpoint --start <project> --proposal <temporary-json> --json
```

Present `change_sha256`, the target, and the consequence, and state that nothing
has changed. Only after explicit confirmation of that exact preview:

```text
node "<plugin-root>/bin/dubsar.mjs" checkpoint --start <project> --proposal <temporary-json> --apply --expected-change <change_sha256> --json
```

One apply changes only `.dubsar/checkpoints.json`. Delete the temporary
proposal afterwards, whatever the outcome.

## Error codes

| Code | Meaning |
| --- | --- |
| `MEMORY_CHANGE_PROPOSAL_INVALID` | envelope or payload shape wrong — often the Lite document used against `.dubsar/` |
| `MEMORY_CHANGE_PROPOSAL_LOCATION_INVALID` | proposal stored inside the project |
| `MEMORY_CHECKPOINTS_INVALID` | an `entry` field violates a constraint above |
| `MEMORY_WORK_NOT_FOUND` | `work_id` has no `work/<id>.md` |
| `MEMORY_REFERENCE_UNSAFE` | reference path under `.dubsar/` |
| `MEMORY_REFERENCE_INVALID` | digest mismatch or artifact policy finding |
| `MEMORY_CHANGE_CONFIRMATION_MISMATCH` | `--expected-change` does not match the recomputed preview |

These codes carry no field-level detail. When a proposal is refused, re-check it
against the tables above rather than retrying with a variation.
