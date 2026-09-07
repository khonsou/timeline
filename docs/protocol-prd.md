# Timeline Board Automation Protocol — PRD & 第三方接入 README

> 版本：v1.0（协议冻结版）
> 日期：2026-09-07
> 读者：Timeline 服务端/前端/CLI 开发者；第三方 Timeline Agent 开发团队
> 状态：基础协议已冻结。新增能力只允许追加上层协议与新字段，不允许修改本文档定义的端点语义。

---

## 1. 这是什么

Timeline Board（拾光轴）是一个时间轴看板：横轴为日期，纵列为当天的内容卡片。本协议是**看板数据自动化的唯一写入口径**，服务于四类客户端：

```text
CLI 批量导入
第三方 Agent（策划生成、数据回填等）
外部 Cron / 定时任务
网页端（迁移后）
```

### 稳定语义（六句话）

```text
外部 Agent 执行        —— Server 不执行、不调度、不生成、不抓取
Change Set 负责提案和确认
base_version 负责并发控制
commit 负责原子提交
core 负责最终校验
audit 负责完整溯源
```

### 协议边界

基础协议只负责：**卡片读写、原子变更、版本冲突检测、审计**。

以下全部属于上层能力，协议不规定其实现：Agent 如何执行、策划方案如何拆卡、发布 URL 如何访问、数据如何抓取、任务如何定时、谁负责 review。

---

## 2. 端点总览

```http
POST  /api/boards/:id/auth                              # 鉴权（既有）

GET   /api/boards/:id/items                             # 卡片列表（过滤）
GET   /api/boards/:id/items/:item_id                    # 单卡详情
PATCH /api/boards/:id/items/:item_id                    # 单卡局部更新（白名单）

POST  /api/boards/:id/change-sets                       # 创建变更集（提案）
GET   /api/boards/:id/change-sets/:change_set_id        # 查询变更集（review）
POST  /api/boards/:id/change-sets/:change_set_id/commit # 原子提交（确认）
POST  /api/boards/:id/change-sets/:change_set_id/cancel # 人工取消

GET   /api/boards/:id/products                          # 产品目录（既有）
GET   /api/boards/:id/members                           # 成员目录（既有）
GET   /api/boards/:id/audit                             # 审计（溯源）
```

> `cancel` 端点为冻结评审补丁：状态机中「人工取消 → rejected」必须有协议入口。
> 资源命名：Card 是业务概念，Item 是协议资源名；不引入 `/v1/cards`，不做路径重命名。

---

## 3. 鉴权

与人共用一套，无独立 agent 密钥体系。

```http
POST /api/boards/:id/auth
Content-Type: application/json

{"password": "看板访问密码"}
```

```json
{"token": "<base64url(payload).base64url(HMAC-SHA256)>", "expires_at": "..."}
```

- 后续请求携带 `Authorization: Bearer <token>`。
- 默认有效期 12 小时（`BOARD_TOKEN_HOURS` 可调）。
- 密码错误 → `403`；同板连续 5 次失败锁定 60 秒 → `429` + `retry_after`。
- token 缺失/过期/签名不符 → `401`。

### actor 身份（冻结评审补丁）

审计要求记录执行者。第一版规则：

```text
actor 与 source 由客户端在创建 change-set / 发起 PATCH 时自报，
服务端原样透传记录，不做真实性校验（防君子不防小人）。
未来如引入带身份的 agent token，actor.id 改由 token 载荷派生，
届时旧自报字段作废但端点形状不变。
```

---

## 4. 资源模型

### 4.1 Item（卡片）

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 服务端分配，客户端不可指定（CLI 兼容导入层除外） |
| `title` | string | 非空 |
| `type` | enum | `图文 / 视频 / 音频 / 直播 / 数据` |
| `publish_at` | string | 归一化为 `YYYY-MM-DDTHH:mm`；接受 `YYYY-MM-DD HH:mm`、`YYYY/M/D H:mm` 等输入 |
| `status` | enum | `待执行 / 待发布 / 已发布` |
| `product_id` | string \| null | 空 = 未归属；未知 id 原样保留，不动产品目录 |
| `content_owner_id` / `delivery_owner_id` | string \| null | 传 id 或姓名；**未知姓名自动登记新成员**（id 格式 `M-<序号>`），空 = 未分配 |
| `roi` / `propagation_4h` / `engagement_4h` | number \| null | 非负有限数；空 → null |
| `comment` | string | 人工备注，**不是机器协议** |
| `links` | array | **新增**。结构化链接，见 §8 |

