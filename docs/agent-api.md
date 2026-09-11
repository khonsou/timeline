# Agent API 指南（拾光轴 · Timeline Board · v19 change-set 协议 + v2 字段/分组/关系）

> 面向第三方 agent 的看板读写协议：**变更集（Change Set）是唯一写入口径**——
> 提案（创建 pending）→ 人工 review（GET）→ 原子提交（commit）→ 逐字段审计溯源。
> 鉴权与人完全同一套：**看板 URL + 密码 → 换 12h token**，没有独立的 agent key 体系。
> v2 追加（语义详见第 6 / 7 节）：M1 卡片表现字段（`bg_color` / `dimmed`）、
> M2 统一分组模型（`groups[]` / `group_id` + 三个分组 op）、M3 卡片前后关系（`pre_ids` / `post_ids`）。
> 上手示例脚本见 [examples/agent-quickstart.mjs](../examples/agent-quickstart.mjs)（零依赖直跑）。

## 0. 运行时自发现（v19.1；v19.2 起 meta 追加 features）

实例级三件套，**免鉴权、无 404 板检查、不占 board 级 agent 配额**
（独立限速桶 `BOARD_DISCOVERY_RPM`，默认 30 次/IP/分钟，超限 `429 + retry_after`）：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/meta` | 实例自描述：`protocol_version` / `server_version` / `capabilities` / `features`（v19.2，见下）/ `limits`（反射运行配置）/ `enums`（type、status）/ `doc` |
| GET | `/api/agent-doc` | 本文档全文（`text/markdown`；启动时读盘缓存，运行期不重读）。读不到文档时降级为内置最小摘要并记 warn 日志，仍返回 200；路径可用 `BOARD_AGENT_DOC_PATH` 覆盖 |
| — | 响应头 `X-Protocol-Version` | **所有** `/api/` 响应（含 4xx/5xx）统一携带，值如 `19.2`；客户端可据此校验协议大版本 |

`GET /api/meta` 完整响应形态（v19.2）：

```json
{
  "protocol_version": "19.2",
  "server_version": "1.0.0",
  "capabilities": ["items.read", "items.patch", "change_sets", "audit.read"],
  "features": {
    "groups": true,
    "relations": true,
    "card_styling": true
  },
  "limits": {"agent_rpm": 120, "board_item_limit": 2000, "body_bytes": 8388608},
  "enums": {
    "type": ["图文", "视频", "音频", "直播", "数据"],
    "status": ["待执行", "待发布", "已发布"]
  },
  "doc": "/api/agent-doc"
}
```

- `capabilities` 是**端点级**能力（固定四项）；`features` 是**字段/op 级**的 v2 能力宣告：
  - `groups`：统一分组模型——`groups[]` / `group_id` 字段 + change-set 分组 op（第 4.2 / 6 节）
  - `relations`：卡片前后关系——`pre_ids` 唯一写入源 / `post_ids` 只读镜像（第 5 / 7 节）
  - `card_styling`：卡片表现——`bg_color` / `dimmed` 字段（第 5 节）
- `enums` 只列真正的枚举；`bg_color` 是自由 hex（`#rrggbb`，UI 的 8 预设色仅为写入快捷值），不在其列。

用途：**探测先行，不要硬编码**——agent 启动时先 `GET /api/meta` 探明能力与限额，
LLM agent 可再 `GET /api/agent-doc` 拉取与对面部署版本严格一致的协议全文。
接入侧完整纪律见 [agent-integration-guide.md](agent-integration-guide.md)。

## 1. 鉴权

```bash
# 密码换 token（有效期默认 12 小时，BOARD_TOKEN_HOURS 可调）
curl -X POST http://<host>:8787/api/boards/<board_id>/auth \
  -H 'content-type: application/json' \
  -d '{"password":"看板密码"}'
# → { "token": "...", "expires_at": "2026-09-07T12:00:00.000Z" }

# 之后所有请求带：
#   authorization: Bearer <token>
```

