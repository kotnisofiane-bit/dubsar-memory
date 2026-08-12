# Contributing

DUBSAR Continuity accepts small, reviewable changes that preserve its local,
offline, deterministic boundary.

## Before changing code

- read `PUBLIC_BOUNDARY.md`;
- keep the public runtime independent from private DUBSAR products;
- do not add MCP, hooks, network clients, background services, or host-specific
  business logic;
- do not make personal memory authoritative for project state;
- do not expose additional skills without an explicit product decision.

## Validation

Run:

```bash
npm ci
npm test
```

Inventories and conformance manifests are regenerated only after the source and
tests are stable. Do not edit generated hashes by hand.

## Legacy material

Files under `legacy/` are retained for comparison and migration. They are not
active skills and must not be restored to marketplace manifests indirectly.
