# 部署指南（v15 多用户看板服务）

拾光轴 v15 起是**多用户看板服务**：前端静态产物 + Node API server（SQLite 单表存储）。
本文以阿里云 ECS（Ubuntu/CentOS 通用）为例，给出一台机器从零到上线的完整步骤；
任何支持 Node ≥ 22.5 的 Linux 主机同理。

## 架构

```
浏览器 ──► nginx :80 ──静态──► web/dist/（npm run build 产物）
                └── /api ──► 127.0.0.1:8787  Node API server（pm2 托管）
                                                  └── SQLite（packages/server/boards.sqlite，WAL）
```

- **API server**：`packages/server/index.mjs`（@timeline/server），零 native 依赖（node:http + node:sqlite + node:crypto），Node 直接运行，无需构建。
- **数据**：单表 `boards`（board_id / name / doc JSON / version / password_hash / 时间戳）+ v18 起 `audit_log`（PATCH 逐字段审计），整板 JSON 覆盖写（LWW）。
- **鉴权**：密码 → scrypt 哈希校验 → HMAC token（默认 12h）；同板连续 5 次失败锁 60s。

## 1. 环境准备

```bash
# Node.js ≥ 22.5（node:sqlite 要求；建议 24 LTS），例：NodeSource
curl -fsSL https://rpm.nodesource.com/setup_24.x | sudo bash -   # CentOS/Alinux
sudo yum install -y nodejs
# 或 Ubuntu：curl -fsSL https://deb.nodesource.com/setup_24.x | sudo bash - && sudo apt install -y nodejs

node -v   # 确认 ≥ 22.5
sudo npm i -g pm2 nginx
```

## 2. 构建与部署文件

```bash
# 本地或服务器上构建前端
npm ci
npm run build          # 产物在 web/dist/

# 服务器目录规划（示例）
sudo mkdir -p /var/www/timeline-board /var/lib/timeline-board
sudo cp -r web/dist/* /var/www/timeline-board/      # 前端静态产物
# 项目本体（packages/ 与 deploy/）放到如 /opt/timeline-board
```

> 说明（v19 起）：`packages/server/index.mjs` 运行时只依赖 Node 内置模块 + `@timeline/core`
> （packages/core，Node 24 strip-types 直引 .ts，零构建）；**需连同 packages/server 与
> packages/core 两个目录一起部署**（保留 packages/ 相对结构，或保留根 node_modules 的
> @timeline/core 软链），BOARD_DB 指向数据目录。

## 3. 启动 API server（pm2）

```bash
cd /opt/timeline-board
# 生成固定 token 签名密钥并写入 ecosystem 配置（必做！否则重启后所有 token 失效）
openssl rand -hex 32
# 编辑 deploy/ecosystem.config.cjs：取消 BOARD_SECRET 注释并填入上面的随机串；
# 数据目录建议显式指定 BOARD_DB=/var/lib/timeline-board/boards.sqlite
pm2 start deploy/ecosystem.config.cjs
pm2 save && pm2 startup   # 开机自启
curl http://127.0.0.1:8787/api/health   # → {"ok":true}
```

### 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `API_PORT` | `8787` | API 监听端口 |
| `BOARD_DB` | `packages/server/boards.sqlite` | SQLite 文件路径 |
| `BOARD_SECRET` | 随机（警告） | token HMAC 密钥，**生产必须设为固定值** |
| `BOARD_TOKEN_HOURS` | `12` | token 有效期（小时） |
| `BOARD_LOCK_SECONDS` | `60` | 同板连续 5 次密码失败后的锁定时长（秒） |
| `BOARD_AGENT_RPM` | `120` | item 级与 change-set 端点限速（每 board 每 IP 次/分钟，同一限速桶） |
| `BOARD_CS_TTL_HOURS` | `24` | change-set 有效期（小时；到期惰性标记 expired 不得提交，允许小数值便于测试） |
| `BOARD_DISCOVERY_RPM` | `30` | 自发现端点（`/api/meta`、`/api/agent-doc`）限速（每 IP 次/分钟，独立于 board 级 agent 桶） |
| `BOARD_AGENT_DOC_PATH` | 仓库根 `docs/agent-api.md` | `/api/agent-doc` 返回的协议文档路径；读不到时降级为内置最小摘要（记 warn 日志，仍 200） |

## 4. nginx 反代

```bash
sudo cp deploy/nginx.conf /etc/nginx/conf.d/timeline-board.conf
# 编辑：server_name 改域名/IP；root 改 dist 实际路径
sudo nginx -t && sudo systemctl reload nginx
```

要点（已体现在 `deploy/nginx.conf`）：

- `location /api/` → `proxy_pass http://127.0.0.1:8787`，`client_max_body_size 10m`（对齐 server 8MB 上限）。
- `location /` → `try_files $uri $uri/ /index.html`：**前端 history 路由（`/b/:id`）必需**，否则刷新看板页 404。
- 安全组/防火墙放行 80（或 443）；8787 只监听回环，不对外。

## 5. 数据备份与恢复

全部数据都在一个 SQLite 文件里（WAL 模式）：

