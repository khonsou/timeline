# Timeline CI/CD

## 版本号

test 和 prod 分别按各自最新 tag 递增：

```bash
git fetch --tags
git tag -l 'test-v*' --sort=-v:refname | head -5
git tag -l 'prod-v*' --sort=-v:refname | head -5
```

第一次发 test/prod 用 `test-v0.0.1` / `prod-v0.0.1`；之后按各自最新 tag 递增，两个序列不要混用。

## 发布 test

```bash
cd /e/timeline
git checkout main
git pull --ff-only
git tag test-v0.0.1
git push origin test-v0.0.1

argocd app diff timeline-test
argocd app sync timeline-test
```

验证：

```bash
curl -fsS https://timeline.angrymiao.com/test/api/health
```

## 发布 prod

test 验证通过后再发 prod：

```bash
cd /e/timeline
git checkout main
git pull --ff-only
git tag prod-v0.0.1
git push origin prod-v0.0.1

argocd app diff timeline-prod
argocd app sync timeline-prod
```

验证：

```bash
curl -fsS https://timeline.angrymiao.com/aVoSaywtHjXCA/api/health
```

prod 发布前先备份 SQLite，命令见 `deploy/gitops/README.md`。

## 手动触发

GitHub → Actions → `ci` → Run workflow：

- `environment`：`test` 或 `prod`
- `image_tag`：留空构建当前 commit；填已有 sha suffix 则跳过构建
- `runner`：`github-hosted`
- `push_image`：推 ACR
- `release`：更新对应部署分支

## 回滚

用旧镜像 suffix 重跑 workflow（`environment` + `image_tag=sha-xxxx` + `release=true`），然后在 Argo CD Sync。

## 约定

- test：`test-v*` → `deploy-timeline-test` → `timeline-test`
- prod：`prod-v*` → `deploy-timeline-prod` → `timeline-prod`
- 普通 `v*` 不会触发
- tag 必须打在 `main` 上，不要在部署分支上打 tag 或提交代码
- CI 只推部署分支，不推 main
- 镜像 tag：`backend-<env>-sha-<commit>`、`frontend-<env>-sha-<commit>`