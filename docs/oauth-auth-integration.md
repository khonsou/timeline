# Timeline 接入 angrymiao-auth 开发文档

> 适用项目：`timeline-board`（`E:/timeline`）  
> 适用场景：Timeline H5 使用 angrymiao-auth 的统一账号登录。  
> 文档状态：接入设计与开发实施说明；当前只记录方案，不代表 Timeline 代码已经完成改造。

## 1. 接入结论

Timeline 当前没有账号登录，只有看板级密码门：

```text
进入 /b/:boardId
  → POST /api/boards/:boardId/auth { password }
  → Timeline server 返回板级 HMAC token
  → token 保存到 sessionStorage
  → 后续看板 API 使用 Authorization: Bearer <board token>
```

第一期接入采用“双层登录”模型：

```text
angrymiao-auth OAuth 登录 = Timeline 应用账号登录/身份识别
Timeline 看板密码          = 现有看板访问权限
```

这样可以新增统一账号入口，又不会改变现有首页、建板、看板密码、删除看板和同步逻辑。OAuth access token **不能直接当作** Timeline server 的板级 token 使用。

## 2. 当前项目基线

| 项目 | 当前实现 | 接入影响 |
| --- | --- | --- |
| 前端 | React + Vite，`web/src/App.tsx` 自定义 history 路由 | 增加 `/oauth/callback` 路由 |
| 正式地址 | `https://timeline.angrymiao.com/aVoSaywtHjXCA` | OAuth 回调必须包含 base path |
| 前端 base path | `VITE_BASE_PATH=/aVoSaywtHjXCA/` | 构造回调和 API 地址时不能丢前缀 |
| 现有登录 | `BoardPage` 内 `PasswordGate` | 保留，不改为 OAuth 自动放行 |
| 现有 token | `sessionStorage`，按 `board_id` 存储 | 与 OAuth 会话分开命名、分开处理 |
| API server | `packages/server/index.mjs`，只校验板级 HMAC token | 第一阶段无需更新 gRPC 或 Timeline server |
| 生产发布 | `deploy/deploy.sh`，前端镜像内构建静态文件 | 只改前端时发布客户端即可 |

关键现有文件是 `web/src/lib/router.ts`、`web/src/lib/api.ts`、`web/src/pages/HomePage.tsx`、`web/src/pages/BoardPage.tsx` 和 `packages/server/index.mjs`；分别负责路由、API/token、首页、看板密码门/同步和板级 HMAC token。

## 3. Auth 正式环境配置

Auth 正式环境已登记的 Client 应保持如下契约：

```yaml
oauth:
  clients:
    timeline:
      name: Timeline
      type: h5
      redirect_uris:
        - https://timeline.angrymiao.com/aVoSaywtHjXCA/oauth/callback
      allowed_scopes:
        - profile
        - phone
      require_pkce: true
```

对应常量：

```text
AUTH_ORIGIN  = https://auth.angrymiao.com
CLIENT_ID    = timeline
REDIRECT_URI = https://timeline.angrymiao.com/aVoSaywtHjXCA/oauth/callback
SCOPE        = profile phone
```

Auth 授权页显示的应用名称来自 Client 配置中的 `name`，最终由授权上下文的 `client_name` 提供；Timeline 前端不要把 `Timeline` 写死到登录页。

## 4. OAuth 流程

Timeline 是纯 H5 前端，第一期使用 Authorization Code + PKCE 的整页跳转：点击登录 → 生成 PKCE → 跳转 Auth 登录页 → Auth 回调 `code/state` → Timeline 校验并 exchange → 建立应用登录态 → 回到原页面。

授权页内部的以下接口由 Auth 页面调用，Timeline 不需要直接调用：

```text
GET  /api/oauth/authorize/context
POST /api/oauth/authorize/complete
```

Timeline 只需要调用授权入口和 Token Endpoint：

```text
GET  https://auth.angrymiao.com/oauth/authorize
POST https://auth.angrymiao.com/api/oauth/token
```

## 5. 授权 URL

每次登录前生成新的 `state` 和 PKCE 参数：

```text
code_verifier = 随机高熵字符串
code_challenge = BASE64URL(SHA256(code_verifier))
code_challenge_method = S256
```

示例（参数应通过 `URLSearchParams` 构造，不要手拼）：

