# AngryMiao Coin endpoint reference

The CLI targets the backend's `/api` base path. Set the service origin without
the `/api` suffix.

| CLI command | Service | HTTP request | Auth |
|---|---|---|---|
| `permission current-user` | customer | `GET /api/permission/current-user` | Bearer token |
| `tags list` | admin | `GET /api/tags` | Bearer token |
| `tags current-user` | customer | `GET /api/task-tag` | Bearer token |

The two tag endpoints are paginated by the backend. Pass query pairs with
repeated `--query` flags:

```bash
angrymiao-coin --json tags list \
  --query page_size=100 \
  --query page_number=1 \
  --query ordering=-id
```

`tags list` is the admin catalog. `tags current-user` follows the customer
handler's `GetTaskUserTag` behavior: the response contains tags visible to the
current user, which can include public tags in addition to user-specific tags.

Example environment setup:

```bash
export ANGRYMIAO_COIN_TOKEN="<bearer-token>"
export ANGRYMIAO_COIN_CUSTOMER_BASE_URL="https://<customer-host>"
export ANGRYMIAO_COIN_ADMIN_BASE_URL="https://<admin-host>"
angrymiao-coin --json permission current-user
```

Do not store the bearer token in this reference, in source control, or in
command output.