**内建联动规则（与 UI 一致）：**

1. **指标 gate**：变更后最终 `status ≠ 已发布` → `roi / propagation_4h / engagement_4h` 强制置 null。发布填指标请同帧带上 `status: 已发布`。
2. **orders 联动**：`publish_at` 跨日 → 排到目标日列末尾；同日改时间 → 列内顺序不变。

### 4.2 Change Set（变更集）

```json
{
  "change_set_id": "cs-001",
  "board_id": "board-001",
  "status": "pending",
  "base_version": 42,
  "operations": [ ... ],
  "source": {"type": "agent", "external_run_id": "run-20260907-001"},
  "actor":  {"type": "agent", "id": "agent-content-01"},
  "created_at": "...",
  "expires_at": "...",
  "result": null
}
```

**状态机（终态不可逆）：**

```text
pending
  ├── commit 成功        → committed
  ├── base_version 过期  → conflicted
  ├── core 校验失败      → rejected
  ├── 到期未提交         → expired
  └── 人工 cancel        → rejected
```

- 创建时服务端写入 `expires_at`，**默认有效期 24 小时**，到期不得提交。
- 过期为**惰性标记**（查询/提交时判定），服务端无后台 worker；外部 Cron 可定期清理终态记录。
- 终态记录保留 30 天；审计记录长期保留。

### 4.3 Audit（审计）

```json
{
  "id": "audit-001",
  "ts": "2026-09-07T09:00:00Z",
  "board_id": "board-001",
  "item_id": "item-001",
  "field": "engagement_4h",
  "old_value": null,
  "new_value": 860,
  "actor": {"type": "agent", "id": "agent-content-01"},
  "source": {"type": "agent", "external_run_id": "run-20260907-001"},
  "change_set_id": "cs-001",
  "request_id": "req-001"
}
```

- 逐字段一条记录；同一次提交共用同一 `ts`。
- 直接 `PATCH` → `change_set_id = null`；change-set 提交 → 必填，`source` 逐条复制。
- 无变化的写入不产生审计、version 不增（幂等）。
- 历史审计条目允许新字段为 `null`；新写入必须完整填充。
- 审计只覆盖协议写路径；页面人工编辑在迁移完成前无逐字段审计。

---

## 5. 端点详细定义

### 5.1 查询卡片

```http
GET /api/boards/:id/items?date=2026-09-10&status=待发布&q=日报&product_id=P-2001&member=赵六
```

| 参数 | 语义 |
|---|---|
| `date` | `publish_at` 日期前缀匹配（`YYYY-MM-DD`） |
| `product_id` | 精确匹配 |
| `member` | id 或姓名；命中内容/投放负责人任一；未知姓名 → 空数组 |
| `status` | 三态精确匹配 |
| `q` | 标题或 comment 包含，大小写不敏感 |

均可选、可叠加（AND）。结果按 `publish_at` 升序。

### 5.2 单卡详情

```http
GET /api/boards/:id/items/:item_id
```

返回完整字段（含 comment、links）。不存在 → `404 {"error": "卡片不存在"}`。

### 5.3 单卡局部更新

```http
PATCH /api/boards/:id/items/:item_id
If-Match: 42                      # 可选（冻结评审补丁）
Content-Type: application/json

{"status": "已发布", "engagement_4h": 860}
```