```text
https://auth.angrymiao.com/oauth/authorize?
  client_id=timeline&
  response_type=code&
  redirect_uri=https%3A%2F%2Ftimeline.angrymiao.com%2FaVoSaywtHjXCA%2Foauth%2Fcallback&
  scope=profile%20phone&
  state=<state>&
  code_challenge=<challenge>&
  code_challenge_method=S256
```

不要添加 `client_secret`。H5 属于 public client，安全性依赖 HTTPS、PKCE、state 和精确回调白名单。

## 6. Timeline 前端改造落点

建议按以下文件拆分，避免把 OAuth 逻辑塞进 `BoardPage`：

| 文件 | 变更职责 |
| --- | --- |
| `web/src/lib/auth.ts` | Auth 地址、PKCE、state、授权跳转、Token Exchange、内存会话 |
| `web/src/pages/AuthCallbackPage.tsx` | 处理 `code/state/error`，完成 exchange 后恢复原页面 |
| `web/src/components/AuthGate.tsx` | 首页应用级登录入口、登录中/失败状态、退出 |
| `web/src/lib/router.ts` | 增加 `authCallback` 路由，并继续保留现有两类路由 |
| `web/src/App.tsx` | 渲染 callback 页面；其他页面接入 `AuthGate` |
| `web/src/lib/api.ts` | 仅在未来需要 Auth 身份调用后端时增加独立请求封装，不复用板级 token |

路由类型增加 `authCallback` 分支；`parseRoute()` 应在去除 `BASE_PATH` 后识别 `/oauth/callback`，`navigate()` 继续使用现有 `withBasePath()`。

## 7. PKCE 与回调实现要求

### 7.1 发起登录

`auth.ts` 应完成以下顺序：

1. 生成 `state`、`code_verifier` 和 `code_challenge`。
2. 将 `{ state, code_verifier, return_to }` 写入 `sessionStorage`。
3. `return_to` 只能是当前 Timeline 同源的路径、query 和 hash，禁止接受外部 URL。
4. 用 `URLSearchParams` 生成授权 URL。
5. 使用 `window.location.assign()` 做整页跳转。

建议使用命名空间，例如：

```text
timeline:oauth:pending
```

不要把 `code_verifier`、access token 或 refresh token 放进 URL、日志、看板 doc 或 localStorage。

### 7.2 回调处理

`AuthCallbackPage` 的处理顺序：

1. 读取 query 中的 `error`、`error_description`、`code`、`state`。
2. 有 `error` 时显示可理解的失败信息，不调用 Token Endpoint。
3. 读取并删除 pending OAuth 状态；没有 pending 状态直接失败。
4. 使用常量时间比较或严格比较校验回调 `state`。
5. 调用 Token Endpoint 完成 code exchange。
6. 成功后清理地址栏中的 `code/state`，建立应用内存会话。
7. 仅跳转到此前保存且经过同源校验的 `return_to`。

Token exchange 请求：

```http
POST https://auth.angrymiao.com/api/oauth/token
Content-Type: application/x-www-form-urlencoded
```

```text
grant_type=authorization_code
client_id=timeline
code=<code>
redirect_uri=https://timeline.angrymiao.com/aVoSaywtHjXCA/oauth/callback
code_verifier=<code_verifier>
```

成功响应：

```json
{
  "access_token": "...",
  "token_type": "Bearer",
  "expires_in": 86400,
  "refresh_token": "...",
  "refresh_token_expires_in": 2592000,
  "scope": "profile phone"
}
```

第一期建议纯 SPA 只把 access token 放在内存中；refresh token 不落 localStorage。页面刷新后重新登录是可接受行为。若以后要求跨刷新保持登录，应新增 Timeline BFF，由服务端用 Secure、HttpOnly Cookie 保存会话。

## 8. 与现有看板密码的关系

第一期不得做以下事情：

- 不把 Auth access token 写入 `timeline-board-v4:token:<boardId>`。
- 不修改 `BoardPage` 的 `PasswordGate` 为“有账号就自动进入”。
- 不删除 `POST /api/boards/:id/auth` 或改变看板密码接口。
- 不让 Timeline server 直接把 Auth JWT 当作现有 HMAC token 解析。

用户完成 Auth 登录后，Timeline 只知道“应用账号已登录”；访问某一块看板时仍按现有流程输入该板密码。这样能保持现有数据权限模型：账号身份与看板权限不会被错误地混为一谈。

