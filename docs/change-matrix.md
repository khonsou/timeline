# 改动验证矩阵（change-matrix）

> 规则一句话：**改哪层跑哪层**。任务 brief 里的「必跑测试」从下表选。

| 修改范围 | 必跑验证 |
|---|---|
| `packages/core`（类型/校验/合并/派生） | `npm run test:core` |
| `packages/server`（路由/鉴权/存储） | `npm run test:server` |
| `web/` 纯样式、文案微调 | `npm run build` |
| `web/` 交互（拖拽 / 编辑 / minimap / 同步 / 鉴权门） | `npm run build` + `npm run test:e2e` |
| Agent API（item 级端点/审计/限速） | `npm run test:server` + Agent 相关 e2e |
| 跨层契约（core 字段、doc 结构、端点签名） | `test:core` + `test:server` + `test:e2e` |

## 为什么交互改动必须跑 e2e

`npm run build`（tsc + vite）只能保证编译通过，**抓不到运行时接线错误**。前科：v19 拖拽碰撞判定——类型与构建全绿，但全局 closestCorners 让拖拽卡自身 rect 赢下判定（实测 82/86 次），相邻日落点无高亮、成功率低；只有真实浏览器分步拖动的 e2e（t57）能锁死这类回归。e2e 自含起停（API :5198 + vite :5199），57 项，约几分钟。

## lint 暂不作门禁

全仓 eslint 有 38 个历史告警（BoardCard.tsx 的 react-hooks/refs + shadcn 模板的 react-refresh 噪音），**未基线化**——基数不干净时设门禁只会训练大家忽略红灯。约定：改动文件不新增告警即可；待历史告警清理或显式基线化后再恢复门禁。