- 白名单字段：`title, type, status, publish_at, product_id, content_owner_id, delivery_owner_id, roi, propagation_4h, engagement_4h, comment, links`。
- 白名单外字段（含 `id`、`orders`）→ `400 不支持修改的字段: xxx`。
- **`If-Match` 为可选**：携带则当前 version 不符返回 `409 VERSION_CONFLICT`；不携带维持最后一次写胜（兼容模式，迁移完成后将转为强制）。
- 校验规则与 CLI / UI 导入同源（core 纯函数），错误文案中文、多错误 `；` 拼接。
- 响应：有变化 → `{changed: true, version, item}` 且逐字段审计；无变化 → `{changed: false, version, item}`。

### 5.4 创建变更集

```http
POST /api/boards/:id/change-sets
Content-Type: application/json

{
  "base_version": 42,
  "source": {"type": "agent", "external_run_id": "run-20260907-001"},
  "actor":  {"type": "agent", "id": "agent-content-01"},
  "operations": [
    {"op": "create", "client_ref": "plan-row-001",
     "item": {"title": "发布会切片", "publish_at": "2026-09-10T10:00"}},
    {"op": "patch", "item_id": "item-001",
     "changes": {"comment": "Agent 已完成数据回填"}}
  ]
}
```

- 服务端做**预校验**（格式类错误尽早暴露），保存为 `pending`，返回完整 change-set（含 `expires_at`）。
- `base_version` 取创建时的看板 version；**真正的并发检查发生在 commit**。
- `client_ref` 用于客户端追踪 create 结果；卡片 id 由服务端分配，写入提交结果，同一 change-set 重试 id 不变。

### 5.5 查询变更集

```http
GET /api/boards/:id/change-sets/:change_set_id
```

返回状态、operations、结果或失败原因。客户端 review 与重试前状态检查均用此端点。

### 5.6 提交变更集

```http
POST /api/boards/:id/change-sets/:change_set_id/commit
Idempotency-Key: commit-abc-123
```

**事务内顺序：**

```text
读取当前 board
→ 检查 change-set 状态（非 pending 拒绝）
→ 检查 expires_at
→ 检查 current_version == base_version
→ 在当前快照上按序应用 operations
→ 重新执行 core 全量校验（字段格式 / 指标 gate / 负责人解析 /
   产品归属 / 2000 张上限 / 重复 id / publish_at / orders）
→ 整体写入，board.version + 1
→ 逐字段写审计（带 actor / source / change_set_id / request_id）
```

**结果：**

```text
全部通过     → committed，返回 {version, items: [{client_ref, id}...]}
校验失败     → rejected，看板零变化，不允许部分提交
版本不一致   → 409 VERSION_CONFLICT，change-set → conflicted，看板零变化
```

**幂等规则：**

```text
同 change_set_id + 同 Idempotency-Key 重试 → 返回首次提交结果，不重复写入，不 409
同 Idempotency-Key + 不同请求内容        → 409 IDEMPOTENCY_KEY_REUSE
无幂等键：先 GET 状态再决定——committed 用旧结果；pending 可重提；
          conflicted / expired / rejected 须新建 change-set
```

### 5.7 取消变更集

```http
POST /api/boards/:id/change-sets/:change_set_id/cancel
```

`pending → rejected`（终态）。已终态的变更集返回 `409`。

### 5.8 审计查询

```http
GET /api/boards/:id/audit?limit=50
```

id 倒序；limit 上限 200，非正整数回落 50。

---

## 6. Operations 语义（v1 仅 create / patch）

| op | 说明 |
|---|---|
| `create` | 服务端分配 id；`client_ref` 追踪；同一日期新卡按 operations 顺序追加到列尾，已有卡片顺序不变 |
| `patch` | 同单卡 PATCH 白名单与校验规则；`publish_at` 跨日 → 目标日列尾，同日 → 顺序不变 |
| ~~delete~~ | **v1 不支持**（破坏审计链、误删代价高）；未来优先增加可恢复的 `archive` |
| ~~reorder~~ | v1 不允许直接写 `order`；未来需要精确排序再单设 `reorder` op |

---

## 7. 错误码总表