```bash
# 备份（推荐 sqlite3 .backup 在线备份；无 sqlite3 时直接拷贝三个文件）
sqlite3 /var/lib/timeline-board/boards.sqlite ".backup '/backup/boards-$(date +%F).sqlite'"
# 或停机/确保无写入时：cp boards.sqlite boards.sqlite-wal boards.sqlite-shm /backup/

# 定时备份（crontab 示例：每天 03:17）
17 3 * * * sqlite3 /var/lib/timeline-board/boards.sqlite ".backup '/backup/boards-$(date +\%F).sqlite'"
```

恢复：停 pm2 应用 → 用备份文件替换 `boards.sqlite`（连同 -wal/-shm）→ 重启。

## 6. 升级

```bash
git pull            # 或上传新包
npm ci && npm run build
sudo cp -r web/dist/* /var/www/timeline-board/
pm2 restart timeline-board-api    # packages/server 或 packages/core 有变化时
```

## 7. 安全须知

- **密码不可逆**：scrypt 加盐哈希存储（`scrypt:<salt>:<hash>`），服务端不存明文；忘记密码 = 该板无法进入（数据仍在，可运维手段重置——直接改库里的 password_hash）。
- **删除看板必须重新输密码**（不认 token），物理删除不可恢复，请依赖 §5 备份兜底。
- token 存于浏览器 sessionStorage（按板一键），关标签页即失效；12h 后服务端过期。
- 建议上 HTTPS（certbot）：看板密码与 token 均走网络明文传输，裸 HTTP 仅限内网/试用。

## 8. Kubernetes test / prod 部署

共用域名和 OAuth Client，按 URL 路径与 Kubernetes namespace 隔离：

| 环境 | namespace | 地址 | NAS 路径 |
| --- | --- | --- | --- |
| prod | `angrymiao-prod` | `https://timeline.angrymiao.com/aVoSaywtHjXCA` | `/timeline-board`（原 test 数据） |
| test | `angrymiao-test` | `https://timeline.angrymiao.com/test` | `/timeline-board-test`（新库） |

发布命令为 `bash deploy/deploy.sh <test|prod> <1|2>`；`1` 更新后端，`2` 更新前端。例如：

```bash
bash deploy/deploy.sh prod 1
bash deploy/deploy.sh prod 2
bash deploy/deploy.sh test 1
bash deploy/deploy.sh test 2
```

首次 test 部署如果没有 `timeline-board-secret`，须通过 `BOARD_SECRET` 环境变量提供固定密钥。prod 首次部署会复用 test 当前的密钥，并复制 test namespace 的 `aliyun-reg-secret` 与 `am-tls`。prod 与 test 部署后应使用不同的 `timeline-board-secret`。

Auth 保持同一个 `timeline` Client；必须把 `https://timeline.angrymiao.com/test/oauth/callback` 加入 redirect URI 白名单，prod 回调地址维持原值。前端按访问路径生成回调地址。

一次性迁移必须按此顺序执行，禁止两个后端同时挂载原卷：

1. 先确认 test 新 PVC `timeline-board-test-data` 已 Bound 且 `/data/boards.sqlite` 不存在。
2. 将 test 后端缩到 0，确认 Pod 已退出；此后旧库不再有写入。立即做一份新的 SQLite 一致性备份，下载到集群外并验证 `integrity_check`、看板数、审计数和变更集数。此前的备份只作额外保险，不能代替切换前快照。
3. 删除的只能是旧 PVC `angrymiao-test/timeline-board-data`；不要删除 PV `timeline-board-nas`，它的回收策略是 `Retain`。
4. 清除旧 PV 的 claimRef：`kubectl patch pv timeline-board-nas --type=merge -p '{"spec":{"claimRef":null}}'`。确认该 PV 为 Available 后，运行 `bash deploy/deploy.sh prod 1`，使 prod PVC 接管原 NAS `/timeline-board`。
5. 验证 prod PVC 为 Bound、prod SQLite `integrity_check` 为 `ok`，并核对看板/审计/变更集数与切换前快照一致后，才算数据切换完成。
6. prod 首次部署已复制旧 test 的签名密钥后，再为 test 生成独立密钥并运行 `bash deploy/deploy.sh test 1`。test 后端只挂载新 `/timeline-board-test`：

   ```bash
   BOARD_SECRET="$(openssl rand -hex 32)"
   kubectl create secret generic timeline-board-secret -n angrymiao-test \
     --from-literal="BOARD_SECRET=$BOARD_SECRET" --dry-run=client -o yaml \
     | kubectl apply -f -
   unset BOARD_SECRET
   ```

7. test OAuth 回调白名单登记完成后，再运行 `bash deploy/deploy.sh test 2` 切换 test 前端路由。prod 保持 `/aVoSaywtHjXCA`。

如果第 3 步后 prod 未能绑定，先停止 prod 后端，保留 PV 和外部备份，再处理 claimRef/PVC；不要格式化、删除 NAS 子目录或让 test 后端重新挂载正在被 prod 使用的原卷。test 新卷使用独立 `timeline-board-test-nas` PV，回收策略同样为 `Retain`。

镜像使用 Git 提交号作为 Tag；工作区有未提交改动时会追加时间戳。脚本在应用资源前执行 server-side dry-run，并使用 `kubectl apply` 更新。后端是单副本 `Recreate` Deployment，SQLite 路径为 `/data/boards.sqlite`。NAS 故障或误删仍需依靠独立备份或 NAS 快照恢复。

发布脚本会拒绝在原 NAS 卷仍绑定 test 时开始 prod 发布；prod 前端还要求生产 PVC 已 Bound 到原卷。
