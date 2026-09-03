# 拾光轴 · Timeline Board

简化版 Trello，但把「列」换成时间轴：横轴为日期（默认今天 ±14 天，数据驱动可扩展），纵列为当天内容卡片。React + TypeScript + Vite + Tailwind + shadcn/ui + dnd-kit，纯本地 H5，数据存 localStorage。

**首次启动**：没有历史数据时，今天列会出现两张引导卡（「欢迎使用拾光轴 · 5 分钟上手」与「CLI 批量导入真实数据」），点开即可查看完整操作说明；删掉它们或开始录入自己的内容后，引导卡不会再次出现。

```bash
npm install
npm run dev        # 开发
npm run build      # 构建
```

## 批量导入真实数据（CLI）

> 📖 完整使用指南（自包含，可直接粘贴到飞书文档）：[docs/cli-import-guide.md](docs/cli-import-guide.md)

```bash
# 推荐两步走：先产品目录，再内容卡片（示例文件的 product_id 为 P-200x 系列）
npm run import:data -- --products examples/products-sample.csv
npm run import:data -- examples/import-sample.csv

npm run import:data -- <文件.json|文件.csv> [--dry-run] [--merge] [--strict]
npm run import:data -- --products <产品文件.json|产品文件.csv> [--dry-run] [--merge] [--strict]
```

- 读取 JSON / CSV → 逐行校验、归一化为 `ContentItem` → 按日期分组计算 orders → 写出 `public/data/board.json`（结构 `{ items, orders, products?, importedAt }`）。
- **下次打开或刷新页面自动生效**：应用启动时 `fetch('data/board.json')`，若其 `importedAt` 与 localStorage 中记录的标记不同，则采用文件数据并覆写 localStorage；相同则保留页面上的后续编辑。再次执行 CLI 导入（产生新 `importedAt`）才会重新接管。
- `--products`（独立产品目录导入，不与 items 文件混用）：只导入产品目录，写出 `{ products, importedAt }`（无 `items` 键）——页面接管时**仅更新产品目录，不动现有内容卡片**。v13 起恒为**差分合并**（`mergeProducts`：同 id 改名更新、新 id 追加、未提及保留，**永不删除**——删产品走页面「产品管理」；`--merge` 为兼容保留）；CLI 写出的 products 是与已有 `board.json` 差分后的累积全量（全新浏览器的唯一状态来源），报告打印「新增/更新/保留」差分统计。产品文件格式：JSON 为 `[{ "id", "name" }, ...]` 或 `{ "products": [...] }`；CSV 表头 `产品ID,产品名称`（别名：id/产品ID/产品编号、name/产品名/产品名称/名称）。校验：id 必填非空且文件内唯一、name 必填非空，逐行带行号报错，退出码语义同 items 版。
- **卡片行自动登记新产品**：items 中 `product_id` 不在目录时不再警告，而是按随行 `product_name`（中文别名 `产品名`/`产品名称`，缺省用 id 占位）自动登记进目录并合并进写出的 products——卡片导入后直接显示产品名；占位名永远不覆盖已有真实名称。
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
| ROI | `roi` | 可空或非负数字；未发布强制置 null |
| 备注 | `comment` | 可空，默认 `''` |
| 产品ID | `product_id` | 可空：缺失/空置 `''`（未归属，UI 显示「不明」，报告汇总条数，不跳行）；不在目录中 → 自动登记为新产品（随行 `product_name` 作名，缺省 id 占位，报告汇总「自动登记新产品」） |
| 产品名 / 产品名称 | `product_name` | 可空：仅当 `product_id` 不在目录时生效，作为自动登记的名称；同 id 多行取第一个非空值 |
| 曝光4h | `propagation_4h` | 可空或非负数字；未发布强制置 null |
| 互动4h | `engagement_4h` | 可空或非负数字；未发布强制置 null |

字段口径（ROI = 发布后 7 天归因销售额 ÷ 广告花费；曝光/互动为发布后 4 小时窗口等）以 `src/types/content.ts` 的 JSDoc 为准。

**页面内入口**：顶栏「产品管理」弹窗对产品目录增删改（使用计数实时显示，删除被引用产品后引用卡片自动降级「不明」，新增行 id 自动取 `P-<最大编号+1>`）；顶栏「导入」按钮在页面内做增量导入（与 CLI `--merge` 同一套校验与合并语义，共享 `src/lib/import-core.ts`），结果报告弹窗含四宫格统计、产品目录差分行（新增/更新/保留）与自动登记新产品数。产品目录是一等本地状态，存 `timeline-board-v4:products`，初始仅内置 `P-1000` 光轴。

**CSV**：首行表头（中英文均可），解析器遵循 RFC4180（引号包裹、`""` 转义、字段内逗号与换行）。无第三方依赖。

**未发布语义**：`publish_at` 晚于当前时间的记录，三个指标一律强制为 `null`，并在报告中提示条数。

**数据驱动的看板窗口**：日列范围 = `max(今天 ±14 天, 数据最早/最晚日期)`，窗口外的历史/未来数据导入后自动扩列。

### 数据优先级与初始数据

优先级：**`board.json`（importedAt 变化时接管） > localStorage（`timeline-board-v4`） > 首次启动引导卡**。

- localStorage 中没有数据（首次启动）→ 播种两张引导卡（今天列，待发布、无指标）。
- localStorage 数据结构合法即照用——**包括空数组**：把卡片全部删除是你的合法状态，刷新不会复活引导卡。
- localStorage 数据损坏 → 视同首次启动，重新播种引导卡。
- 想清空全部数据重新开始：浏览器 DevTools 里清除站点数据（或 `localStorage.clear()`）后刷新，即回到两张引导卡的初始状态。

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