- token 缺失/过期/签名不符 → `401 { "error": "token 缺失或已过期" }`
- 密码连续 5 次错误锁 60 秒 → `429 { "error": "...", "retry_after": N }`
- 看板不存在 → `404 { "error": "看板不存在" }`
- 端点检查顺序：404 看板 → 401 token → 429 限速（未过鉴权不耗配额）

**actor / source 身份**：审计要求记录执行者，第一版规则是**客户端自报**——
创建 change-set 时带 `actor` / `source` 字段，服务端原样透传记录，不做真实性校验
（防君子不防小人）。未来如引入带身份的 agent token，端点形状不变。

## 2. 端点一览（11 个 board 级 + 2 个实例级）

> 实例级自发现端点 `GET /api/meta` / `GET /api/agent-doc`（免鉴权）见 §0，下表为 board 级端点。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/boards/:id/auth` | 密码换 token |
| GET | `/api/boards/:id/items?date=&product_id=&member=&status=&q=` | 卡片列表（过滤可叠加，按 `publish_at` 升序） |
| GET | `/api/boards/:id/items/:itemId` | 单张卡片（完整字段含 `comment`、`links`） |
| PATCH | `/api/boards/:id/items/:itemId` | 白名单字段补丁（可选 `If-Match`；逐字段审计） |
| POST | `/api/boards/:id/change-sets` | 创建变更集（提案 → pending） |
| GET | `/api/boards/:id/change-sets/:csid` | 查询变更集（review / 重试前状态检查；惰性过期判定） |
| POST | `/api/boards/:id/change-sets/:csid/commit` | 原子提交（支持 `Idempotency-Key`） |
| POST | `/api/boards/:id/change-sets/:csid/cancel` | 人工取消（pending → rejected） |
| GET | `/api/boards/:id/products` | 产品目录数组 |
| GET | `/api/boards/:id/members` | 成员目录数组 |
| GET | `/api/boards/:id/audit?limit=50` | 审计（倒序，`limit` ≤ 200） |

> Card 是业务概念，Item 是协议资源名。整板全量拉取仍可用既有
> `GET /api/boards/:id?version=N`（带 token；version 相同返回 `{changed:false}`，不计限速）。

## 3. 读卡片

```bash
# 全部卡片（按 publish_at 升序）
curl -H "authorization: Bearer $TOKEN" \
  'http://<host>:8787/api/boards/<board_id>/items'
# → { "items": [ { id, title, type, publish_at, roi, comment, product_id,
#                  status, content_owner_id, delivery_owner_id,
#                  propagation_4h, engagement_4h, links?,
#                  bg_color?, dimmed?, group_id?,      // v2-M1 / v2-M2，可缺省
#                  pre_ids?, post_ids? }, ... ] }      // v2-M3，可缺省（post_ids 为只读镜像）

# 过滤（均可选、可叠加、AND 语义）：
#   date=YYYY-MM-DD   按日列（publish_at 日期前缀匹配）
#   product_id=P-1000 按归属产品（精确匹配）
#   member=苏晴        按负责人（姓名或成员 id 均可；命中内容/投放任一；未知姓名 → 空数组）
#   status=已发布      按状态（待执行 / 待发布 / 已发布）
#   q=关键词           标题或备注包含（大小写不敏感）
curl -H "authorization: Bearer $TOKEN" \
  'http://<host>:8787/api/boards/<board_id>/items?date=2026-09-04&status=待发布&q=日报'

# 单张卡片
curl -H "authorization: Bearer $TOKEN" \
  'http://<host>:8787/api/boards/<board_id>/items/ag-c04'
