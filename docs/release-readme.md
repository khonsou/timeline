# 发布 README —— Timeline Board 上线与升级操作手册

> 适用版本：v19（change-set 协议版）及以后
> 读者：负责发布的运维/开发
> 核心原则：**数据 = 一个 SQLite 文件；升级代码永远不动它；备份先行。**

---

## 0. 架构速览

```text
浏览器 ──► nginx ──► web/dist/（前端静态产物）
              └──► /api → pm2 托管的 packages/server/index.mjs（Node ≥ 22.5，零 native 依赖）
                                    │
                                    └─► SQLite 单文件（boards / audit_log / change_sets 三表同库）
```

- **所有用户数据都在 `BOARD_DB` 指向的那一个 SQLite 文件里**（看板、审计、变更集共用）
- schema 迁移在 server 启动时自动执行，幂等且纯增量（新表 IF NOT EXISTS、新列 ALTER 吞错），**不需要任何手工迁移步骤**
- 代码与数据完全分离：git 里没有任何用户数据（`boards.sqlite*` 已 gitignore）

## 1. 环境变量清单（pm2 `deploy/ecosystem.config.cjs` 的 env 块）

| 变量 | 默认 | 生产要求 |
|---|---|---|
| `BOARD_DB` | `packages/server/boards.sqlite` | **必须指到仓库目录外**，如 `/var/lib/timeline-board/boards.sqlite` |
| `BOARD_SECRET` | 随机生成 | **必须设固定值**：`openssl rand -hex 32` 生成一次，永久不变 |
| `API_PORT` | 8787 | 与 nginx 反代一致即可 |
| `BOARD_TOKEN_HOURS` | 12 | 按需 |
| `BOARD_LOCK_SECONDS` | 60 | 按需 |
| `BOARD_AGENT_RPM` | 120 | 按需；注意反代下需传真实客户端 IP，否则退化为每板全局限速 |
| `BOARD_CS_TTL_HOURS` | 24 | change-set 有效期，按需 |

**两条铁律：**

1. `BOARD_DB` 升级时绝不能碰、不能指错——指到不存在的路径时 server **不会报错，会静默建一个全新的空库**（网站表现为「被重置」，老数据还在老文件里，但新写入会分叉）。
2. `BOARD_SECRET` 一旦设定永久不变——变了不丢数据，但所有已发 token 验签失败，用户和第三方 agent 全部回密码门；不设固定值则**每次重启（含 pm2 崩溃自动重启）都会全员掉线**。

⚠ pm2 会缓存已存在应用的 env：改 ecosystem 配置后必须
`pm2 delete timeline-board-api && pm2 start deploy/ecosystem.config.cjs && pm2 save`
（或 `pm2 restart timeline-board-api --update-env`）才生效。
验证方式：启动日志里**没有** `⚠ 未设置 BOARD_SECRET` 警告 = 已生效。

## 2. 首次部署

```bash
# 1. 准备数据目录（仓库外）
sudo mkdir -p /var/lib/timeline-board && sudo chown $USER /var/lib/timeline-board

# 2. 拉代码、装依赖
git clone https://github.com/khonsou/timeline.git /opt/timeline-board
cd /opt/timeline-board && npm install

# 3. 配置 deploy/ecosystem.config.cjs：填 BOARD_SECRET（固定值）、BOARD_DB（仓库外路径）

# 4. 构建前端
npm run build          # 产物在 web/dist/

# 5. 配置 nginx：静态托管 web/dist/ + 反代 /api → 127.0.0.1:8787（参照 deploy/nginx.conf）

# 6. 启动并托管
pm2 start deploy/ecosystem.config.cjs && pm2 save && pm2 startup   # 按提示设开机自启

# 7. 验证（见第 4 节）
```

## 3. 版本升级（日常发布）

```bash
cd /opt/timeline-board

# 1. 备份（不停服，在线备份；含 WAL 一致性保证）
mkdir -p ~/timeline-backups
node -e "const{DatabaseSync}=require('node:sqlite');new DatabaseSync('/var/lib/timeline-board/boards.sqlite').exec(\"VACUUM INTO '$HOME/timeline-backups/boards-$(date +%F-%H%M).sqlite'\")"
ls -la ~/timeline-backups/   # 确认备份文件非 0 字节

# 2. 记录当前版本（回滚锚点）
git rev-parse --short HEAD

# 3. 更新代码
git pull && npm install

# 4. 重新构建前端
npm run build

# 5. 重启 API（启动时自动完成 schema 迁移；改了 env 才需要 --update-env）
pm2 restart timeline-board-api

# 6. 验证（见第 4 节）——全部通过即发布完成
```

**失败回滚：**

```bash
git checkout <第2步记录的commit> && npm install && npm run build
pm2 restart timeline-board-api
# 库有问题的极端情况：pm2 stop，用备份文件覆盖 BOARD_DB 指向的文件，再启动
```

## 4. 发布后验证清单（约 1 分钟）

```bash
# ① API 活着
curl -s http://127.0.0.1:8787/api/boards | head -c 200

# ② 数据在：浏览器打开看板列表 → 进板，卡片/产品/成员完整
# ③ 审计在（历史行新字段为 null 是正常的）
curl -s http://127.0.0.1:8787/api/boards/<board_id>/audit -H "Authorization: Bearer <token>"

# ④ 新协议活着：建一个变更集并提交，确认卡片出现
#    （完整示例见 examples/agent-quickstart.mjs）
node examples/agent-quickstart.mjs --api https://你的域名 --board <测试板id> --password <密码> --commit

# ⑤ 日志干净
pm2 logs timeline-board-api --lines 50
#   无 ⚠ 未设置 BOARD_SECRET / 无 ALTER / SQLITE 报错
```

## 5. 风险点速查表

| 风险 | 表现 | 预防 | 恢复 |
|---|---|---|---|
| 发布方式覆盖库文件 | 数据全没了 | 用 `git pull` 发布；禁止删目录重 clone / `rsync --delete`；BOARD_DB 放仓库外 | 备份文件还原 |
| `BOARD_DB` 指错路径 | 网站「像被重置」 | 改配置后先看启动日志的库路径 | 改回正确路径重启（中间新写入需手工合并） |
| `BOARD_SECRET` 变化/未固定 | 全员回密码门 | 固定值写进 ecosystem | 人设了重输密码即可；agent 需有 401 重认证逻辑 |
| pm2 缓存旧 env | 改了配置不生效 | 改 env 用 `pm2 delete + start` 或 `--update-env` | — |
| 迁移异常（磁盘满等） | 审计/变更集写入报错 | 发布时瞄一眼 pm2 日志 | 解决磁盘问题后重启（迁移幂等，会自愈） |

## 6. 长期运维建议

- **每日备份**：cron 每天执行第 3 节第 1 步的 VACUUM INTO 命令，保留 30 天（与协议「终态变更集保留 30 天」配套）
- **磁盘监控**：SQLite 单文件随审计增长，关注数据目录所在盘
- **CHANGELOG 习惯**：每次发布前 `git log --oneline <上次commit>..HEAD` 过一遍变更，特别留意 `packages/server` 的改动是否含新环境变量（看 `docs/deployment.md` 环境变量表是否同步更新）

---

相关文档：[协议 PRD](protocol-prd.md) · [Agent API 手册](agent-api.md) · [部署详解](deployment.md)
