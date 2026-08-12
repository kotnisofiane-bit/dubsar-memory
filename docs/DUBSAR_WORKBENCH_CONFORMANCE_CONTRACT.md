# DUBSAR Workbench — contrat de gel de conformance v1

**Contract ID:** `contract-workbench-conformance-v1`
**Status:** `approved_for_local_read_only_implementation`
**Authority:** local preparation contract; no release, provenance, writer, commit,
publication, deployment, or remote-mutation authority

**Approved:** 2026-08-10 by explicit user instruction in the active task. The
approval is limited to the local read-only implementation defined here.

## Purpose

Freeze and verify the already implemented read-only Workbench distribution
without using the draft transaction-writer contract. The result must make the
current working-tree bytes reproducible and honestly report why they are not a
release.

This contract is separate from `.dubsar-project/execution-contract.json`. It
does not replace, approve, suspend, or advance `lot-transaction-writer`, and it
must not be recorded as evidence for that lot.

## Current observed state

- The Workbench consists of exactly four private Node/ESM packages:
  `@dubsar/operator-core`, `@dubsar/operator-cli`,
  `@dubsar/workbench-report`, and `@dubsar/workbench-server`.
- Their current version is `0.1.0-dev`.
- The four package trees contain 24 regular files and are not tracked by the
  current Git commit.
- The existing runtime AST gate passes, but it is a static development control,
  not a sandbox or authenticated provenance proof.
- The Local Operator release remains independently blocked by `PB100`.

## Allowed actions after explicit approval

1. Add one detached, non-certifying conformance capture with format
   `dubsar.workbench-conformance/1`.
2. Add `tools/check-workbench-conformance.mjs` and development/release scripts
   that only read, hash, validate, and report.
3. Reuse `checkWorkbenchRuntime()` for the observed AST capability result;
   never reimplement or relax its policy from the capture.
4. Add byte-exact JSON goldens for stable `status`, `validate`, `report`, closed
   error, and audit-contradiction outputs. Validate `doctor` with a closed
   structural assertion and an exact Node-semver check because its observed
   runtime version is intentionally variable.
5. Add a hermetic, test-only **source-bundle probe** that copies only the
   manifest allowlist into an exact `mkdtemp` destination and invokes the CLI
   with `process.execPath`.
6. Add adversarial tests and update Workbench documentation and the completion
   ledger with observed results and limitations.

## Fixed targets

- `WORKBENCH_CONFORMANCE.json`
- `tools/check-workbench-conformance.mjs`
- `tests/workbench-conformance.test.mjs`
- `tests/workbench-goldens.test.mjs`
- `tests/golden/workbench/**`
- `package.json`
- `docs/DUBSAR_WORKBENCH_COMPLETION_LEDGER.md`
- `docs/DUBSAR_WORKBENCH_REUSE_AUDIT.md`
- this contract

The four product package trees are read-only inputs for this lot. Changing
their runtime behavior, public exports, versions, or formats requires another
reviewed contract.

## Forbidden actions

- Any edit to `.dubsar-project`, `.dubsar-audit`, personal `memory/`, installed
  host plugins, or host configuration.
- Any canonical writer, recovery marker, mutation endpoint, hook, MCP, daemon,
  background service, Tauri/runtime bundle, or legacy Core/Backend/Bridge use.
- Any intentional network request or direct Node network capability in the
  checker or probe, including the existing loopback UI route. The local probe
  assumes a non-synchronized local source root; generic Windows cloud
  placeholders remain unproved and may hydrate during a filesystem read, as
  stated below.
- `npm install`, `npm pack`, archive creation, container build, dependency
  download, PATH modification, commit, push, release approval, publication, or
  deployment.
- Reading or serializing credentials, environment secrets, real home paths,
  workspace contents outside synthetic fixtures, raw child-process errors, or
  absolute paths in a public diagnostic.
- Treating a digest match, green test, manifest field, agent review, or model
  response as authenticated human provenance.

## Conformance-capture contract

The capture is a local integrity snapshot, not a policy source and not a signed
attestation. Its exact top-level fields are:

- `format: "dubsar.workbench-conformance/1"`;
- `authority: "local_preparation_record"`;
- `scope: "read_only_workbench"`;
- `source: { kind: "working_tree", commit: null }` for the current snapshot;
- `review: { status: "pending" }`;
- one policy identity and digest for `tools/check-workbench-runtime.mjs`;
- exactly four component records;
- one exact, sorted file inventory;
- one `content_root_sha256`.

The manifest must declare observed effects honestly:

- core: workspace-scoped filesystem reads, no writes, no environment,
  subprocess, or network;
- report: pure deterministic rendering, no filesystem or network;
- server: explicit foreground IPv4 `loopback_listener`, no outbound network;
- CLI: stdout/stderr plus an explicit `ui` path to the same foreground
  `loopback_listener`, no outbound network and no subprocess.

The checker owns four fixed roots. It must never obtain traversal roots,
entrypoint authority, or allowed effects from the capture. It compares the
capture with package metadata, exported identities and formats, and the
independent AST gate.

## File and digest rules

- Paths are unique, printable ASCII, forward-slash, repository-relative,
  ordinally sorted and case-collision free.
- Reject absolute, drive, UNC, backslash, `.`/`..`, colon, control, newline,
  trailing-dot/space, or Windows-reserved segments.
- Only regular, single-link files under the four fixed real roots are accepted;
  symlinks, junctions visible to Node, hardlinks, extra files, and physical
  aliases fail closed.