# 不存在 → 404 { "error": "卡片不存在" }
```

## 4. Change Set（变更集）

变更集是**批量原子写**的唯一入口：一组 operations 要么全部生效，要么看板零变化。

### 4.1 资源形状与状态机

```jsonc
{
  "change_set_id": "cs-3f9a…",          // 服务端分配（cs- + 16 位 hex）
  "board_id": "…",
  "status": "pending",
  "base_version": 42,                    // 创建时的看板 version；真正的并发检查在 commit
  "operations": [ /* 见 4.2 */ ],
  "source": { "type": "agent", "external_run_id": "run-20260907-001" },  // 自报，可空
  "actor":  { "type": "agent", "id": "agent-content-01" },               // 自报，可空
  "created_at": "…",
  "expires_at": "…",                     // 创建时写入，默认 24 小时（BOARD_CS_TTL_HOURS）
  "result": null                         // committed → {version, items}；rejected → {errors}
}
```

状态机（**终态不可逆**）：

```text
pending
  ├── commit 成功        → committed
  ├── base_version 过期  → conflicted（commit 时 version 不符）
  ├── core 校验失败      → rejected（commit 时全量校验不过 / 人工 cancel）
  └── 到期未提交         → expired
```

- **过期是惰性标记**：服务端没有后台 worker，在 GET / commit / cancel 时判定并落库；
  过期后不得提交（commit → `409`，`status: "expired"`）。
- 终态记录保留 30 天；审计记录长期保留。

### 4.2 Operations（卡片 op：create / patch；v2-M2 追加分组 op：group_create / group_patch / group_delete）

| op | 形状 | 语义 |
|---|---|---|
| `create` | `{ "op":"create", "client_ref":"row-1", "item": {…} }` | **卡片 id 由服务端分配**（客户端不可指定，传 id → 400）；`client_ref` 是客户端追踪柄，提交结果里回映射 `client_ref → id`；同一日期多张新卡按 operations 顺序追加到当日列尾，已有卡片顺序不变 |
| `patch` | `{ "op":"patch", "item_id":"ag-c04", "changes": {…} }` | 与单卡 PATCH 同一套白名单与校验规则（见第 5 节）；`publish_at` 跨日 → 目标日列尾，同日 → 顺序不变 |
| `group_create`（v2-M2） | `{ "op":"group_create", "client_ref":"g-1", "group": {"name":"Sprint 5"} }` | 新建分组；**分组 id 由服务端分配**（`grp-` 前缀内容哈希，同一 change-set 重试 id 不变）；`client_ref` 可被同 set 后续 op 的 `group_id` / `move_to` / `before_group_id` 直接引用（set 内先建后引用）；提交结果回映射 `groups: [{client_ref, id}]`；分组总数上限 **61**（虚拟「未分组」列不占名额），超限全批拒绝 |
| `group_patch`（v2-M2） | `{ "op":"group_patch", "group_id":"grp-…", "changes": {"name": "…", "before_group_id": "grp-…" \| null} }` | 重命名 / 调列序（`before_group_id` = 移到该分组之前；`null` = 移到末尾；不可指向自身）；组改名**不影响卡片**（卡片落盘恒为 group_id 引用，不跟随改名） |
| `group_delete`（v2-M2） | `{ "op":"group_delete", "group_id":"grp-…", "move_to": "grp-…"（可缺省） }` | 删组；`move_to` 缺省 = 组内卡片归「未分组」（移除 `group_id` 字段）；显式给出时须指向已存在分组（不能是被删分组自身；同 set 新建分组的 client_ref 可引用） |

- 卡片 `item` / `changes` 的可用字段 = PATCH 白名单 16 字段（第 5 节）；create 时
  `title` / `publish_at` 必填，其余缺省按新建卡片默认（type=图文、status=待执行、
  指标 null、负责人未分配、product 未归属、未分组）。
- **不支持卡片 `delete`**（破坏审计链、误删代价高；v2-M3 起 agent 删卡走整板 PUT，
  服务端规范化会自动级联剔除关系引用，见第 7 节）；
  **不支持 `reorder`**（不允许直接写 order）。
- 负责人字段传**姓名或成员 id**：未知姓名自动登记新成员（`M-<序号>`），
  整个 change-set 内同名去重后一次性并入成员目录。
- **写入时归属解析**（v2-M2，一次性）：create / patch 未显式给 `group_id` 但带
  `publish_at`，且存在同名日期组（组名 = `YYYY-MM-DD`）→ 挂入该组；无同名组 →
  归未分组，**绝不自动建组**。patch 仅当日期部分实际变化时触发；显式传 `group_id`
  （含 `null`）时以显式值为准。
- **2000 张硬上限**：commit 时校验，超限**全批拒绝**（看板零变化）。

### 4.3 创建（提案）

```bash
curl -X POST http://<host>:8787/api/boards/<board_id>/change-sets \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{
    "base_version": 42,
    "source": {"type":"agent","external_run_id":"run-001"},
    "actor":  {"type":"agent","id":"my-agent"},
    "operations": [
      {"op":"create","client_ref":"row-1",
       "item":{"title":"发布会切片","type":"视频","publish_at":"2026-09-10T10:00","status":"待执行"}},
      {"op":"patch","item_id":"ag-c04",
       "changes":{"comment":"Agent 已完成数据回填"}}
    ]}'
