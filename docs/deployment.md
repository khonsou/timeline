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
| `BOARD_AGENT_RPM` | `120` | v18 item 级端点限速（每 board 每 IP 次/分钟） |

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
