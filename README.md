# Multi-platform comment system

Read the comment thread for a published post, and reply to a comment, across social platforms.

- [`DESIGN.md`](DESIGN.md) — the narrative: assumptions, schema, API, key decisions.
- [`ADRS.md`](ADRS.md) — the decision records the design draws on.

```bash
docker compose up --build
```

`api` on :3000, with `postgres` and `dragonfly` on the same network. The schema is pushed at
startup. Then:

```bash
curl localhost:3000/api/v1/health/ready
```

Interactive API docs at `http://localhost:3000/api/v1/docs`. `npm run openapi` writes
`docs/openapi.json` and a rendered `docs/openapi.html`.

Locally: `npm install && npx prisma generate`, then `npm run typecheck` and `npm test`.
Every request needs an `x-workspace-id` header — see `DESIGN.md` §6.