# → 201 { change_set_id, status:"pending", expires_at, … }（完整 change-set）
```

创建时服务端做**预校验**（格式类错误尽早暴露：operations 非空数组、op 仅
create / patch / group_create / group_patch / group_delete、白名单、逐字段格式），失败 →
`400 { "error": "…；…", "errors": [...] }`（中文文案，多错误 `；` 拼接）。注意：
patch 的 `item_id` 存在性、`group_id` / `pre_ids` 的引用存在性、2000 上限、分组 61 上限、
版本并发**不在预校验阶段**，都在 commit。

### 4.4 提交（原子确认）

```bash
curl -X POST http://<host>:8787/api/boards/<board_id>/change-sets/cs-3f9a…/commit \
  -H "authorization: Bearer $TOKEN" \
  -H "Idempotency-Key: commit-run-001"
```

事务内顺序：读板 → 状态非 pending 拒绝 → 过期检查 → `version == base_version` 检查 →
快照上按序应用 operations → core 全量校验 → 整体写入（version+1）→ 逐字段写审计
（actor / source 从 change-set 逐条复制，change_set_id 必填，request_id 每次提交生成，
同一次提交共用同一 ts）。

结果：

```text
全部通过   → 200 { "status":"committed", "version":43, "items":[{"client_ref":"row-1","id":"auto-…"}…] }
             （v2-M2 起含 group_create 时追加 "groups":[{"client_ref":"g-1","id":"grp-…"}…]）
校验失败   → 400 { "error":"…", "errors":[…] }，change-set → rejected，看板零变化，不允许部分提交
版本不一致 → 409 { "error":"VERSION_CONFLICT", "current_version":43 }，change-set → conflicted，看板零变化
```

**幂等规则**：

```text
同 change_set_id + 同 Idempotency-Key 重试 → 200 返回首次提交结果，不重复写入，不 409
同 Idempotency-Key + 不同请求内容          → 409 IDEMPOTENCY_KEY_REUSE
无幂等键：先 GET 状态再决定——committed 用旧结果；conflicted / expired / rejected 须新建 change-set
```

### 4.5 取消

```bash
curl -X POST http://<host>:8787/api/boards/<board_id>/change-sets/cs-3f9a…/cancel \
  -H "authorization: Bearer $TOKEN"