| 码 | 场景 |
|---|---|
| `400` | 白名单外字段 / 校验失败 / 请求体非法 JSON / 超 2000 张上限 |
| `401` | token 缺失 / 过期 / 签名不符 |
| `403` | 密码错误 |
| `404` | 看板 / 卡片 / 变更集不存在 |
| `409 VERSION_CONFLICT` | commit 或 `If-Match` 版本不符 |
| `409 IDEMPOTENCY_KEY_REUSE` | 同幂等键不同内容 |
| `413` | 请求体超 8MB |
| `429` | 限速 / 密码锁定，带 `retry_after` |

检查顺序：404 看板 → 401 token → 429 限速（未过鉴权不耗配额）。

---

## 8. Schema 演进规则（以 `links` 为首例）

```json
{
  "links": [
    {"id": "link-001", "rel": "publish",
     "url": "https://example.com/post/123", "platform": "xiaohongshu"}
  ]
}
```

- `links` 是数组（不设计单一 `publish_url`）；`rel` 表示用途；`platform` 为可扩展字符串。
- **演进铁律：未来字段只能追加，不得改变已有字段语义。**
- `comment` 只作人工备注，机器协议一律走结构化字段。
- 迁移：旧 comment 中的 URL 可一次性转换到 `links`，原 comment 保留不变；新 Agent / CLI 只写 `links`。

---

## 9. 限速与容量

- 每板每 IP **120 次/分钟**（`BOARD_AGENT_RPM`），作用于 `/items` `/products` `/members` `/audit` **`/change-sets`**；整板 GET/PUT 与 auth 不计入。
- 限速与登录锁为内存滑动窗口，重启清零；反代部署需配置真实客户端 IP 传递，否则退化为每板全局限速。
- 单板 **2000 张**硬上限：change-set commit 时校验，超限全批拒绝。

---

## 10. 兼容与迁移

```text
第 1 步  保留现有读接口不变；新增 change-sets 端点与 cancel。
第 2 步  PATCH 支持可选 If-Match；整板 PUT 增加 If-Match/base_version 能力
         （旧无版本 PUT 标记为兼容模式，输出 deprecation 警告）。
第 3 步  CLI、页面写入全部改走 change-sets；旧 LWW 写路径最终废弃。
```

CLI 中允许外部指定卡片 id 的行为属于兼容导入层，不进入本协议语义。

---

## 11. 第三方 Agent 快速上手

### Use Case A：策划方案 → 生成卡片（人工确认后写入）

```bash
# 1. 鉴权
TOKEN=$(curl -sX POST $API/api/boards/$BOARD/auth \
  -d '{"password":"..."}' | jq -r .token)

# 2. 读当前版本（整板 GET 返回 version）
VER=$(curl -s $API/api/boards/$BOARD -H "Authorization: Bearer $TOKEN" | jq .version)

# 3. 创建变更集（提案）
curl -X POST $API/api/boards/$BOARD/change-sets \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d "{
    \"base_version\": $VER,
    \"source\": {\"type\":\"agent\",\"external_run_id\":\"run-001\"},
    \"actor\":  {\"type\":\"agent\",\"id\":\"my-agent\"},
    \"operations\": [
      {\"op\":\"create\",\"client_ref\":\"row-1\",
       \"item\":{\"title\":\"发布会切片\",\"type\":\"视频\",
                \"publish_at\":\"2026-09-10T10:00\",\"status\":\"待执行\"}}
    ]}"
# → 团队 GET change-set review，确认后：

# 4. 提交
curl -X POST $API/api/boards/$BOARD/change-sets/$CS/commit \
  -H "Authorization: Bearer $TOKEN" -H "Idempotency-Key: commit-run-001"
```

### Use Case B：已发布卡片 → 数据回填（可直接提交）

```bash
# 1. 查已发布卡片
curl -s "$API/api/boards/$BOARD/items?status=已发布" -H "Authorization: Bearer $TOKEN"

# 2. （协议外）访问每张卡 links[rel=publish].url，采集数据

# 3. 创建并提交变更集（metrics 与 status 同帧，避免指标 gate 清空）
#    operations: [{"op":"patch","item_id":"...","changes":{
#      "status":"已发布","propagation_4h":5000,"engagement_4h":860,
#      "comment":"2026-09-07 自动采集：阅读 5000 / 互动 860"}}]

# 4. 事后任何人可溯源
curl -s "$API/api/boards/$BOARD/audit?limit=50" -H "Authorization: Bearer $TOKEN"
```

