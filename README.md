# 拾光轴 · Timeline Board

简化版 Trello，但把「列」换成时间轴：横轴为日期（默认今天 ±14 天，数据驱动可扩展），纵列为当天内容卡片。React + TypeScript + Vite + Tailwind + shadcn/ui + dnd-kit。

**v15 起是多用户看板服务**：看板数据存服务端 SQLite，浏览器打开的是「看板列表 → 输密码进板」的多板空间，多人可同时编辑同一块板（轮询同步、整板覆盖 LWW）。前端仍可纯静态托管，API server 零 native 依赖。

```bash
npm install
npm run dev        # 开发：一条命令同时起 API server（:8787）+ vite（转发 CLI 参数）
npm run build      # 构建前端产物 dist/（部署见 docs/deployment.md）
```

## 多用户架构（v15）

- **看板列表 `/`**：新建看板（名称 + 访问密码，建板无门槛）、打开、删除（确认框列出将失去的内容，**必须重新输该板密码**，物理删除不可恢复）。
- **看板页 `/b/:id`**：进板先过密码门；密码正确换 12h token（存 sessionStorage 按板一键，关标签页即失效）。同板连续 5 次密码失败锁 60s（429）。
- **同步**：本地变更写本机缓存后防抖 500ms 整板 PUT（version+1）；每 5s 带 version 轮询，他人改动整板拉取应用（LWW，无冲突检测）；断网显示「离线」，改动存本机缓存、恢复后自动补推；token 过期（401）回密码门，板被删（404）显示不存在页。顶栏同步点实时显示 已同步/同步中/离线。
- **服务端**（`server/index.mjs`，Node ≥ 22.5 直跑）：单表 `boards`（board_id 16 位 hex / name / doc JSON / version / password_hash / 时间戳）；doc = `{ items, orders, products, members, meta }`，前端四份状态原样打包。密码 scrypt 加盐哈希（`scrypt:<salt>:<hash>` + timingSafeEqual 校验），token = `base64url(payload).base64url(HMAC-SHA256)`（密钥 `BOARD_SECRET`，**生产必须设固定值**，缺省随机则重启后 token 全失效）。
- **本机缓存**：localStorage `timeline-board-v4:b:<boardId>` 存整份 doc——离线/慢网也能先看到内容，全量 GET 随后接管。
- **部署**：nginx 静态托管 `dist/` + 反代 `/api` → `server/index.mjs`（pm2 托管），见 [docs/deployment.md](docs/deployment.md) 与 `deploy/`（nginx.conf / ecosystem.config.cjs）；备份 = 拷贝 SQLite 文件。

**首次启动**：新建看板且不勾选「从本机现有数据初始化」时，新板今天列会出现两张引导卡（「欢迎使用拾光轴 · 5 分钟上手」与「CLI 批量导入真实数据」），点开即可查看完整操作说明；删掉它们或开始录入自己的内容后，引导卡不会再次出现。

## 批量导入真实数据（CLI）

> 📖 完整使用指南（自包含，可直接粘贴到飞书文档）：[docs/cli-import-guide.md](docs/cli-import-guide.md)

```bash
# 推荐两步走：先产品目录，再内容卡片（示例文件的 product_id 为 P-200x 系列）
npm run import:data -- --products examples/products-sample.csv
npm run import:data -- examples/import-sample.csv

npm run import:data -- <文件.json|文件.csv> [--dry-run] [--merge] [--strict]
npm run import:data -- --products <产品文件.json|产品文件.csv> [--dry-run] [--merge] [--strict]
```

