# AGENTS.md — 拾光轴 · Timeline Board（代理协作手册）

> 给在本仓库干活的代理与人：只写「改动时必读」。架构看 [docs/architecture.md](docs/architecture.md)，改动验证看 [docs/change-matrix.md](docs/change-matrix.md)，历史决策看 [docs/decisions.md](docs/decisions.md)。

## 项目一句话

多用户时间轴看板：横轴 = 今天 ±30 天滑动窗口（61 列虚拟化），纵列 = 当天内容卡片。npm workspaces 单仓四包（v19 起），React + Vite 前端、零 native 依赖 Node 服务端（SQLite）、CLI 批量导入。

## 模块边界

| 包 | 边界 | 不做什么 |
|---|---|---|
| `packages/core`（@timeline/core） | 唯一数据契约层：类型（types/content.ts）、导入校验/归一化/差分合并、orders 与日期派生（lib/）、格式化。**纯 TS 零依赖零构建**，三端（web/server/cli）经 workspaces 软链直引（strip-types） | 不碰 DOM/网络/DB；core 内部只用相对路径 |
| `packages/server`（@timeline/server） | 单文件 `index.mjs`（571 行）：DB / 鉴权 / Agent API / 路由一体，Node ≥22.5 直跑。**拆模块是待做项，不要在功能任务里顺手拆** | 不含业务校验规则（引用 core） |
| `packages/cli`（@timeline/cli） | 批量导入 + 产品/成员差分更新，写出 `web/public/data/board.json` 种子。指南：[docs/cli-import-guide.md](docs/cli-import-guide.md) | 不在线改看板（v15 起只是建板种子） |
| `web/`（@timeline/web） | 表现层：`src/pages/`（HomePage 列表 / BoardPage 看板）+ `src/components/board/`（业务组件）+ `src/components/ui/`（shadcn 基础组件）+ `src/lib/`（运行时数据适配） | 不自定义卡片字段（数据结构只能在 core 改） |

## 读取范围约定（控制上下文）

- 表现层任务默认只读：`BoardPage.tsx` + 目标组件 + 数据层（`src/lib/content-data.ts` / `@timeline/core` 相关文件）+ 相关 e2e 段。
- **不默认读 `web/src/components/ui/`**：那是 shadcn 基础组件库，非业务上下文；确需改样式行为时按需单文件读取。
- 每个任务控制在 **3~8 个文件**；超过就先回头拆任务，不要扩大阅读面。

## 标准任务 brief（每次任务开始时明确）

```
目标：     一句话说清要达成什么
涉及模块： packages/core | packages/server | packages/cli | web/（到组件级）
不修改：   明确排除的文件/模块（防止顺手改）
验收标准： 可观察的断言（哪项测试/哪个行为）
必跑测试： 按 docs/change-matrix.md 选
```

## 测试命令与验证纪律

改哪层跑哪层（完整矩阵见 [docs/change-matrix.md](docs/change-matrix.md)）：

| 命令 | 覆盖 | 规模 |
|---|---|---|
| `npm run test:core` | core 纯函数单测（node:test） | 20 项，秒级 |
| `npm run test:server` | server 全链路冒烟（临时端口 5197 + 临时库自建自删） | 24 断言 |
| `npm run test:e2e` | 真实 Chrome 全量回归（`web/verification/e2e-check.mjs`，自含起停 API :5198 + vite :5199） | 57 项 |

- **交互/拖拽/同步/鉴权类 UI 改动必须跑 e2e**：`npm run build` 抓不到运行时接线错误（v19 拖拽碰撞判定即此类）。
- 纯文案/样式微调可只跑 `npm run build`。
- e2e 已知 flake 史：**t45**（成员管理，已 click-until 加固）、**t13**（拖拽边界，偶发时序抖动，复跑即过）——这两项单点失败先复跑再排查。

## 端口纪律

- **7100 / 7101 / 7102 / 8787 是客户端预览进程，永远不碰**（不杀、不占、不重启）。
- 测试只用 **5195–5199**：e2e 独占 5198/5199，server 冒烟用 5197，dev 验证用 5195/5196；跑前查空闲，用完杀进程组并确认释放。

## lint 现状

全仓 eslint 有 **38 个历史告警**（BoardCard.tsx 的 react-hooks/refs + shadcn 模板噪音），未基线化，**暂不作合并门禁**；改动文件不要新增告警即可。

## 协作约定

- 功能实现由子代理完成；**子代理不做任何 git 操作**（不 commit / push / stash / checkout 写操作）。
- git 提交、推送由主代理统一负责。

## 修改禁区 / 注意事项

- **拖拽碰撞检测是组合式判定**（v19 修复）：pointerWithin 锁列 → 列内 closestCorners 选 over（保中点插入）→ 非源列排除拖拽卡自身（保目标列高亮）→ 列外回落全局 closestCorners。改 `DndContext` 配置前**必读** `web/src/components/board/Board.tsx` 该段注释 + e2e 的 t57 用例；旧版全局 closestCorners 会被拖拽卡自身 rect 截胡（实测 82/86 次），不得回退。
- server 生产必须设固定 `BOARD_SECRET`（缺省随机 → 重启后全部 token 失效）。
- 单板 2000 张硬上限是服务端 + CLI + 页面三处共同语义，改任一处必须三处对齐。
