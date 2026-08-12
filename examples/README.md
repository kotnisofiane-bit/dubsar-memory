# Synthetic examples

The primary example is a complete, local Memory vNext project. It contains no
credentials, customer data, remote URL, deployment instruction, or authority
to execute work.

## Run the current product example

From the repository root:

```bash
npm run demo
node packages/dubsar-project-continuity/bin/dubsar.mjs resume --start examples/memory-vnext-project --capsule --json
node packages/dubsar-project-continuity/bin/dubsar.mjs route --start examples/memory-vnext-project --json
```

The demo reads and validates the fixture without modifying it or contacting a
service. The tracked `local.json` is synthetic demo state so the clone opens
with one explicit Work selection. Real projects normally ignore that file.

## Memory vNext fixture

[`memory-vnext-project/`](memory-vnext-project/) demonstrates:

- one `.dubsar/` project manifest;
- one open Work item with acceptance criteria;
- one approved and explicitly linked Knowledge entry;
- one digest-chained checkpoint with verified local references;
- one local Work selection;
- disposable Inbox and generated directories excluded from the snapshot.

The code intentionally has one remaining edge case, recorded in the checkpoint,
so the fixture represents useful resumable work rather than a falsely complete
project.

## Compatibility fixtures

[`project-continuity/`](project-continuity/) preserves the earlier
mission/lots/contract/evidence format for compatibility tests.
[`audit-readiness/`](audit-readiness/) is a frozen historical safety fixture.
Neither is the recommended starting point for a new DUBSAR project.

All examples are synthetic regression fixtures, not templates for legal,
security, compliance, deployment, or production-access conclusions.