# pending → 200（rejected）；已终态 → 409
```

## 5. 改卡片（单卡 PATCH）

body 为字段补丁对象，只允许以下白名单字段（**16 个**），其余键一律
`400 { "error": "不支持修改的字段: xxx" }`（v2-M3 起含 `post_ids`——它是只读镜像，见第 7 节）：

| 字段 | 规则 |
|---|---|
| `title` | 非空字符串 |
| `type` | 枚举：`图文 / 视频 / 音频 / 直播 / 数据` |
| `status` | 枚举：`待执行 / 待发布 / 已发布` |
| `publish_at` | `YYYY-MM-DDTHH:mm` / `YYYY-MM-DD HH:mm` / `YYYY/M/D H:mm`，归一化为 `YYYY-MM-DDTHH:mm` |
| `product_id` | 空 = 未归属；**未知 id 保留原样写入、不动产品目录** |
| `content_owner_id` / `delivery_owner_id` | 传**成员 id 或姓名**：命中 → 复用；未知姓名 → **自动登记进成员目录**（`M-<序号>`）；空 = 未分配 |
| `roi` / `propagation_4h` / `engagement_4h` | 空/null → null；须为非负数字 |
| `comment` | 字符串；**人工备注，不是机器协议**——结构化数据一律走 `links` 等结构化字段 |
| `links` | **结构化链接数组**（v19 新增），见第 8 节 |
| `bg_color`（v2-M1） | 卡片背景色 hex `#rrggbb`（`#rgb` 与大写输入归一化为小写 `#rrggbb`；UI 色板的 8 预设色只是写入快捷值，落盘恒为 hex；旧色板 token 如 `amber` 写入时收敛为对应 hex）。`null` / 空串 = 恢复默认（移除字段） |
| `dimmed`（v2-M1） | 严格 boolean：`true` = 置灰（卡片半透明退到背景），`false` = 点亮（移除字段）。**系统不做任何自动置灰/解除，完全由用户/agent 控制** |
| `group_id`（v2-M2） | 分组 id（指向 `groups[]` 已有分组）；非法引用 → `400`；`null` / 空串 = 归「未分组」（移除字段）。未显式给但改了 `publish_at` → 写入时归属解析（见 4.2） |
| `pre_ids`（v2-M3） | 前序卡片 id 数组（**关系唯一写入源**）：元素须为板内已存在卡片 id（悬空 → `400`；自环 → `400`；重复自动去重）；`[]` = 清空全部前序（移除字段）。规则与镜像语义见第 7 节 |

**可选 `If-Match` 头**（值为看板 version 数字）：携带且与当前 version 不符 →
`409 { "error":"VERSION_CONFLICT", "current_version": N }`；不携带维持最后一次写胜
（兼容模式，迁移完成后将转为强制）。整板 `PUT /api/boards/:id` 同样支持可选
`If-Match`；不携带时兼容放行但响应头带 `Deprecation: true`（该写路径将废弃，
新写入请走 change-sets）。v2-M3 起整板 PUT 与 POST 建板在存储前会做**关系规范化**
（幂等，见第 7 节）。

三条与 UI 完全一致的内建联动：

1. **指标 gate**：PATCH 后的最终状态非「已发布」→ 三指标强制为 `null`——
   发布填指标请**同帧**带上 `status: "已发布"`；
2. **orders 联动**：`publish_at` 跨日变更 → 卡片排到目标列末尾；同日时分变更不影响列内顺序；
3. **关系镜像联动**（v2-M3）：`pre_ids` 实际变化时，被增删引用卡片的 `post_ids`
   在同一事务内自动差分维护（镜像卡的变化同样逐条写审计，field 为 `post_ids`）。

响应：

```jsonc
// 有实际变化：doc.version+1，逐字段写审计
{ "changed": true,  "version": 7, "item": { /* 修改后的完整卡片 */ } }
// 值全相同：不写审计、version 不增（幂等）
{ "changed": false, "version": 7, "item": { /* 原样卡片 */ } }
```

示例：

```bash
# 发布并填指标（同帧带 status，避免被 gate 清空）
curl -X PATCH -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"status":"已发布","propagation_4h":5000,"engagement_4h":860}' \
  http://<host>:8787/api/boards/<board_id>/items/ag-c04

# 带版本保护写入
curl -X PATCH ... -H 'If-Match: 42' -d '{"comment":"agent 写入"}' ...

# 写入结构化链接（整组替换；null / 空串 = 清空）
curl -X PATCH ... -d '{"links":[{"id":"l1","rel":"publish","url":"https://example.com/p/1","platform":"xiaohongshu"}]}' ...
```

校验失败为 `400`，文案与 CLI / UI 导入同一套中文规则，例如：
`status 非法: "进行中"，合法值: 待执行 / 待发布 / 已发布`、`links[0].url 必填且非空`、
`pre_ids 指向不存在的卡片: ghost`、`pre_ids 不允许自环（卡片不能是自己的前序）`。

