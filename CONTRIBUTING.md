# Contributing to DUBSAR Memory

DUBSAR Memory accepts small, reviewable changes that preserve its local,
offline, deterministic boundary. Continuity is the first workflow built on the
engine; host skills are optional adapters rather than the architectural core.

## Before changing code

- read `PUBLIC_BOUNDARY.md`;
- keep the public runtime independent from private DUBSAR products;
- do not add MCP, hooks, network clients, background services, or host-specific
  business logic;
- do not make personal memory authoritative for project state;
- do not make a host adapter authoritative or add host-specific behavior to the
  memory runtime;
- do not expose additional adapters without an explicit product decision.

## Validation

Run:

```bash
npm ci
npm test
```

Inventories and conformance manifests are regenerated only after the source and
tests are stable. Do not edit generated hashes by hand.

## Scope and compatibility

Files under `legacy/` and the frozen Audit Readiness package are compatibility
source, not active product surfaces. Do not restore them to manifests, package
inventories, or user documentation indirectly.