- 读取 JSON / CSV → 逐行校验、归一化为 `ContentItem` → 按日期分组计算 orders → 写出 `public/data/board.json`（结构 `{ items, orders, products?, members?, importedAt }`）。
- **v15 起 board.json 是「初始化种子」**：不再接管在线看板（看板数据在服务端），而是首页新建看板时勾选**「从本机现有数据初始化」**的数据源（与 v14 及之前的单板 localStorage 四键并存，优先取 localStorage）。CLI 导入 → 回首页勾选初始化建板，数据即进新板。
- `--products`（独立产品目录导入，不与 items 文件混用）：只导入产品目录，写出 `{ products, importedAt }`（无 `items` 键）——v15 下用于初始化出「只带产品目录 + 引导卡」的新板。v13 起恒为**差分合并**（`mergeProducts`：同 id 改名更新、新 id 追加、未提及保留，**永不删除**——删产品走看板页「产品管理」；`--merge` 为兼容保留）；CLI 写出的 products 是与已有 `board.json` 差分后的累积全量（多次导入的唯一累积来源），报告打印「新增/更新/保留」差分统计。产品文件格式：JSON 为 `[{ "id", "name" }, ...]` 或 `{ "products": [...] }`；CSV 表头 `产品ID,产品名称`（别名：id/产品ID/产品编号、name/产品名/产品名称/名称）。校验：id 必填非空且文件内唯一、name 必填非空，逐行带行号报错，退出码语义同 items 版。
- **卡片行自动登记新产品**：items 中 `product_id` 不在目录时不再警告，而是按随行 `product_name`（中文别名 `产品名`/`产品名称`，缺省用 id 占位）自动登记进目录并合并进写出的 products——卡片导入后直接显示产品名；占位名永远不覆盖已有真实名称。
- **负责人按姓名自动登记新成员**：`内容负责人`/`投放负责人` 两列按**姓名**填写——姓名在成员目录（初始内置 `M-1001 林晓` / `M-1002 陈远`）命中 → 复用既有 id；未知名 → 自动登记为新成员（id 自动取 `M-<最大编号+1>`），并与已有 `board.json` 的 members 按**姓名**差分合并后累积全量写出（同名复用既有 id，**永不删除**——删成员走页面「成员管理」；删除被引用成员后引用卡片显示「未分配」）。
- `--dry-run`：只校验 + 打印报告，不写文件。
- `--merge`：合并进已有 `board.json`（同 id 覆盖、新 id 追加，orders 全量重算）；默认全量替换。
- `--strict`：遇第一个无效行即非零退出；默认跳过无效行并在报告汇总（有跳过 exit 1，全有效 exit 0）。

示例文件：`examples/import-sample.json`（含自定义 products 目录）、`examples/import-sample.csv`（中文表头、含引号转义演示）、`examples/products-sample.json` / `examples/products-sample.csv`（独立产品目录）。

### 文件格式

**JSON**：记录数组，或 `{ "items": [...], "products": [{ "id", "name" }] }` 包裹形式。字段用英文名，也接受中文别名：

| 中文字段 | 英文字段 | 规则 |
|---|---|---|
| — | `id` | 缺失时按内容（标题/类型/时间/产品）哈希确定性生成 `auto-xxx`（保证 `--merge` 重复导入幂等）；重复 id 报错 |
| 标题 | `title` | 必填非空 |
| 类型 | `type` | 必填，枚举：`图文 / 视频 / 音频 / 直播 / 数据` |
| 计划发布时间 | `publish_at` | 必填；接受 `YYYY-MM-DDTHH:mm`、`YYYY-MM-DD HH:mm`、`YYYY/M/D H:mm`（可带秒），统一归一化为 `YYYY-MM-DDTHH:mm`；日期不限于看板默认窗口 |
| 状态 | `status` | 可空，枚举：`待执行 / 待发布 / 已发布`（非法值跳行）；空 → 按 `publish_at` 推导（未来 → 待发布，否则已发布）。**状态是指标的开关**：非已发布 → 三指标强制 null；显式填已发布可为未来卡片解锁指标 |
| ROI | `roi` | 可空或非负数字；status ≠ 已发布强制置 null |
| 备注 | `comment` | 可空，默认 `''` |
| 产品ID | `product_id` | 可空：缺失/空置 `''`（未归属，UI 显示「不明」，报告汇总条数，不跳行）；不在目录中 → 自动登记为新产品（随行 `product_name` 作名，缺省 id 占位，报告汇总「自动登记新产品」） |
| 产品名 / 产品名称 | `product_name` | 可空：仅当 `product_id` 不在目录时生效，作为自动登记的名称；同 id 多行取第一个非空值 |
| 内容负责人 | `content_owner` | 可空：按**姓名**填写；目录命中 → 复用既有 id，未知名 → 自动登记为新成员（报告汇总「自动登记新成员」）；空置 `''`（未分配，不跳行） |
| 投放负责人 | `delivery_owner` | 可空：规则同 `content_owner` |
| 曝光4h | `propagation_4h` | 可空或非负数字；status ≠ 已发布强制置 null |
| 互动4h | `engagement_4h` | 可空或非负数字；status ≠ 已发布强制置 null |

