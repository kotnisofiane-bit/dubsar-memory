# Release checklist

The public source preview, a package release, and a stable-product declaration
are separate decisions. Source may be reviewed through a public pull request
while the package remains unreleased. A stable package release is not ready
until every item below is complete.

- [ ] Public/private provenance reviewed by a human.
- [ ] No private B2B symbol, route, topology, credential, or customer data.
- [ ] Exactly two optional host adapters are exposed by each host manifest.
- [ ] Fresh-profile installation works without a global `dubsar` command.
- [ ] Continuity CLI and Workbench suites pass on supported Windows/Node versions.
- [ ] Boundary, runtime, package, and conformance gates pass.
- [ ] Deterministic inventories are generated from the final unchanged tree.
- [ ] Codex pilot demonstrates useful resume and checkpoint behavior.
- [ ] Claude Code and Cursor compatibility are tested after Codex acceptance.
- [x] MIT source-publication direction explicitly approved.
- [ ] Package publication explicitly approved after provenance review.

No release, publication, or deployment is authorized by this checklist.
Source publication through a reviewed GitHub pull request does not satisfy or
bypass these package-release gates.
