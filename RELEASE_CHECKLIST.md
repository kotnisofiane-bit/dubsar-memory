# Release checklist

The source repository and a package release are separate decisions. The source
may be reviewed through a public pull request while the package remains
unreleased. A stable package release is not ready until every item below is
complete.

- [ ] Public/private provenance reviewed by a human.
- [ ] No private B2B symbol, route, topology, credential, or customer data.
- [ ] Exactly two active skills are exposed by each host manifest.
- [ ] Fresh-profile installation works without a global `dubsar` command.
- [ ] Continuity CLI and Workbench suites pass on supported Windows/Node versions.
- [ ] Boundary, runtime, package, and conformance gates pass.
- [ ] Deterministic inventories are generated from the final unchanged tree.
- [ ] Codex pilot demonstrates useful resume and checkpoint behavior.
- [ ] Claude Code and Cursor compatibility are tested after Codex acceptance.
- [ ] License and publication decision explicitly approved.

No release, publication, or deployment is authorized by this checklist.
Source publication through a reviewed GitHub pull request does not satisfy or
bypass these package-release gates.
