---
name: export-audit-bundle
description: Export a validated, deterministic, non-certifying bundle of local audit-preparation files and approved artifacts. Use when scope, inventory, sensitive-action mapping, and evidence-gap review are complete and the user wants a portable human-review package.
---

# Export Audit Bundle

## Objective

Create a portable local evidence package whose copied bytes can be
independently checked.

## Inputs

- an explicit local audit-workspace path;
- an explicit output path outside that workspace;
- the five required case documents and their approved indexed artifacts;
- user confirmation that the listed files may be copied.

## Preconditions

- the workspace contains the five required JSON documents;
- structural validation passes;
- the evidence review says `ready_for_human_review`;
- the destination is outside the workspace and does not exist or is empty;
- all source artifacts are approved for inclusion.

If a precondition fails, stop and list it. Never downgrade or omit a failed
check to force an export.

## Workflow

1. From the complete pack, run
   `../dubsar-audit-readiness/scripts/validate-audit-workspace.mjs --root <workspace>`.
2. Ask the user to confirm that the listed files may be copied.
3. Run
   `../dubsar-audit-readiness/scripts/export-audit-bundle.mjs --root <workspace> --output <target>`.
4. Report the file count and root SHA-256 from the generated manifest.
5. Label the result `prepared for human review`.

## Review gate

Deterministic export needs no new reviewer when the reviewed root digest is
unchanged. If reviewed decision-relevant canonical fields changed or
release-readiness is newly asserted, route the state through [the common review
protocol](../dubsar-audit-readiness/references/review-protocol.md) before export.
Receipt or audit-log appends outside the canonical root do not start another
review wave.

## Output

Produce a copied local bundle, `AUDIT-PREPARATION-SUMMARY.md`, and
`MANIFEST.sha256.json` containing the case ID, sorted file digests, file count, `root_sha256`, label
`prepared_for_human_review`, and a non-certification disclaimer. Report the
output path, count, root digest, and any failure without masking it.

## Boundaries

- Do not call the package an audit report, certification, compliance decision,
  or production approval.
- Do not include credentials, environment files, archives, executables,
  symlinks, or files outside the explicit workspace.
- Do not overwrite an existing non-empty target.
- Do not upload or send the result.

The deterministic manifest proves only which bytes were packaged. It does not
prove that the underlying system is correct or compliant.

## Example invocation

> Use `$export-audit-bundle` to validate `./audit-case` and export it to
> `./audit-bundle` after I confirm the indexed files; stop without changing
> either directory if readiness fails.
