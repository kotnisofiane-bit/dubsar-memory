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

The public memory engine and Workbench do not require credentials, network
access, hooks, MCP servers, or access to a private DUBSAR service. Treat any
contribution that adds one of those capabilities as a security-sensitive design
change requiring explicit maintainer review.

Project memory is not a secrets vault. Do not record credentials, private keys,
access tokens, customer data, or unnecessary personal data in Work, Knowledge,
Inbox, checkpoints, proposals, or generated views. Built-in filters reduce
accidental disclosure but are not a substitute for proper secret management.
