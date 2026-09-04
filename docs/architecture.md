# 架构（architecture）

> 只画面向改动的骨架。部署拓扑见 [deployment.md](deployment.md)；CLI 格式见 [cli-import-guide.md](cli-import-guide.md)；Agent 端点见 [agent-api.md](agent-api.md)。

## 数据流

```
┌─────────────────────────┐        REST（轮询同步，整板 LWW）        ┌──────────────────────┐
│ web/ 表现层（React）      │  ── GET /boards/:id（全量） ──────────▶  │ packages/server       │
│  HomePage 看板列表        │  ── PUT /boards/:id（防抖 500ms）────▶  │  index.mjs（571 行）   │
│  BoardPage 密码门+看板    │  ◀── 5s 带 version 轮询（他人改动）──   │  node:sqlite 单表      │
│  本地缓存 localStorage    │                                        │  boards + audit_log    │
└─────────────────────────┘                                        └──────────────────────┘
              ▲                                                          ▲            ▲
   建板种子    │                              item 级读写 + 审计 + 限速    │            │ 整板读写（同人鉴权）
┌─────────────┴───────────┐                                  ┌──────────┴───────┐
│ packages/cli（旁路入口 1） │                              │ Agent API（旁路 2） │
│ JSON/CSV → 校验/差分 →    │                              │ 见 agent-api.md    │
│ web/public/data/board.json│                              └───────────────────┘
└─────────────────────────┘
```

- **同步模型**：本地变更先写 localStorage 缓存，防抖 500ms 整板 PUT（version+1）；每 5s 轮询，他人改动整板覆盖应用（LWW，无冲突检测）。断网显示离线、恢复补推；401 回密码门，404 显示不存在页。
- **鉴权**：看板 URL + 密码双重保护即权限；密码换 12h token（scrypt 哈希、HMAC 签名，密钥 `BOARD_SECRET`）。Agent 与人同一口径。
- **CLI（旁路 1）**：v15 起不再接管在线看板，只是首页「从本机现有数据初始化」的建板种子；导入含新产品/新成员时对产品、成员目录做差分合并（永不删除）。
- **Agent API（旁路 2）**：item 级读写端点 + 逐字段审计（`audit_log`）+ 每板每 IP 120 次/分钟限速。

## 表现层与数据分离（硬性原则）

- **卡片数据结构唯一定义在 `packages/core/types/content.ts`**（ContentItem / ContentType / ContentStatus / Member）；web 只消费，不在 web 侧新增或改造字段。要加字段 = 改 core 类型 + import-core 校验 + 三端对齐。
- core 还持有：导入校验/归一化/差分合并（`lib/import-core.ts`）、视图派生（`lib/board-view.ts`：publish_at 拆日期/时分、orders 列内排序、isPublished）、格式化（`lib/format.ts`）。
- web 的 `src/lib/content-data.ts` 只是运行时适配层（产品/成员目录解析、TAGS 配色、窗口日期工具），不定义实体。
- 服务端 doc = `{ items, orders, products, members, meta }`，前端四份状态原样打包，server 不理解字段语义。

## 卡片数据结构要点（ContentItem，以 core 为准）

| 字段 | 口径 |
|---|---|
| `id` | 唯一键；导入缺省时按内容哈希生成 `auto-xxx`（重复导入幂等） |
| `title` | 内容标题（卡片主文案） |
| `type` | 5 枚举：`图文 / 视频 / 音频 / 直播 / 数据` |
| `publish_at` | **唯一时间口径** `YYYY-MM-DDTHH:mm`（计划发布时间）；日列归属取其日期部分，不另存 date/time 字段 |
| `status` | `待执行 / 待发布 / 已发布`；**状态是指标开关**：≠已发布 → 三个指标恒 null |
| `roi` | 发布后 7 天归因销售额 ÷ 广告花费（存结果，1 位小数） |
| `comment` | 备注 / 复盘文案，无字数限制 |
| `product_id` | 产品目录 id；`''` = 未归属 |
| `content_owner_id` / `delivery_owner_id` | 内容 / 投放负责人（成员目录 id；`''` = 未分配） |
| `propagation_4h` / `engagement_4h` | 发布后 4 小时曝光量 / 互动量（点赞+评论+分享+收藏） |
| 互动率 | **派生不存储**：`engagement_4h ÷ propagation_4h`（卡片细条展示；详情页可按 % 编辑反推 engagement_4h） |

## 降级保护原则

产品/成员目录与卡片**解耦**：目录只是 id → 名称的解析表（`content-data.ts` 的 resolveProduct / resolveMember）。

- 卡片引用空 id 或目录查不到的 id → 产品显示「**不明**」、负责人显示「**未分配**」，tooltip 保留原始 id 供排查。
- 目录的增删改（页面管理弹窗、CLI 差分导入）**任何情况下不得导致卡片渲染崩溃**；删除被引用条目只触发显示降级，卡片数据原样保留。