如果未来要求“账号登录后无需看板密码”，那是第二阶段权限改造，需要另立设计并修改 `packages/server/index.mjs`，至少包括用户身份校验、看板 ACL、`user_id` 与看板绑定、权限迁移和服务端 401/403 语义；不应在本次 H5 OAuth 接入中顺手实现。

## 9. 错误处理

| 场景 | 前端动作 |
| --- | --- |
| 用户取消登录 | 显示“已取消登录”，提供重新登录按钮 |
| `state` 缺失或不匹配 | 立即终止，不交换 code，清理 pending 状态 |
| code 过期/重复使用 | 提示重新发起登录；Auth code 默认 60 秒且只能使用一次 |
| `invalid_redirect_uri` | 检查正式回调地址是否与 Auth 配置逐字符一致 |
| `invalid_code_verifier` | 清理旧 pending 状态，重新生成 PKCE 参数 |
| Auth 网络错误 | 保留业务页，提示网络不可达并允许重试 |
| Timeline 看板 API 401 | 继续走现有逻辑：清除板级 token，回到看板密码门 |
| popup 被拦截 | 本项目 H5 不使用 popup；若以后做 Web 端，再降级为整页跳转 |

错误页面不得回显 token、验证码、密码、authorization code 或完整授权 URL。

## 10. 部署步骤

### Auth 侧

确认正式配置已包含 `timeline` Client，并重新加载正式 customer 配置；如果修改了 Auth 配置，按 Auth 仓库的正式配置发布流程更新 ConfigMap/服务。

### Timeline 侧

本次只实现前端 OAuth 时：

```bash
cd E:\timeline
npm ci
npm run build
```

Docker/Kubernetes 发布仍使用现有入口：

```bash
bash deploy/deploy.sh
# 选择 2) 更新客户端
```

`deploy/docker/frontend.Dockerfile` 已固定：

```text
VITE_BASE_PATH=/aVoSaywtHjXCA/
```

因此不要在本地或 CI 中用 `/` 覆盖它。发布后确认：

```text
https://timeline.angrymiao.com/aVoSaywtHjXCA/
https://timeline.angrymiao.com/aVoSaywtHjXCA/oauth/callback
```

回调页由前端 history fallback 提供，不能把该路径配置成 Auth API 回调或 Timeline server API 路由。

若只增加前端登录态，Timeline backend 不需要更新；也不需要更新 gRPC。只有第二阶段让 Timeline backend 校验 Auth 身份或实施 ACL 时，才需要后端契约和部署变更。

## 11. 验证与验收

### 自动验证

OAuth 改动属于前端交互和鉴权门，至少执行：

```bash
cd E:\timeline
npm run build
npm run test:e2e
npm run lint
```

现有全链路回归仍建议执行：

```bash
npm run test:core
npm run test:server
```

测试进程只使用项目约定的 5195–5199 端口，不碰 7100–7102、8787 和 3000 预览进程。

### 手工验收

- 从首页点击统一账号登录，能跳到 `https://auth.angrymiao.com/oauth/authorize`。
- Auth 页面显示 `Timeline`，并保留当前支持的手机号、邮箱、Google、Discord、QQ、微信登录方式。
- 手机号或第三方登录成功后，回到精确的 Timeline callback 地址。
- callback 能拒绝错误 `state`，且不会请求 Token Endpoint。
- 成功 exchange 后，地址栏不再保留 `code` 和 `state`。
- 刷新页面后按约定重新登录；不把 refresh token 写入 localStorage。
- 进入看板仍显示原有密码门，正确密码仍能换取板级 token 并正常同步。
- 板级 token 过期后的 401 行为未改变：回到原有密码门。
- 直接访问 `/b/<id>`、首页建板、删除看板和现有看板编辑功能均无回归。
- 在 Auth 页面选择微信/QQ/Discord/Google 等方式后，均由 Auth 完成登录，Timeline 不新增 provider 代码。

## 12. 回滚方案

OAuth 入口是新增能力。若上线后异常，回滚 Timeline 前端镜像即可；现有看板密码 token、数据库和 API server 不需要回滚。Auth 侧保留 `timeline` Client 不影响原有 Web 登录链路；如需彻底关闭 Timeline OAuth，再停用该 Client 或移除其正式回调白名单。
