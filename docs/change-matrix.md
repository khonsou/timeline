# 改动验证矩阵（change-matrix）

> 规则一句话：**改哪层跑哪层**。任务 brief 里的「必跑测试」从下表选。

| 修改范围 | 必跑验证 |
|---|---|
| `packages/core`（类型/校验/合并/派生） | `npm run test:core` |
| `packages/core` changeset-core（变更集预校验/按序应用/id 分配/上限） | `npm run test:core`（changeset-core.test.mjs） |
| `packages/core` group-core / relation-core（v2-M2 分组迁移与归属解析 / v2-M3 关系镜像与图布局） | `npm run test:core`（patch-core / changeset-core / relation-core.test.mjs） |
| `packages/server`（路由/鉴权/存储） | `npm run test:server` |
| `packages/server` change-sets 端点 / If-Match / 审计扩列 / 幂等键 | `npm run test:server`（smoke.mjs 的 change-set 全流程段） |
| `packages/server` 整板 PUT / POST 建板（v2-M3 关系规范化入口） | `npm run test:server`（smoke.mjs 的 v2-M3 规范化段） |
| `packages/server` 自发现三件套（`/api/meta` / `/api/agent-doc` / `X-Protocol-Version` 头） | `npm run test:server`（smoke.mjs 的 v19.1 段） |
| `packages/cli`（解析/校验参数/远端模式组装） | `npm run test:core` + 真实 server 联调（CLI 本身无单测） |
| `web/` 纯样式、文案微调 | `npm run build` |
| `web/` 交互（拖拽 / 编辑 / minimap / 同步 / 鉴权门） | `npm run build` + `npm run test:e2e` |
| `web/` 同步层（pending-patch / If-Match / 409 恢复） | `npm run build` + `npm run test:e2e`（含 t58 冲突恢复用例） |
| `web/` v2-M1 卡片表现（背景色 / 置灰 / 搜索 / 分享链接） | `npm run build` + `npm run test:e2e`（t59–t62） |
| `web/` v2-M2 分组管理（列头改名 / 排序 / 删除 / 跨组拖拽） | `npm run build` + `npm run test:e2e`（t63–t66） |
| `web/` v2-M3 关系视图（前后关系小节 / 图视图 / 暂存带 / 拖拽连线） | `npm run build` + `npm run test:e2e`（t67–t73） |
| 卡片匿名评论（v2-M4：core comment-core / PATCH 白名单 / 详情页评论区） | `npm run test:core`（comment-core + patch-core）+ `npm run test:server`（smoke.mjs v2-M4 段）+ `npm run build` + `npm run test:e2e`（t74） |
| Agent API（item 级端点/change-sets/审计/限速） | `npm run test:server` + Agent 相关 e2e |
| 跨层契约（core 字段、doc 结构、端点签名） | `test:core` + `test:server` + `test:e2e` |

## 为什么交互改动必须跑 e2e

`npm run build`（tsc + vite）只能保证编译通过，**抓不到运行时接线错误**。前科：v19 拖拽碰撞判定——类型与构建全绿，但全局 closestCorners 让拖拽卡自身 rect 赢下判定（实测 82/86 次），相邻日落点无高亮、成功率低；只有真实浏览器分步拖动的 e2e（t57）能锁死这类回归。e2e 自含起停（API :5198 + vite :5199），73 项，约几分钟。

## lint 暂不作门禁

全仓 eslint 有 37 个历史告警（BoardCard.tsx 的 react-hooks/refs + shadcn 模板的 react-refresh 噪音），**未基线化**——基数不干净时设门禁只会训练大家忽略红灯。约定：改动文件不新增告警即可；待历史告警清理或显式基线化后再恢复门禁。
