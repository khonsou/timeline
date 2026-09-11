# Timeline Agent 接入指南（调用侧）

> 读者：开发第三方 Timeline Agent 的团队 / 让 LLM agent 操作看板的人
> 配套版本：protocol ≥ 19.1（自发现三件套）；v19 可跳过 §2 探测步骤
> 与 `agent-api.md` 的分工：本文讲**怎么接入**，agent-api.md 是**端点参考手册**

---

## 0. 30 秒版

```text
GET  /api/meta            → 知道对面支持什么、限额多少、协议版本几
（可选）GET /api/agent-doc → 把最新协议全文喂给你的模型
POST /api/boards/:id/auth → 密码换 token
正常调用                  → 写操作一律走 change-set，带 base_version + 幂等键
每次响应看一眼 X-Protocol-Version
```

## 1. 核心原则：探测先行，不要硬编码

你的 agent 面对的 Timeline 实例版本未知、配置未知。**启动时探测一次，按探测结果决定行为**，这是本指南的全部要点。反面教材：把端点清单、限额、字段枚举硬编码进代码——协议演进后你的 agent 会莫名 400/404。

## 2. 第一步：能力探测

```http
GET {API}/api/meta        # 免鉴权
```

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

- `capabilities` 是端点级能力；`features`（v19.2 起）是字段/op 级的 v2 能力宣告——
  `groups`（分组 op + `group_id`）、`relations`（`pre_ids` / `post_ids`）、`card_styling`（`bg_color` / `dimmed`）。
  老实例可能不带 `features` 块：缺省按 false 处理，别假设存在。

按结果分支你的写路径：

```js
const meta = await fetch(`${API}/api/meta`).then(r => r.json())

if (meta.capabilities.includes('change_sets')) {
  // 现代路径：提案 → review → commit（推荐）
} else {
  // 降级路径：v18 实例，只有单卡 PATCH，无批量、无乐观锁
  // 注意降级意味着：无 create 能力、无原子性、无并发保护
}
```

**每次响应还带 `X-Protocol-Version` 头**——建议在你的 HTTP 封装里顺手校验：版本低于你开发时的预期就记一条警告日志，版本高于预期则忽略（协议只追加不破坏，向高兼容）。

## 3. 第二步：给模型喂最新文档（LLM agent 适用）

如果你的 agent 是 LLM 驱动的，不要把协议文档静态打包进 prompt——运行时拉：

```http
GET {API}/api/agent-doc   # 免鉴权，text/markdown
```

这份文档**与对面 server 的部署版本严格一致**（随代码包发布）。建议策略：会话开始时拉一次进上下文；长会话中检测到 `X-Protocol-Version` 变化时重新拉。

## 4. 第三步：鉴权

```http
POST {API}/api/boards/{board_id}/auth
{"password": "看板访问密码"}
→ {"token": "...", "expires_at": "..."}
```

- 之后所有请求：`Authorization: Bearer <token>`
- token 默认 12 小时。**必须实现 401 重认证**：收到 401 → 重新走 auth → 重试原请求一次。不要假设 token 缓存永远有效（server 重启、密钥轮换都会让它失效）
- 403 = 密码错误；同板连错 5 次锁 60 秒（429 + `retry_after`）——把密码当配置管理，写错密码的重试循环会触发锁定

## 5. 写操作纪律（重要）

**所有写都走 change-set**，除非你明确在跟 v18 老实例对话：

```text
1. GET /api/boards/:id          → 拿当前 version 作 base_version
2. POST /api/boards/:id/change-sets → {base_version, source, actor, operations}
3. （需要人工确认的场景）到此停下，把 change_set_id 交给团队 review
4. POST .../commit，带头 Idempotency-Key: <你这次任务的唯一标识>
```

四条铁律：

1. **`source` 和 `actor` 永远填**——它们会逐条复制进审计，是团队排查「这改动是谁干的」的唯一线索
2. **commit 必须带幂等键**——网络重试不会重复建卡；重试前先 `GET change-set` 看状态，`committed` 就直接用旧结果
3. **指标与状态同帧**——`status: 已发布` 和 `propagation_4h` 等必须出现在同一个 patch 里，否则指标被 gate 清空
4. **负责人传 id 不传姓名**——先 `GET /members` 解析；直接传未知姓名会**自动登记新成员**，拼写错误会污染成员目录

## 6. 限额与自我节流

- 用 `/api/meta` 返回的 `limits.agent_rpm` 作为你的节流参数，不要用文档里的默认值
- 收到 429 → 读 `retry_after`，**等够秒数再试**；不要立即重试（会延长惩罚窗口）
- 批量场景：100 张卡 = 1 个 change-set = 2 次请求（创建 + commit），不要循环单卡 PATCH

## 7. 错误码速查

| 码 | 含义 | 你的动作 |
|---|---|---|
| 400 | 校验失败（响应里有逐字段中文原因） | 读 `errors` 字段修数据；change-set 已进 `rejected`，修正后**新建** change-set |
| 401 | token 失效 | 重新 auth，重试一次 |
| 404 | 板/卡/变更集不存在 | 检查 id；板可能被删了，通知人 |
| 409 VERSION_CONFLICT | base_version 过期 | 重新 GET 拿新 version，重建 change-set，重试 |
| 409 IDEMPOTENCY_KEY_REUSE | 同键不同内容 | 你的重试逻辑有 bug——同一次任务必须用同一个请求体 |
| 429 | 限速/密码锁 | 等 `retry_after` 秒 |

## 8. 两个标准 Use Case

### A. 策划方案生成卡片（人工确认后写入）

```text
meta 探测 → auth → GET version
→ 创建 change-set（N 个 create op，client_ref 对应你的方案行号）
→ 把 change_set_id + GET 链接交给团队 review
→ （人确认后）commit，带幂等键
→ 从 result.items 读 client_ref → 正式卡片 id 的映射，回写你的任务系统
```

### B. 已发布卡片数据回填（自动）

```text
meta 探测 → auth
→ GET /items?status=已发布 → 逐卡读 links[rel=publish].url
→ （协议外）访问发布页采集数据
→ 一个 change-set 装所有 patch op（status+指标+comment 同帧）
→ commit 带幂等键
→ GET /audit 抽查溯源记录是否符合预期
```

## 9. 反模式清单（都会被坑过，别踩）

- ❌ 把限额/枚举/端点清单硬编码 → 协议演进后莫名报错
- ❌ 缓存 token 且不处理 401 → server 重启后你的定时任务静默死亡
- ❌ 批量场景循环单卡 PATCH → 撞限速、无原子性、审计爆炸
- ❌ commit 失败立即无脑重试 → 可能其实成功了（先看 GET 状态）
- ❌ 从 comment 里解析 URL/结构化数据 → comment 是人工备注，结构化数据走 `links` 等正式字段
- ❌ 直接传负责人姓名 → 自动登记副作用，先解析成 id

## 10. 参考实现

`examples/agent-quickstart.mjs`（仓库内）演示了本指南全部纪律的完整实现，零依赖 Node ≥22 直跑，可以直接抄它的 HTTP 封装和重试逻辑。