## 6. 分组与列归属（v2-M2 统一分组模型）

看板 doc 追加 `groups[]`（可缺省），卡片追加 `group_id`（可缺省）：

```jsonc
{
  "groups": [ { "id": "grp-…", "name": "Sprint 5" }, ... ],  // 数组序 = 列顺序，≤ 61
  "items": [ { "id": "…", "group_id": "grp-…", ... }, ... ]
}
```

- **不分模式**：日期只不过是组名恰巧是 `YYYY-MM-DD` 的组；`publish_at` 与分组彻底脱钩，
  是纯信息字段（不再决定列归属）。
- **「未分组」是虚拟系统列**：不占 `groups[]` 数据、不可删/改名/排序，恒为第一列；
  卡片 `group_id` 缺省 / 悬空（加载兜底重置）/ 写 `null` = 未分组。
- **上限 61**：`group_create` 超限 → commit `400` 全批拒绝。
- **写入严格**：卡片 `group_id` 指向不存在的分组 → `400`（change-set 预校验只查格式，
  存在性在 commit；同 set 可先 `group_create` 再用其 `client_ref` 引用）。
- **存量迁移在客户端加载时自动发生**（一次性、确定性幂等）：无 `groups` 字段的老板 →
  派生「今天 ±30 天」共 61 个同名日期组并回填窗口内卡片 `group_id`；窗口外离群卡归未分组。
  服务端只是 LWW 存储——agent 读到的 `groups[]` 即迁移结果（页面打开过即已落盘）。
- 分组管理只走 change-set 的三个 doc 级 op（见 4.2）；**没有分组专用的 REST 端点**。

## 7. 卡片前后关系（v2-M3）

多对多有向依赖「前序 → 后续」：卡片追加 `pre_ids` / `post_ids`（均可缺省）。

- **`pre_ids` 是唯一写入源**（前序卡片 id 数组）；**`post_ids` 是 core 维护的镜像，外部只读**——
  不变量 `A.post_ids ∋ B ⇔ B.pre_ids ∋ A`，写 `pre_ids` 时同事务自动差分维护；
  **直接 PATCH / change-set 写 `post_ids` 一律 `400`**（白名单外字段）。
- **「给 A 加后续 B」= patch `B.pre_ids += A`**（把 A 写进 B 的前序），不要反过来找
  「写 A 的 post_ids」的入口——不存在，防误用。
- 规则：元素须为板内已存在卡片 id；自环 `400`；重复自动去重；`pre_ids: []` = 清空
  （移除字段，镜像同步回收）；删卡级联剔除所有引用。
- **成环数据层允许**（不写 400），环由关系视图层降级处理（断边标黄提示）——
  agent 建环不会被拒，但请自行避免。
- 两条写路径严格度分层：
  - **PATCH / change-set（严格）**：`pre_ids` 悬空 id / 自环 → `400` 拒绝；
  - **整板 PUT / POST 带 doc 建板（LWW 覆盖语义）**：服务端**规范化而非拒绝**——
    `pre_ids` 去重、剔悬空 id、剔自环，并按 `pre_ids` 全量重建 `post_ids` 镜像；
    确定性、幂等，对合法 doc 是 no-op。**agent 删卡走整板 PUT**（change-set 无卡片
    delete op），规范化同时覆盖删卡级联：被删卡 id 从所有 `pre_ids` / `post_ids` 剔除。
- change-set `create` 的 `item` 可携带 `pre_ids`；同 set 内前序新建的卡片可被引用——
  卡片 id 是确定性内容哈希，客户端可按同一算法（`newChangeSetItemId`）复算得到
  （注意：卡片引用**没有** client_ref 别名解析，`group_id` / `move_to` / `before_group_id`
  这些分组引用才支持 client_ref）。

## 8. links 字段与 Schema 演进规则

```jsonc
"links": [
  { "id": "link-001", "rel": "publish",
    "url": "https://example.com/post/123", "platform": "xiaohongshu" }
]
```

