# Write operations reference

Exact closed shapes for the writes that create or mutate a `.dubsar/` workspace.
Every key list is `exactKeys`: an extra or missing key is a refusal, not a
warning.

`checkpoint_append` has its own canonical reference, copied into this directory
at packaging time from the DUBSAR package: [`checkpoint-append.md`](checkpoint-append.md).

Optional first-run bootstrap has its own reference:
[`bootstrap.md`](bootstrap.md).

Each steady-state operation below is a **separate mutation**, with its own
preview, its own `change_sha256`, and its own confirmation. Never chain them.
Bootstrap is the only operation that may combine init + Work + selection + first
checkpoint, and only when no local workspace exists yet.

---

## 0. `bootstrap` — optional first recording (atomic)

Document: `dubsar.memory-bootstrap-proposal/1`. See [`bootstrap.md`](bootstrap.md).

```text
bootstrap --start <project> --proposal <temp.json> --json
bootstrap --start <project> --proposal <temp.json> --apply --expected-change <change_sha256> --json
```

Publishes `.dubsar/` atomically with one Active work, an explicit selection, and
one First recorded checkpoint. Refused when `.dubsar` already exists.

---

## 1. `init` — create the workspace

Document: `dubsar.memory-init-proposal/1`, exactly three keys.

| Key | Constraint |
| --- | --- |
| `format` | `"dubsar.memory-init-proposal/1"` |
| `project_id` | `^[a-z0-9][a-z0-9._-]{2,127}$`, case-insensitive |
| `title` | 1–300 characters, canonical single line |

```json
{
  "format": "dubsar.memory-init-proposal/1",
  "project_id": "payments-api",
  "title": "Payments API"
}
```

```text
init --start <project> --proposal <temp.json> --json
init --start <project> --proposal <temp.json> --apply --expected-change <change_sha256> --json
```

Publishes `.dubsar/` atomically. Changes nothing else.

---

## 2. `work create` — record a Work item

Document: `dubsar.memory-change-proposal/1` with `operation: "work_create"`.
Envelope keys are exactly `format`, `project_id`, `operation`, `payload`.

`payload` has exactly two keys: `work` and `body`.

`work` is a `dubsar.work/1` with exactly these nine keys:

| Key | Constraint |
| --- | --- |
| `format` | `"dubsar.work/1"` |
| `work_id` | `^[a-z0-9][a-z0-9._-]{2,127}$`; the file becomes `work/<work_id>.md` |
| `title` | 1–300 characters, canonical single line |
| `status` | `open`, `paused`, or `complete` |
| `scope` | `bounded`, `multi_step`, or `multi_session` |
| `objective` | 1–1500 characters, canonical single line |
| `acceptance_criteria` | 0–12 canonical single-line strings, ≤500 characters each, no duplicates |
| `knowledge_ids` | 0–32 ids, no duplicates; each must already exist |
| `references` | 0–16 project-relative paths, no duplicates; a path segment equal to `.git`, `.dubsar`, `.codex-work`, `memory`, or `node_modules` is refused |

`body` is advisory Markdown, ≤16 000 characters. Prose belongs here, not in the
frontmatter fields.

**Ask the user for `title` and `objective`. Never invent them.** Derive
`work_id` from the title in kebab-case and confirm it before previewing.

```json
{
  "format": "dubsar.memory-change-proposal/1",
  "project_id": "payments-api",
  "operation": "work_create",
  "payload": {
    "work": {
      "format": "dubsar.work/1",
      "work_id": "work-refunds-001",
      "title": "Support partial refunds",
      "status": "open",
      "scope": "multi_step",
      "objective": "Allow a partial refund against a settled payment.",
      "acceptance_criteria": [
        "A partial refund below the captured amount succeeds.",
        "A refund above the captured amount is rejected."
      ],
      "knowledge_ids": [],
      "references": []
    },
    "body": "Advisory notes for the human reader.\n"
  }
}
```

```text
work create --start <project> --proposal <temp.json> --json
work create --start <project> --proposal <temp.json> --apply --expected-change <change_sha256> --json
```

Creates exactly one file, `.dubsar/work/<work_id>.md`.

---

## 3. `work select` — choose the active Work

**This command takes no `--proposal`.** The CLI builds the proposal from its
flags; passing a file is refused with `CLI_ARGUMENT_INVALID`.

```text
work select --start <project> --work <work_id> --json
work select --start <project> --work <work_id> --apply --expected-change <change_sha256> --json
```

`--work none` clears the selection. Changes exactly one file, `.dubsar/local.json`,
which is local and Git-ignored.

**Never choose the Work.** Present the open items from `work list` and let the
user name one.

---

## 4. `checkpoint` — record the fact

See [`checkpoint-append.md`](checkpoint-append.md) for the entry's ten authored
fields, the three the runtime computes, the canonical single-line rule, and the
reference constraints.

```text
checkpoint --start <project> --proposal <temp.json> --json
checkpoint --start <project> --proposal <temp.json> --apply --expected-change <change_sha256> --json
```

Changes exactly one file, `.dubsar/checkpoints.json`.

---

## Rules that apply to all four

- Proposals live in an **OS temporary directory**, never inside the project. A
  proposal found inside the project is refused with
  `MEMORY_CHANGE_PROPOSAL_LOCATION_INVALID`.
- Preview first, present the exact `change_sha256`, state that nothing has
  changed, and apply only after the user confirms **that** digest.
- Each apply performs one explicitly previewed operation. Initialization
  atomically publishes the complete `.dubsar/` directory. After initialization,
  each steady-state operation changes one canonical file: `work create` writes
  one `.dubsar/work/<work_id>.md`, `work select` writes `.dubsar/local.json`,
  and `checkpoint` appends to `.dubsar/checkpoints.json`.
- Canonical single-line fields refuse newlines, tabs, doubled spaces,
  surrounding whitespace, absolute paths, emails, and credential-shaped text.
  The writer refuses rather than rewriting.
- Delete the temporary proposal afterwards, whatever the outcome.
