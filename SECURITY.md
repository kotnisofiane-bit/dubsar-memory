# Security policy

## Supported version

Security fixes target the latest release on the default branch.

## Reporting

Do not open a public issue for a suspected vulnerability or accidental
credential disclosure. Use GitHub's private vulnerability reporting feature
for this repository.

Include the affected pack and version, a minimal reproduction, the expected
impact, and whether the report involves a generated audit bundle.

## Security boundary

The public source and any future packs are offline preparation tools. They do not require
credentials, network access, hooks, MCP servers, or access to a private DUBSAR
service. Treat any contribution that adds one of those capabilities as a
security-sensitive design change requiring explicit maintainer review.