- `links` 是数组（不设计单一 `publish_url`）；`rel` 表示用途（publish / draft / material …）；
  `platform` 为可扩展字符串，可缺省；`id` / `rel` / `url` 必填非空。
- PATCH / change-set 中的 `links` 是**整组替换**语义；`null` / 空串 = 清空。
- **演进铁律：未来字段只能追加，不得改变已有字段语义。** `links` 是首例。
- 迁移：旧 `comment` 中的 URL 可一次性转换到 `links`，原 `comment` 保留不变。

## 9. 审计

每次有实际变化的写入，按**实际变化的字段**逐字段写一条审计（无变化不写、version 不增）：

```bash
curl -H "authorization: Bearer $TOKEN" \
  'http://<host>:8787/api/boards/<board_id>/audit?limit=50'
# → { "entries": [ { "id", "ts", "board_id", "item_id", "field", "old_value", "new_value",
#                    "actor", "source", "change_set_id", "request_id" }, ... ] }   # id 倒序
```

- `old_value` / `new_value`：字符串原样，非字符串值（null / number / 数组）JSON 序列化。
- v19 起新增四列：`actor` / `source`（JSON 文本，change-set 提交时从 change-set 逐条复制）、
  `change_set_id`、`request_id`（每次写请求生成，同一次提交共用同一 ts 与 request_id）。
- **直接 PATCH → `change_set_id` / `actor` / `source` 为 `null`**（自报身份只走 change-set 创建入参）；
  历史条目（v19 之前）这四列同样为 `null`——消费方必须容忍 null。
- v2 起 `field` 新增取值：`bg_color` / `dimmed` / `group_id` / `pre_ids`（M1–M3 卡片字段）；
  关系镜像联动会在被引用卡片上写 `field: "post_ids"` 条目（item_id = 被改镜像的卡片）；
  分组 op（M2）写：`group`（`item_id` = 分组 id；create 时 old=null / delete 时 new=null）、
  `group.name`、`group.order`（old/new 为列序下标）、`group_id`（删组迁移逐卡一条）。
- 审计只覆盖协议写路径；页面人工编辑的整板 PUT 无逐字段审计。

## 10. 错误码总表

| 码 | 场景 |
|---|---|
| `400` | 白名单外字段（含直接写 `post_ids`） / 校验失败（中文明细） / 请求体非法 JSON / change-set 超 2000 张上限 / 分组超 61 上限 / `group_id` / `pre_ids` 非法引用或自环 / commit 全量校验不过（change-set → rejected） |
| `401` | token 缺失 / 过期 / 签名不符 |
| `403` | 密码错误 |
| `404` | 看板 / 卡片 / 变更集不存在 |
| `409 VERSION_CONFLICT` | commit 或 `If-Match` 版本不符（带 `current_version`）；change-set → conflicted |
| `409 IDEMPOTENCY_KEY_REUSE` | 同幂等键不同请求内容 |
| `409` | 变更集已终态（重复 commit / cancel） / 已过期（`status: "expired"`） |
| `413` | 请求体超 8MB |
| `429` | 限速 / 密码锁定，带 `retry_after` |

## 11. 限速与容量

- item 级与 change-set 端点（同一个限速桶）：**每 board 每 IP 120 次/分钟**（内存滑动窗口，
  `BOARD_AGENT_RPM` 可调；重启清零），超限 → `429 { "error": "…", "retry_after": N }`。
  整板 GET/PUT 与 auth 不计入。
- **反代部署必须配置真实客户端 IP 传递**（`X-Forwarded-For`），否则限速退化为每板全局。
- 单板 **2000 张**硬上限：change-set commit 时校验，超限全批拒绝（400）。

## 12. 上手示例（两个典型 Use Case）

完整可运行脚本：[examples/agent-quickstart.mjs](../examples/agent-quickstart.mjs)。

### Use Case A：策划方案 → 生成卡片（人工确认后写入）