字段口径（ROI = 发布后 7 天归因销售额 ÷ 广告花费；曝光/互动为发布后 4 小时窗口等）以 `src/types/content.ts` 的 JSDoc 为准。

**页面内入口**：顶栏「产品管理」弹窗对产品目录增删改（使用计数实时显示，删除被引用产品后引用卡片自动降级「不明」，新增行 id 自动取 `P-<最大编号+1>`）；顶栏「成员管理」弹窗对成员目录增删改（引用计数分列「内容 N · 投放 M」，删除被引用成员后引用卡片自动降级「未分配」，新增行 id 自动取 `M-<最大编号+1>`）；详情页「状态」三分段点击切换（切非「已发布」指标立即置 null 锁定，切回解锁录入），「内容/投放负责人」两个下拉即时保存；顶栏「导入」按钮在页面内做增量导入（与 CLI `--merge` 同一套校验与合并语义，共享 `src/lib/import-core.ts`），结果报告弹窗含四宫格统计、产品目录差分行（新增/更新/保留）、自动登记新产品数与自动登记新成员数。产品/成员目录与卡片一样是该看板 doc 的一等状态，随同步层整板 PUT/轮询在多端间一致。

**CSV**：首行表头（中英文均可），解析器遵循 RFC4180（引号包裹、`""` 转义、字段内逗号与换行）。无第三方依赖。

**未发布语义（v14 起按状态）**：`status ≠ 已发布` 的记录，三个指标一律强制为 `null`，并在报告中提示条数。`status` 缺省按 `publish_at` 推导（未来 → 待发布，否则 → 已发布），与旧版按时间口径一致；显式填 `已发布` 可为未来日期的卡片解锁指标录入。

**数据驱动的看板窗口**：日列范围 = `max(今天 ±14 天, 数据最早/最晚日期)`，窗口外的历史/未来数据导入后自动扩列。

### 初始数据与「从本机现有数据初始化」

v15 的看板内容唯一真源是**服务端 doc**（密码门后进板，轮询同步）。本机数据只在**新建看板**时作为一次性种子：

- 新建看板默认勾选「从本机现有数据初始化」（检测不到可初始化数据时禁用）：数据源 = v14 及之前的单板 localStorage 四键（`timeline-board-v4` / `:products` / `:members`，优先）→ CLI 写出的 `public/data/board.json`（补充）；产品/成员目录在内置目录基础上逐层差分合并。
- 不勾选（或无数据可初始化）→ 新板播种两张引导卡（今天列，待发布、无指标）。
- 看板内把卡片全部删除是合法状态：items 允许为空数组，刷新/他端同步不会复活引导卡。
- 想重来：列表页删除该看板（需输密码）后新建一块即可。

### 无效行演示

```bash
# 构造含无效行的文件
cat > /tmp/bad.json << 'EOF'
[
  { "title": "正常条目", "type": "图文", "publish_at": "2026-09-03T10:00", "product_id": "P-2001" },
  { "title": "", "type": "图文", "publish_at": "2026-09-03T10:00", "product_id": "P-2001" },
  { "title": "类型错误", "type": "短视频", "publish_at": "2026-09-03T10:00", "product_id": "P-2001" },
  { "title": "日期错误", "type": "图文", "publish_at": "下周三", "product_id": "P-2001" }
]
EOF
npm run import:data -- /tmp/bad.json --dry-run   # 逐行报错，exit code 1
```
