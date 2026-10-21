# Reference Customer 360 / CDP

> Live demo: _TBD_ · Architecture: [docs/architecture.md](docs/architecture.md)

## Problem
Customer data lives in silos — ad platforms, CRM, web analytics — with no reliable single view of who a customer is, and no agreed definition of when a lead becomes an MQL.

## Approach
- Raw → core layered PostgreSQL model with idempotent loaders.
- Identity stitching (deterministic + probabilistic, reusing the Entity Resolution Toolkit).
- Explicit lifecycle definitions, rule-based lead scoring with decay.
- Five attribution models, property-tested.
- Next.js dashboard; Terraform-deployed.

## Result
_Fill with measured numbers: profiles unified, stitch precision, dashboard p95 load time._

## Run it
Needs Docker, Node 22+ and pnpm. `pnpm seed` also runs identity stitching, so it needs [`uv`](https://docs.astral.sh/uv/) as well. dbmate runs in a container; you don't install it.

```bash
docker compose up -d && pnpm install && pnpm db:migrate && pnpm seed && pnpm dev
```

`docker compose up -d` starts Postgres 16 (port 5432) and adminer (http://localhost:8080) and applies pending migrations. `pnpm db:migrate` does the same and is safe to rerun. Use `pnpm db:rollback` and `pnpm db:status` to undo the last migration or list them.

> **Status:** M1. The schema, local stack and CI exist. `pnpm seed` arrives in M2–M3 and `pnpm dev` in M7.
