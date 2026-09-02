# 拾光轴 · Timeline Board

简化版 Trello，但把「列」换成时间轴：横轴为日期（默认今天 ±14 天，数据驱动可扩展），纵列为当天内容卡片。React + TypeScript + Vite + Tailwind + shadcn/ui + dnd-kit，纯本地 H5，数据存 localStorage。

```bash
npm install
npm run dev        # 开发
npm run build      # 构建
```

## 批量导入真实数据（CLI）

```bash
npm run import:data -- <文件.json|文件.csv> [--dry-run] [--merge] [--strict]
```

- 读取 JSON / CSV → 逐行校验、归一化为 `ContentItem` → 按日期分组计算 orders → 写出 `public/data/board.json`（结构 `{ items, orders, products?, importedAt }`）。
- **下次打开或刷新页面自动生效**：应用启动时 `fetch('data/board.json')`，若其 `importedAt` 与 localStorage 中记录的标记不同，则采用文件数据并覆写 localStorage；相同则保留页面上的后续编辑。再次执行 CLI 导入（产生新 `importedAt`）才会重新接管。
- `--dry-run`：只校验 + 打印报告，不写文件。
- `--merge`：合并进已有 `board.json`（同 id 覆盖、新 id 追加，orders 全量重算）；默认全量替换。
- `--strict`：遇第一个无效行即非零退出；默认跳过无效行并在报告汇总（有跳过 exit 1，全有效 exit 0）。

示例文件：`examples/import-sample.json`（含自定义 products 目录）、`examples/import-sample.csv`（中文表头、含引号转义演示）。

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
| 产品ID | `product_id` | 必填非空；不在目录中 → 警告但保留（UI 降级显示 id） |
| 曝光4h | `propagation_4h` | 可空或非负数字；未发布强制置 null |
| 互动4h | `engagement_4h` | 可空或非负数字；未发布强制置 null |

字段口径（ROI = 发布后 7 天归因销售额 ÷ 广告花费；曝光/互动为发布后 4 小时窗口等）以 `src/types/content.ts` 的 JSDoc 为准。

**CSV**：首行表头（中英文均可），解析器遵循 RFC4180（引号包裹、`""` 转义、字段内逗号与换行）。无第三方依赖。

**未发布语义**：`publish_at` 晚于当前时间的记录，三个指标一律强制为 `null`，并在报告中提示条数。

**数据驱动的看板窗口**：日列范围 = `max(今天 ±14 天, 数据最早/最晚日期)`，窗口外的历史/未来数据导入后自动扩列。

### 数据优先级与重置语义

优先级：**`board.json`（importedAt 变化时接管） > localStorage > dummy data**。

顶栏「重置数据」= 清空 localStorage 并重新生成 dummy data，同时**吸收当前 seed 标记**——重置后旧的 `board.json` 不会再接管；再次执行 CLI 导入（新 `importedAt`）才会重新接管。也就是说：导入了 `board.json` 之后，重置一次即可安心回到 dummy；想恢复成导入的数据，删掉 `public/data/board.json` 后重新跑一次导入即可。

### 无效行演示

```bash
# 构造含无效行的文件
cat > /tmp/bad.json << 'EOF'
[
  { "title": "正常条目", "type": "图文", "publish_at": "2026-09-03T10:00", "product_id": "P-1001" },
  { "title": "", "type": "图文", "publish_at": "2026-09-03T10:00", "product_id": "P-1001" },
  { "title": "类型错误", "type": "短视频", "publish_at": "2026-09-03T10:00", "product_id": "P-1001" },
  { "title": "日期错误", "type": "图文", "publish_at": "下周三", "product_id": "P-1001" }
]
EOF
npm run import:data -- /tmp/bad.json --dry-run   # 逐行报错，exit code 1
```
