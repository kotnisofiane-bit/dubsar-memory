# Changelog

All notable source changes are documented here. Package publication remains a
separate, explicitly reviewed decision.

## Public technical preview — 0.3.0-dev

- close Lot 2 `pending list` diagnostics at the runtime boundary so locator,
  snapshot, and filesystem errors map to closed public codes
  (`PENDING_LIST_INVALID`, `PENDING_WORKSPACE_REQUIRED`, `PENDING_ROOT_UNSAFE`,
  `PENDING_CAPTURE_RACE`), and lock that contract in tests and the CLI
  reference;
- classify Lot 2 `pending list` as a read command in the CLI reference and lock
  its fail-closed diagnostics, exact `.dubsar-pending` basename, traversal
  refusals, and non-observation of references in tests;
- add Lot 3 explicit `pending promote` to append one human-confirmed pending
  candidate into the canonical `.dubsar/checkpoints.json` chain without altering
  `.dubsar-pending/`;
- add Lot 2 minimal `pending list` for valid advisory candidates under
  `.dubsar-pending/` without classification, reference observation, or writes;
- add Lot 1 `pending record` for Git-tracked advisory checkpoint candidates under
  `.dubsar-pending/` without modifying canonical `.dubsar/` memory;
- add workspace-free runtime capability discovery for integrations and record
  the verified single-writer rule for parallel Git worktrees;
- Spec Kit extension 0.1.4 requires bootstrap `next_action` to describe the
  post-apply resume step and surfaces it in the human preview;
- Spec Kit extension 0.1.3 aligns compatibility documentation with the Spec Kit
  version actually tested (`0.16.4`);
- add optional Continuity CLI `bootstrap` for one atomic Create project memory
  with Active work and First recorded checkpoint (Spec Kit extension 0.1.2);
- add the human-readable `.dubsar/` Memory vNext format;
- add Work, Knowledge, Inbox, checkpoint, context and explicit migration flows;
- add Memory Guidance v2 with exact relations, artifact lifecycle and advisory
  Plan/Goal recommendations;
- make the public Continuity runtime self-contained across Codex, Claude Code
  and Cursor;
- add a read-only Continuity Dashboard with Resume, Memory and Graph views;
- expose resume and checkpoint only as thin optional host adapters;
- keep personal memory separate from project authority and project capsules.

This preview publishes source code and formats for evaluation. It does not
announce an npm release, hosted service, stable JavaScript API, or production
support commitment.
