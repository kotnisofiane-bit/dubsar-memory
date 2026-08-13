# Getting started

This guide uses the dependency-free runtime directly. Host plugins are
optional.

## Requirements

- Node.js 20 or newer;
- Git only if you clone the repository;
- a local project directory you are allowed to read and modify.

## Run the synthetic example

```bash
git clone https://github.com/kotnisofiane-bit/dubsar-memory.git
cd dubsar-memory
npm ci
npm run demo
```

Read the included project without modifying it:

```bash
node packages/dubsar-project-continuity/bin/dubsar.mjs resume --start examples/memory-vnext-project --capsule --json
node packages/dubsar-project-continuity/bin/dubsar.mjs route --start examples/memory-vnext-project --json
node packages/dubsar-project-continuity/bin/dubsar.mjs context --start examples/memory-vnext-project --json
```

The example is synthetic. It contains no remote, credential, customer data, or
permission to execute work.

## Initialize a project

Create an initialization proposal outside the project directory. For example,
place `dubsar-init.json` next to the project:

```json
{
  "format": "dubsar.memory-init-proposal/1",
  "project_id": "project-example-001",
  "title": "Example project"
}
```

From the repository containing the DUBSAR runtime, preview initialization:

```bash
node packages/dubsar-project-continuity/bin/dubsar.mjs init --start /path/to/project --proposal /path/to/dubsar-init.json --json
```

The preview returns `change_sha256`. Review it, then apply exactly that change:

```bash
node packages/dubsar-project-continuity/bin/dubsar.mjs init --start /path/to/project --proposal /path/to/dubsar-init.json --apply --expected-change <change_sha256> --json
```

Initialization creates `.dubsar/` atomically. It does not edit source files,
Git configuration, host instruction files, or global profiles.

## Create the first Work item

Create another proposal outside the project:

```json
{
  "format": "dubsar.memory-change-proposal/1",
  "project_id": "project-example-001",
  "operation": "work_create",
  "payload": {
    "work": {
      "format": "dubsar.work/1",
      "work_id": "work-first-change-001",
      "title": "Implement the first bounded change",
      "status": "open",
      "scope": "bounded",
      "objective": "Implement and verify one bounded change.",
      "acceptance_criteria": [
        "The relevant test passes."
      ],
      "knowledge_ids": [],
      "references": []
    },
    "body": "# First bounded change\n\nHuman working notes.\n"
  }
}
```

Preview and apply it with the same digest-confirmation pattern:

```bash
node packages/dubsar-project-continuity/bin/dubsar.mjs work create --start /path/to/project --proposal /path/to/work-proposal.json --json
node packages/dubsar-project-continuity/bin/dubsar.mjs work create --start /path/to/project --proposal /path/to/work-proposal.json --apply --expected-change <change_sha256> --json
```

Select it only for the current worktree:

```bash
node packages/dubsar-project-continuity/bin/dubsar.mjs work select --start /path/to/project --work work-first-change-001 --json
node packages/dubsar-project-continuity/bin/dubsar.mjs work select --start /path/to/project --work work-first-change-001 --apply --expected-change <change_sha256> --json
```

`local.json` is ignored by Git. Selecting Work changes the contextual digest,
not the shared project-memory digest and not another developer's selection.

## Resume and close

Read the bounded context at any time:

```bash
node packages/dubsar-project-continuity/bin/dubsar.mjs resume --start /path/to/project --capsule --json
node packages/dubsar-project-continuity/bin/dubsar.mjs route --start /path/to/project --json
node packages/dubsar-project-continuity/bin/dubsar.mjs history --start /path/to/project --json
```

For a human checkpoint, use an interactive terminal:

```bash
node packages/dubsar-project-continuity/bin/dubsar.mjs close --start /path/to/project
```

The CLI shows the normalized entry, previews the live digest, and requires the
human confirmation it displays. It does not select or complete Work.

## Open the Workbench on Windows

From this repository:

```powershell
npm run workbench:open -- --start "C:\path\to\project"
```

The launcher uses an ephemeral loopback URL. Keep the terminal open while the
Dashboard is in use. The Workbench is read-only; use the CLI for all writes.