**注意事项：**
- 指标字段必须与 `"status":"已发布"` 同帧提交，否则被 gate 清空。
- 按姓名指派负责人会**自动登记新成员**，拼写错误会污染成员目录；建议先 `GET /members` 解析再写 id。
- 所有写失败先看 `GET change-set` 状态再决定重试，不要盲重试 commit。
- 429 时按 `retry_after` 退避。

---

## 12. 开发计划

分层纪律：改动落在哪层跑哪层测试（core → `test:core`，server → `test:server`，web → `test:e2e`，任何改动 → `lint`）。

### Milestone 1 — core：变更集纯函数 + links 字段（约 1 周）

| 任务 | 说明 |
|---|---|
| `types/content.ts` | Item 增加 `links: Link[]`；新增 `ChangeSet / Operation / ChangeSetResult` 类型 |
| `lib/changeset-core.ts`（新） | `createChangeSet()` 预校验 + `applyChangeSet(board, ops)` 纯函数：按序应用 create/patch、服务端 id 分配、orders 联动、members/products 重算、指标 gate、2000 上限、重复 id 检查 |
| `patch-core.ts` | `links` 进 PATCH 白名单 |
| 测试 | `test:core` 新增用例：ops 顺序、client_ref 映射、gate 联动、超限拒绝、幂等同值 |

### Milestone 2 — server：change-sets 端点 + 审计扩列（约 1–2 周）

| 任务 | 说明 |
|---|---|
| 存储 | 新表 `change_sets`（含 status / base_version / operations JSON / expires_at / result / idempotency_key）；`audit_log` 扩列 actor / source / change_set_id / request_id |
| 端点 | `POST/GET change-sets`、`commit`、`cancel`；惰性过期判定 |
| commit 事务 | 按 §5.6 顺序实现；409 / rejected 语义；幂等键存取 |
| 既有端点 | PATCH 支持可选 `If-Match`；整板 PUT 支持 `If-Match`（无则兼容模式 + 警告日志）；change-sets 计入限速桶 |
| 测试 | `test:server` 扩充：状态机全转移、版本冲突、幂等重试、键复用 409、审计五字段、cancel、过期惰性标记。**补上此前缺失的限速 429 用例** |

### Milestone 3 — CLI：瘦客户端化第一步（约 3–5 天）

| 任务 | 说明 |
|---|---|
| `timeline-import --board <id> --api <url>` | 解析/校验照旧（core），输出从写 `board.json` 种子改为创建并（可选自动）提交 change-set；`--dry-run` 映射为只创建不 commit |
| 兼容 | 不带 `--board` 时维持现有种子文件行为不变 |

### Milestone 4 — web：同步层迁移（工作量最大，约 2–3 周）

| 任务 | 说明 |
|---|---|
| 写路径 | 编辑防抖输出从整板 PUT 改为 change-set（单卡编辑 → 单 patch op） |
| 409 UX | 轮询发现 version 前进且本地有 pending 写 → 自动基于新快照重建变更集重试；冲突无法自动解决时提示用户 |
| 过渡 | PUT 先带 `If-Match`；离线补推逻辑适配 |
| 测试 | `test:e2e` 全量回归 + 新增：双端并发 409、change-set 提交后他端可见、离线恢复 |

### Milestone 5 — 生态与收尾

- `examples/` 增加第三方 agent 参考脚本（Use Case A/B 的 curl/Node 示例）
- `docs/agent-api.md` 更新为本协议；`docs/change-matrix.md` 补 change-sets 行
- AGENTS.md 行数等文档偏差顺手修正

**建议排期**：M1 → M2 串行（契约先行），M3 与 M4 可并行，M5 收尾。总计约 5–7 周。