- Node does not expose every Windows `FILE_ATTRIBUTE_REPARSE_POINT` tag. Generic
  cloud placeholders and other non-symlink reparse attributes therefore remain
  explicitly unproved. On Windows the checker reports
  `WINDOWS_REPARSE_ATTRIBUTES_UNPROVEN`; this is a warning for the local
  non-certifying capture and a release blocker. No claim of zero implicit cloud
  hydration is made by this v1.
- Hash bytes through stable file handles with stat-before/stat-after checks and
  bounded per-file and aggregate sizes.
- SHA-256 values are lowercase 64-hex strings.
- The capture excludes itself from the content root.
- Root preimage:

  ```text
  dubsar.workbench-files/1\0
  <sha256>  <portable-path>\n
  ...
  ```

  Entries use ordinal byte order. The domain prefix and final newline are
  mandatory.

## Checker semantics

The checker emits one bounded path-private JSON report with closed states
`ok`, `warn`, `fail`, `unknown`, or `blocked`, and keeps `declared` separate
from `observed`.

Development mode passes only when schema, inventory, digests, package
identities, entrypoints, formats, and the independent runtime gate agree. It
must still report source and human review as not release-ready.

Format evidence is bound to a fixed list of public producers, or to a fixed
private producer that is directly called by an exported entrypoint. The
checker requires the exact format values and occurrence counts inside those
producer bodies; unrelated or dead top-level functions cannot satisfy the
declaration. Behavioral goldens and the source-bundle probe separately execute
the public paths.

Release mode fails closed unless all of these are proven by a future separately
reviewed change:

- committed source and an exact non-null commit;
- package bytes proven to be the declared commit blobs;
- a separate human-review receipt bound to both the exact
  `manifest_sha256` and `content_root_sha256`, so the reviewed identity includes
  the policy digest and capability declarations;
- matching manifest, runtime gate, and source-bundle probe evidence.

For this contract, `working_tree + null + pending` is required, and release
failure is the expected correct result.

## Source-bundle probe

- Revalidate the source inventory immediately before copying.
- Copy only allowlisted files, preserving the four-package sibling layout.
- Use an exact directory returned by `mkdtemp`; create a fake home beneath it.
- Use `process.execPath`, `shell:false`, `windowsHide:true`, closed stdin,
  bounded stdout/stderr, a hard timeout, and no detached process.
- Construct a minimal environment and omit `NODE_OPTIONS`, `NODE_PATH`, proxy,
  credential, npm, real `HOME`, and real `USERPROFILE` variables.
- Exercise only non-network CLI paths against synthetic project and audit
  fixtures. The `ui` command is excluded; therefore the probe does not prove a
  clean-installed server session.
- Read every synthetic fixture from a fixed path/size/SHA-256 allowlist through
  stable handles, materialize only those captured bytes, and reattest source
  and destination fixture bytes after execution.
- Rehash source before and after execution and destination after copy.
- Cleanup only the exact temp identity in `finally`/`t.after`; cleanup failure
  fails the test.

The current relative sibling imports permit this source-bundle layout without
`node_modules`, loader hooks, package mutation, installation, or archives.

## Required adversarial evidence

1. Reject malformed schema, extra keys, reordered/duplicated/case-colliding or
   unsafe paths, uppercase/invalid hashes, extra files, and divergent versions.
2. Reject source root/file links and Node-visible junctions, hardlinks,
   non-regular files, identity changes, and cooperative mutation during capture
   or copy. Record generic Windows reparse attributes as unproved rather than
   claiming they were inspected. Exercise a FIFO fixture on a compatible POSIX
   filesystem; Windows records the platform limitation and remains release
   blocked for its broader reparse uncertainty.
3. Reject a capture claiming `network:none` for the server or CLI `ui` path.
4. Prove the policy digest and runtime AST result are observed independently of
   the capture.
5. Prove stable goldens are byte-exact, path-private and unchanged; prove
   `doctor` has exact keys and a valid observed Node version without permissive
   normalization.
6. Prove the probe ignores poisoned PATH and strips Node/module/proxy/credential
   environment channels, bounds hung/noisy children, and leaves source bytes
   unchanged.
7. Run focused tests, the complete suite, development and expected-failing
   release gates, and `git diff --check`.
8. Obtain independent architecture, security, and verification reviews on the
   final implementation.

## Stop conditions

Stop without implementation or release if:

- this contract is not explicitly approved;
- any product package change becomes necessary;
- the capture would drive or relax the runtime policy;
- a test requires real user/project data, network, install, archive, or host
  configuration;
- source bytes cannot be proven stable across the probe;
- release could pass while source is uncommitted, review is pending, or the
  human receipt is absent;
- free space on `C:` drops below 15 GB.

## Review reconciliation

Architecture and security reviewers require this contract to remain separate
from the draft writer and require honest loopback capabilities, fixed roots,
handle-based hashing, a fail-closed release gate and a hermetic source-bundle
probe.

Gemini usefully challenged manifest churn, split diagnostics and brittle
goldens. The retained mitigations are: the capture never drives policy;
`doctor` remains a workspace diagnostic; its volatile runtime field uses a
closed structural test rather than broad normalization; and the probe tests an
allowlisted source bundle rather than pretending to be an npm installation.
Gemini's ESM-resolution objection does not apply to the current relative sibling
imports. Its recommendations to commit, pack or containerize are deferred
because no commit/publication is authorized and this contract deliberately
forbids archives, installation and added runtime tooling.

## Human approval record

The required approval was received on 2026-08-10. Its authorized scope is
equivalent to:

> I approve `contract-workbench-conformance-v1` for local read-only
> implementation, without commit, publication, deployment, or writer work.

This record does not change `review.status: "pending"` in the conformance
capture: contract authorization and a future digest-bound release review are
different authorities.
