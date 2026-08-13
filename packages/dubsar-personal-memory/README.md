# @dubsar/personal-memory

Private, optional, local advisory memory for DUBSAR Continuity Public v1.

On Windows the package uses one fixed root:
`%LOCALAPPDATA%\DUBSAR\Memory`. It creates exactly five Markdown files and
never reads or imports a project's `./memory` directory.

The package is intentionally separate from `@dubsar/operator-core`. Its data
cannot affect project integrity, readiness, work-package eligibility, next
actions, or resume capsules.

Use the human-only CLI commands:

```text
dubsar memory init
dubsar memory add --category decisions|learnings|blockers|evals
```

Every publication requires an exact terminal confirmation. The package is
private and unreleased pending a public-license and provenance decision.
