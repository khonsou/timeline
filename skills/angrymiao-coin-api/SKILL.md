---
name: angrymiao-coin-api
description: Query AngryMiao Coin current-user permissions and tag data through the bundled TypeScript CLI. Use when an agent needs authenticated calls to permission/current-user, all tags, or current-user task tags.
---

# AngryMiao Coin API CLI

Use the bundled TypeScript CLI for the three supported read-only AngryMiao Coin
queries. The CLI uses Node 22's native TypeScript type stripping and has no
third-party runtime dependencies.

## Authentication gate

All three routes must be called with a usable AngryMiao Bearer token. Provide
the token with `--token` or `ANGRYMIAO_COIN_TOKEN`. The CLI refuses to send an
anonymous request and returns a structured `401` error when the token is
missing.

The customer and admin APIs may use different service origins. Configure them
with `--customer-base-url` / `ANGRYMIAO_COIN_CUSTOMER_BASE_URL` and
`--admin-base-url` / `ANGRYMIAO_COIN_ADMIN_BASE_URL`. `--base-url` or
`ANGRYMIAO_COIN_BASE_URL` is a fallback for a shared origin.

Before protected calls, verify that the token belongs to the intended logged-in
user. Do not print tokens in logs or include them in issue reports.

## Commands

Run from this directory with `node --no-warnings --experimental-strip-types`
or install the local package so the `angrymiao-coin` bin is available.

```bash
angrymiao-coin --json permission current-user
angrymiao-coin --json tags list --query page_size=100
angrymiao-coin --json tags current-user --query page_size=100
```

The commands call:

- `permission current-user` → customer `GET /api/permission/current-user`
- `tags list` → admin `GET /api/tags`
- `tags current-user` → customer `GET /api/task-tag`

Use repeated `--query KEY=VALUE` options for supported GET query parameters,
such as `page_size`, `page_number`, and `ordering`.

## Output contract

Use `--json` for agent workflows. Success and failure are JSON envelopes with
`ok`, `status_code`, and either `data` or `error`. HTTP responses also include
`meta.service` and `meta.request` so the caller can see the exact service,
method, path, URL, and query parameters used.

Do not infer success from process output alone: inspect `ok` and
`status_code`. Non-2xx backend bodies are preserved in `error`.

## Important tag semantics

`GET /api/task-tag` is the backend's current-user tag endpoint. Its service
implementation returns tags available to the logged-in user, including public
tags and tags explicitly available to that user; it is not a raw `taguser`
join-table dump. Use `tags list` when the requirement is the complete admin tag
catalog.

For endpoint details and query semantics, read
[references/api.md](references/api.md). The executable source is
[scripts/angrymiao-coin-cli.ts](scripts/angrymiao-coin-cli.ts).
