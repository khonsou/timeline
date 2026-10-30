# Timeline GitOps

This directory is the GitOps source of truth for the Timeline Board `prod` and
`test` environments. `deploy/deploy.sh` and `deploy/k8s/` remain as a legacy
fallback and must not run against the same resources while Argo CD is managing
them.

| Environment | Namespace | URL | Data |
|---|---|---|---|
| prod | `angrymiao-prod` | `https://timeline.angrymiao.com/aVoSaywtHjXCA` | `timeline-board-data` |
| test | `angrymiao-test` | `https://timeline.angrymiao.com/test` | `timeline-board-test-data` |

## Layout

- `base/` — backend/frontend Deployments, Services, and Ingress.
- `overlays/prod/` — `angrymiao-prod`, base path `/aVoSaywtHjXCA`, prod images.
- `overlays/test/` — `angrymiao-test`, base path `/test`, test images.
- `bootstrap/` — NAS PV/PVC definitions; applied once and outside Argo CD.

The initial overlays use the live public-ACR tags so the first Argo CD sync is a
no-op. The release workflow replaces them with
`registry-vpc.cn-shenzhen.aliyuncs.com/angrymiao/timeline` and
`backend-<env>-sha-<commit>` / `frontend-<env>-sha-<commit>`.

## Release

1. GitHub Actions -> `ci` -> Run workflow.
2. Choose `environment` (`test` or `prod`).
3. Leave `image_tag` empty, set `runner` to `github-hosted`, enable
   `push_image` and `release`.
4. The workflow builds the backend and the base-path-specific frontend, then
   updates the matching overlay.
5. Review `argocd app diff timeline-<env>`, then sync it.
6. Verify:
   - prod: `curl -fsS https://timeline.angrymiao.com/aVoSaywtHjXCA/api/health`
   - test: `curl -fsS https://timeline.angrymiao.com/test/api/health`

The backend is a single-replica `Recreate` Deployment on a SQLite file. A prod
release briefly stops the API. Back up the database before the first prod sync.

## Backup before a prod release

The backend image has Node's built-in `node:sqlite`; create a consistent copy
inside the running Pod:

```bash
POD=$(kubectl -n angrymiao-prod get pod -l app=timeline-backend -o jsonpath='{.items[0].metadata.name}')
kubectl -n angrymiao-prod exec "$POD" -- node -e "
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync('/data/boards.sqlite');
  db.exec(\"VACUUM INTO '/data/boards-backup.sqlite'\");
"
kubectl -n angrymiao-prod cp "$POD:/data/boards-backup.sqlite" ./boards-backup.sqlite
python -c "import sqlite3; print(sqlite3.connect('boards-backup.sqlite').execute('PRAGMA integrity_check').fetchone()[0])"
kubectl -n angrymiao-prod exec "$POD" -- rm -f /data/boards-backup.sqlite
```

Store the downloaded file outside the repository. If `VACUUM INTO` is
unavailable, scale the backend to zero, copy `boards.sqlite`,
`boards.sqlite-wal`, and `boards.sqlite-shm` together, then scale back.

## Rollback

Run the workflow again with the previous `image_tag` and the same
`environment`, or revert the overlay commit, then sync the matching Argo CD
Application.

## Secrets

These are out of band and already exist:

- `timeline-board-secret` — `BOARD_SECRET`
- `aliyun-reg-secret` — ACR pull credentials (public and VPC entries)
- `am-tls` — wildcard certificate

Do not commit secret values. The two environments must use different
`BOARD_SECRET` values.

## Notes

- prod and test share the host `timeline.angrymiao.com` but use different base
  paths and namespaces.
- The backend and frontend images are tagged per environment because the
  frontend bakes its base path at build time.
- The PVs use the NAS CSI driver and `Retain`; never delete them from Argo CD.
- Do not run `deploy/deploy.sh` and Argo CD against the same Deployment at the
  same time.