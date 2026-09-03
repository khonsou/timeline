# Agent API 指南（拾光轴 · Timeline Board · v18）

> 面向第三方 agent 的 item 级读写接口：不用模拟人的「整板拉取 → 改 → 整板覆盖」，
> 直接按卡片读写，逐字段审计，带防滥用限速。
> 鉴权与人完全同一套：**看板 URL + 密码 → 换 12h token**，没有独立的 agent key 体系。

## 1. 鉴权

```bash
# 密码换 token（有效期默认 12 小时，BOARD_TOKEN_HOURS 可调）
curl -X POST http://<host>:8787/api/boards/<board_id>/auth \
  -H 'content-type: application/json' \
  -d '{"password":"看板密码"}'
# → { "token": "...", "expires_at": "2026-09-04T12:00:00.000Z" }

# 之后所有请求带：
#   authorization: Bearer <token>
```

- token 缺失/过期/签名不符 → `401 { "error": "token 缺失或已过期" }`
- 密码连续 5 次错误锁 60 秒 → `429 { "error": "...", "retry_after": N }`
- 看板不存在 → `404 { "error": "看板不存在" }`

## 2. 端点一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/boards/:id/items?date=&product_id=&member=&status=&q=` | 卡片列表（过滤可叠加，按 `publish_at` 升序） |
| GET | `/api/boards/:id/items/:itemId` | 单张卡片（完整字段含 `comment`） |
| PATCH | `/api/boards/:id/items/:itemId` | 白名单字段补丁（逐字段审计） |
| GET | `/api/boards/:id/products` | 产品目录数组 |
| GET | `/api/boards/:id/members` | 成员目录数组 |
| GET | `/api/boards/:id/audit?limit=50` | PATCH 审计（倒序，`limit` ≤ 200） |

## 3. 读卡片

```bash
# 全部卡片（按 publish_at 升序）
curl -H "authorization: Bearer $TOKEN" \
  'http://<host>:8787/api/boards/<board_id>/items'
# → { "items": [ { id, title, type, publish_at, roi, comment, product_id,
#                  status, content_owner_id, delivery_owner_id,
#                  propagation_4h, engagement_4h }, ... ] }

# 过滤（均可选、可叠加）：
#   date=YYYY-MM-DD   按日列
#   product_id=P-1000 按归属产品
#   member=苏晴        按负责人（姓名或成员 id 均可；命中内容/投放任一）
#   status=已发布      按状态（待执行 / 待发布 / 已发布）
#   q=关键词           标题或备注包含（大小写不敏感）
curl -H "authorization: Bearer $TOKEN" \
  'http://<host>:8787/api/boards/<board_id>/items?date=2026-09-04&status=待发布&q=日报'

# 单张卡片
curl -H "authorization: Bearer $TOKEN" \
  'http://<host>:8787/api/boards/<board_id>/items/ag-c04'
# 不存在 → 404 { "error": "卡片不存在" }
```

## 4. 改卡片（PATCH）

body 为字段补丁对象，只允许以下白名单字段，其余键一律
`400 { "error": "不支持修改的字段: xxx" }`：

| 字段 | 规则 |
|---|---|
| `title` | 非空字符串 |
| `type` | 枚举：`图文 / 视频 / 音频 / 直播 / 数据` |
| `status` | 枚举：`待执行 / 待发布 / 已发布` |
| `publish_at` | `YYYY-MM-DDTHH:mm` / `YYYY-MM-DD HH:mm` / `YYYY/M/D H:mm`，归一化为 `YYYY-MM-DDTHH:mm` |
| `product_id` | 空 = 未归属；**未知 id 保留原样写入、不动产品目录** |
| `content_owner_id` / `delivery_owner_id` | 传**成员 id 或姓名**：命中 id/姓名 → 复用；未知姓名 → **自动登记进成员目录**（新 id 按 `M-<序号>` 生成）；空 = 未分配 |
| `roi` / `propagation_4h` / `engagement_4h` | 空/null → null；须为非负数字 |
| `comment` | 字符串 |

两条与 UI 完全一致的内建规则：

1. **指标联动**：PATCH 后的最终状态非「已发布」→ 三指标强制为 `null`（待发布卡写 `roi` 会被置 null）；
2. **orders 联动**：`publish_at` 跨日变更 → 卡片排到目标日列末尾；同日时分变更不影响列内顺序。

响应：

```jsonc
// 有实际变化：doc.version+1、updated_at 刷新，逐字段写审计
{ "changed": true,  "version": 7, "item": { /* 修改后的完整卡片 */ } }
// 值全相同：不写审计、version 不增
{ "changed": false, "version": 7, "item": { /* 原样卡片 */ } }
```

示例：

```bash
# 改标题 + 备注
curl -X PATCH -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"title":"新标题","comment":"agent 写入"}' \
  http://<host>:8787/api/boards/<board_id>/items/ag-c04

# 发布并填指标（顺序：先置已发布，再写指标；或同帧带上 status）
curl -X PATCH ... -d '{"status":"已发布","roi":3.3,"propagation_4h":5000}' ...

# 改期（跨日 → 自动排到目标日列末尾）
curl -X PATCH ... -d '{"publish_at":"2026-09-10 12:30"}' ...

# 指派负责人（姓名即可，未知姓名自动登记进成员目录）
curl -X PATCH ... -d '{"content_owner_id":"赵六"}' ...
```

校验失败为 `400`，文案与 CLI/UI 导入同一套中文规则，例如：
`status 非法: "进行中"，合法值: 待执行 / 待发布 / 已发布`、`roi 须为空或非负数字，得到 "-2"`。

## 5. 审计

每次有实际变化的 PATCH，按**实际变化的字段**逐字段写一条审计
（无变化的 PATCH 不写审计、version 不增）：

```bash
curl -H "authorization: Bearer $TOKEN" \
  'http://<host>:8787/api/boards/<board_id>/audit?limit=50'
# → { "entries": [ { "id", "ts", "board_id", "item_id", "field",
#                    "old_value", "new_value" }, ... ] }   # id 倒序
```

`old_value` / `new_value`：字符串原样，非字符串值（null / number）JSON 序列化。

## 6. 限速与错误码

- item 级端点（本节全部）：**每 board 每 IP 120 次/分钟**（内存滑动窗口，
  `BOARD_AGENT_RPM` 可调），超限 → `429 { "error": "请求过于频繁，请 N 秒后重试", "retry_after": N }`
- `401` token 缺失/过期 · `404` 看板/卡片不存在 · `400` 校验失败（中文明细） · `405` 方法不允许

## 7. 注意事项

- **没有新建/删除卡片端点**（有意不做）；建卡删卡仍需人在看板页面操作。
- PATCH 是「读出 doc、改单条、写回」的单板写路径，与整板 PUT 共用持久化与 version 序列，
  前端轮询会照常看到 agent 的修改（反之亦然，LWW）。
- 成员自动登记只增不删（与导入/页面语义一致）；删成员走页面「成员管理」。
- 整板全量拉取仍可用既有 `GET /api/boards/:id?version=N`（带 token）。
