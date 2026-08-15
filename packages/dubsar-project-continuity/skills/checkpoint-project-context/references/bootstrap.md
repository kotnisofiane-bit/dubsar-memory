# Reference: `bootstrap`

Exact wire format for creating a new `.dubsar/` workspace with one Work, one
explicit local selection, and one first checkpoint in a single atomic publish.

This operation applies **only** when no local `.dubsar/` exists. It does not
replace `init`, `work create`, `work select`, or `checkpoint_append`. Those
granular writes remain available and keep their existing `/1` contracts.

## Envelope

`dubsar.memory-bootstrap-proposal/1` carries exactly seven keys.

| Key | Constraint |
| --- | --- |
| `format` | `"dubsar.memory-bootstrap-proposal/1"` |
| `project_id` | `^[a-z0-9][a-z0-9._-]{2,127}$` |
| `title` | 1–300 characters, canonical single line |
| `work` | exact `dubsar.work/1` |
| `work_body` | advisory Markdown body, ≤16 000 characters |
| `selected_work_id` | must equal `work.work_id` and `checkpoint.work_id` |
| `checkpoint` | the ten authored checkpoint fields (see below) |

Write the file to an OS temporary directory. A proposal stored inside the
project is rejected with `MEMORY_BOOTSTRAP_PROPOSAL_LOCATION_INVALID`.

## Explicit selection

`selected_work_id`, `work.work_id`, and `checkpoint.work_id` must be identical.
Any mismatch is `MEMORY_BOOTSTRAP_SELECTION_MISMATCH`. The runtime never
chooses a Work.

`work.knowledge_ids` must be empty at bootstrap (`MEMORY_KNOWLEDGE_NOT_FOUND`
otherwise): no Knowledge files exist yet.

`checkpoint.resolves` must be `null` for the first chain entry.

## `resulting_state.next_action` (post-apply only)

`checkpoint.resulting_state.next_action` is recorded into the first checkpoint
and becomes the resume capsule's next-action label after a successful apply.

It must describe the action to take **after** bootstrap has already succeeded.
It must **not** ask to confirm, preview, or apply this bootstrap itself.

Correct example:

`Review the catalog submission draft before requesting publication approval.`

Incorrect example (do not record):

`Await explicit confirmation before applying the atomic bootstrap.`

The runtime does not invent or rewrite this field. Authors and host skills must
supply a post-application action.

## `checkpoint` — ten authored fields

Same authored fields as `checkpoint_append`:

`checkpoint_id`, `work_id`, `kind`, `summary`, `references`, `validation`,
`limitations`, `resolves`, `attempt`, `resulting_state`.

The runtime computes `index` (`0`), `previous_checkpoint_sha256` (`null`), and
`checkpoint_sha256`. References use the same safe-capture path as
`checkpoint_append`.

## Preview and apply

```text
node "<plugin-root>/bin/dubsar.mjs" bootstrap --start <project> --proposal <temporary-json> --json
node "<plugin-root>/bin/dubsar.mjs" bootstrap --start <project> --proposal <temporary-json> --apply --expected-change <change_sha256> --json
```

Preview format: `dubsar.memory-bootstrap-preview/1`  
Apply format: `dubsar.memory-bootstrap-apply/1`  
Operation: `bootstrap_memory_vnext`  
Target: `.dubsar`

Summary language for humans:

- Create project memory
- Active work
- First recorded checkpoint
- After bootstrap, do next (the recorded `resulting_state.next_action`)

Nothing is written before confirmation of the exact `change_sha256`. Apply
stages under a sibling directory, validates digests and closed documents, then
renames once to `.dubsar`. Init and bootstrap share `.dubsar-memory-init.lock`.

## Refusal codes

| Code | Meaning |
| --- | --- |
| `WORKSPACE_ALREADY_EXISTS` | `.dubsar` already present |
| `MEMORY_MIGRATION_REQUIRED` | legacy `.dubsar-project` present |
| `MEMORY_BOOTSTRAP_SELECTION_MISMATCH` | selected Work ids disagree |
| `MEMORY_BOOTSTRAP_CONFIRMATION_MISMATCH` | `--expected-change` mismatch |
| `MEMORY_BOOTSTRAP_LOCKED` | init/bootstrap lock held |
| `MEMORY_BOOTSTRAP_PROPOSAL_LOCATION_INVALID` | proposal inside the project |