```bash
TOKEN=$(curl -sX POST $API/api/boards/$BOARD/auth -d '{"password":"..."}' | jq -r .token)
VER=$(curl -s $API/api/boards/$BOARD -H "authorization: Bearer $TOKEN" | jq .version)

# 1. 创建变更集（提案）
curl -X POST $API/api/boards/$BOARD/change-sets \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d "{
    \"base_version\": $VER,
    \"source\": {\"type\":\"agent\",\"external_run_id\":\"run-001\"},
    \"actor\":  {\"type\":\"agent\",\"id\":\"my-agent\"},
    \"operations\": [
      {\"op\":\"create\",\"client_ref\":\"row-1\",
       \"item\":{\"title\":\"发布会切片\",\"type\":\"视频\",
                \"publish_at\":\"2026-09-10T10:00\",\"status\":\"待执行\"}}
    ]}"
# → 团队 GET change-set review，确认后：

# 2. 提交（带幂等键）
curl -X POST $API/api/boards/$BOARD/change-sets/$CS/commit \
  -H "authorization: Bearer $TOKEN" -H "Idempotency-Key: commit-run-001"
# → { "status":"committed", "version":43, "items":[{"client_ref":"row-1","id":"auto-…"}] }
```

### Use Case B：已发布卡片 → 数据回填（可直接提交）

```bash
# 1. 查已发布卡片
curl -s "$API/api/boards/$BOARD/items?status=已发布" -H "authorization: Bearer $TOKEN"

# 2. （协议外）访问每张卡 links[rel=publish].url，采集数据

# 3. change-set 回填：指标与 status 同帧（避免 gate 清空），comment 记录采集时间
#    operations: [{"op":"patch","item_id":"…","changes":{
#      "status":"已发布","propagation_4h":5000,"engagement_4h":860,
#      "comment":"2026-09-07 自动采集：阅读 5000 / 互动 860"}}]

# 4. 事后任何人可溯源
curl -s "$API/api/boards/$BOARD/audit?limit=50" -H "authorization: Bearer $TOKEN"
```

## 13. 注意事项

- **指标字段必须与 `"status":"已发布"` 同帧提交**，否则被 gate 清空。
- 按姓名指派负责人会**自动登记新成员**（拼写错误会污染成员目录；只增不删，
  删成员走页面「成员管理」）——建议先 `GET /members` 解析再写 id。
- 所有写失败先看 `GET change-set` 状态再决定重试，**不要盲重试 commit**；
  `conflicted` 时重新 GET 看板取最新 version，重建 change-set 再提交。
- 429 时按 `retry_after` 退避；反代部署确认真实客户端 IP 传递，否则限速退化为每板全局。
- **卡片 id 一律服务端分配**（CLI 兼容导入层除外，不进入协议语义）；create 结果用
  `client_ref` 追踪，同一 change-set 内容重试 id 不变（确定性内容哈希）。
- **「给 A 加后续 B」= patch `B.pre_ids += A`**（v2-M3）；`post_ids` 是只读镜像，
  直接写一律 400——不要找「写后续」的入口。
- `dimmed` 完全由用户/agent 控制（v2-M1）：**系统不做任何自动置灰/解除**，
  agent 读到 `dimmed: true` 不代表卡片失效，只是视觉退到背景。
- 删卡走整板 PUT（change-set 无卡片 delete op）；v2-M3 起 PUT / POST 建板在存储前做
  关系规范化（剔悬空/自环/重复 + 重建 `post_ids` 镜像），删卡级联由其覆盖。
- 老板（无 `groups` 字段）的日期分组是**客户端加载时迁移**出来的（v2-M2）：
  agent 读到的 `groups[]` / `group_id` 以页面打开后落盘的迁移结果为准。
- 生产部署 server 必须设固定 `BOARD_SECRET`（缺省随机 → 重启后全部 token 失效）。
- 看板页面写路径（M4 起）带 `If-Match` 版本保护整板 PUT；双端并发时 agent 的
  change-set 可能因 version 前进被拒（conflicted）——这是协议的并发控制，按上文重建即可。
