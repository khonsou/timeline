# DAO 认证能力开发需求（Timeline 看板 tag ACL 项目）v3.1

> 日期：2026-09-22（v3.1：新增 §11 场景澄清——第三方 agent 已接 DAO 登录时能否复用其 token）
> 日期：2026-09-22（v3 定稿，移交 DAO 开发团队）
> 发起方：Timeline 团队
> 背景：Timeline 看板实施「OAuth 统一主体 + tag ACL」方案（oauth-tag-acl-plan.md v4 已定稿）。agent 认证部分经多轮评审收敛为**单一 Token Delegation 模型**：任何 agent 执行时背后都有一个人类授权，agent 的访问范围 = 授权人的范围。本文档列出需要 DAO（angrymiao-auth）提供的能力。
> Timeline 侧既定约束：token 验证为本地 JWT 校验（RSA 公钥 PEM 验签 + issuer 比对，claims `user_id` int / `role`），不做 introspection 回源；tag 权限的实时权威源是 DAO（`GET /api/task-tag`）。

---

## 0. 最终模型（请先确认理解一致）

Timeline 的访问裁决对所有主体统一一道：**看板所有受管控 tag ∈ 主体的 task-tag 集合（AND）**。所有 agent 流量一律走 delegation token（RFC 8693 语义），按授权人裁决：

| 主体类型 | 认证方式 | 授权范围 | 审计归因 |
|---|---|---|---|
| 人直接操作 | OAuth PKCE（已上线） | 本人 task-tag 集合 | 本人 |
| 员工驱动 agent（第三方 runtime 等） | Delegation，授权人 = 操作员工 | 授权人范围 | agent id + 员工 id |
| 创始人 agent（在场驱动 + 无人值守常驻，同一实体） | Delegation，授权人 = 创始人 | 创始人全部权限 | agent id + 创始人 id |

**已明确的决策（不再讨论）**：
- 否决 M2M client_credentials 独立机器身份。公司哲学：一切 agent 权力必须源于可问责的人类授权。daemon 问责人 = 创始人（无离职风险；创始人变更/公司出售 = 系统变更事件，届时改系统）。M2M 仅保留为 §7 回退条款。
- 创始人驱动的 agent 与常驻 daemon **合并为同一实体**，简化系统；该实体的常驻授权持创始人**全额权限**（含规则调整、SOP 创建），风险已知情接受（见 §6）。
- 员工授权 agent：**自助**（OAuth consent 式，无需审批；agent 范围 ≤ 本人范围）。
- agent 注册：**开放自助**——第三方 agent 通过协议接口自行注册并即时获得调用凭证（参考 RFC 7591 Dynamic Client Registration），无需审批。权限安全由「范围 ≤ 授权人」保证。

## R1（P0，关键路径）：Token Delegation

**首选标准实现：RFC 8693 OAuth 2.0 Token Exchange**。若 DAO 不计划实现 RFC 8693 本体，可接受自定义换取端点，但 R1.1–R1.6 为**硬性要求，不可裁剪**：

### R1.1 换取端点必须认证调用方

agent 必须以注册时获得的自身凭证（client auth）调用换取端点；DAO 校验「该 agent 是否持有该用户的有效授权记录」后才签发。**禁止实现仅凭 JSON 传入 user_id/agent_id 即可铸 token 的无认证端点**（外部 review 草图存在此漏洞，特此标注防误采纳）。

### R1.2 agent 开放自助注册

第三方 agent 通过协议接口自行注册，即时获得 agent_id + 调用凭证（参考 RFC 7591，或 DAO 自定义等价流程）。注册无需审批；具体形态由 DAO 定，唯一约束是 R1.1 的调用方认证必须成立。

### R1.3 token 格式：双重身份 + int user_id

```json
{
  "iss": "<issuer>",
  "sub": "agent:<agent_id>",
  "act": { "sub": "user:<user_id>" },
  "user_id": <int>,
  "aud": "timeline",
  "scope": "<授权范围>",
  "exp": <短期>
}
```

- Timeline 裁决规则：有 `act` 时以被授权人身份查 task-tag 集合；审计同时记录 agent id 与授权人 id。
- 必须能直接取得 **int 型 `user_id`**（与现有 claims 一致，避免 Timeline 增加类型映射层）。
- **agent 自身身份必须保留在 `sub`**：这是审计区分「人本人操作」与「agent 代行」的唯一依据。若 delegation token 丢失 agent 身份，账号泄露时将无法区分盗用者/本人/agent 三类流量——不可接受。

### R1.4 降权（downscoping）能力

DAO 须支持签发时将授权范围收缩到授权人范围的子集（RFC 8693 标准能力）。首版创始人 agent 持全额授权（决策见 §0），但该能力必须就绪，以便后续随时收紧常驻授权而无需 DAO 返工。

### R1.5 授权管理与撤销

- 用户可查看并撤销对某 agent 的授权（管理端点或页面）；员工授权为自助 consent 流程，无需审批；
- 撤销后不再签发新 token（短 TTL 下旧 token 自然失效，可接受，无需 introspection）。

### R1.6 audience 限定

delegation token 签发时 `aud` 限定为 Timeline（具体值由 DAO 定）。防止为其他服务铸造的 token 被重放到 Timeline，反之亦然。请 DAO 评估实现方式。

### R1.7 生命周期策略

- token TTL：≤15 分钟（建议值，接受 DAO 默认）；
- 授权记录有效期与续期规则由 DAO 定（创始人常驻授权可长期），Timeline 无感知——agent 收到 401/403 后引导授权人重新授权。

## R2（P0）：delegation token 的 tag 集合查询

裁决时需按**被授权人**取 task-tag 集合：

- `GET /api/task-tag`（customer，强制 JWT）是否接受 delegation token，并按 `act` 中的用户解析？（优选，Timeline 零新增查询路径）
- 若不接受，请提供等价查询方式。

Timeline 侧计划：按 tag 去重 + 请求级缓存 + 30–60s TTL 削峰。

## R3（P1）：admin 目录（`GET /api/tags`）存在性查询

读路径需区分「DAO 管控 tag」与「历史遗留自由 tag」，依赖 admin 目录。这是本模型下**唯一无人在场的服务端调用**，请提供以下之一：

1. 免 admin 的目录存在性查询端点（优选，不扩大 admin 面）；或
2. 接受以创始人 agent 常驻授权调 admin 目录。

## R4（P0，部署依赖）：验签材料

- RSA 公钥（PEM）与 issuer 值；
- 若 delegation token 与用户 token 的签名密钥或 issuer 不同，请分别提供并说明区分方式。

## R5（P1）：创始人常驻授权登记与应急规程（Timeline 侧执行，需 DAO 配合能力）

Timeline 侧将建立书面规程，需 DAO 确认以下能力存在：

- 授权登记：agent 名称、授权人（创始人）、授权范围、签发日期；
- 授权到期/失效时的重授权流程与紧急联系人；
- 创始人变更（出售公司、无法履职）= 系统变更事件：新授权人重新登记全部常驻授权；
- owner 移交流程（公司规模扩大后常驻授权可移交指定管理员）。

---

## 6. 已接受风险（决策记录）

| 风险 | 缓解 | 状态 |
|---|---|---|
| **创始人 agent 常驻凭证持全额权限（公司最高价值凭证），泄露 = 创始人级权力泄露** | R1.4 降权能力就绪可随时收紧；R1.5 可撤销；凭证仅存受控服务器 | **已接受（创始人决策，2026-09-22）** |
| 创始人账号被安全自动化冻结/2FA 丢失导致常驻授权失效 | R5 应急规程 | 已接受 |
| 问责单点依赖创始人 | R5 继任条款 | 已接受 |
| agent 开放注册被滥用（恶意 agent 套取员工授权） | 权限上限 = 授权人本人范围；R1.1 调用方认证；R1.5 员工可随时撤销 | 已接受 |
| delegation 换取端点被滥用伪造身份 | R1.1 调用方认证硬要求 | 已缓解 |

## 7. 回退条款

若 DAO 正式答复不实现 delegation（R1）：

- 创始人 agent 常驻形态：回退 M2M client_credentials（接口情报 2026-09-21 已确认支持），机器身份 + owner 字段（=创始人）；
- 员工驱动 agent（第三方 runtime）：**暂缓接入**，待 delegation 落地。M2M 凭证不得部署于面向人的共享 runtime——该形态下 Timeline 按 runtime 的机器身份裁决，操作者本人的权限完全不可见，等于 tag ACL 失效，且无中间补丁（runtime 自称的用户身份不可信）。

## 8. 明确不需要 DAO 做的事

- Timeline 业务权限规则（看板/卡片层面判断全部在 Timeline server）；
- 审批流程、业务审计日志；
- Timeline 用户 profile 存储或缓存目录。

DAO 只需保持：用户登录唯一入口、user–tag 关系实时权威源、token 签发机。

## 9. 需要 DAO 团队正式答复的问题清单

Timeline 侧无硬性期限，请 DAO 给出各项的可联调时间。

| # | 问题 |
|---|---|
| Q1 | R1：是否实现 RFC 8693 token exchange？若自定义端点，R1.1–R1.7 硬性要求能否全部满足（含 R1.2 开放自助注册、R1.6 aud 限定）？ |
| Q2 | R2：`/api/task-tag` 能否接受 delegation token 并按被授权人解析？ |
| Q3 | R3：目录存在性查询采用哪种方式？ |
| Q4 | R4：公钥与 issuer 何时可提供？delegation token 验签材料是否相同？ |

## 10. Timeline 侧对应改动（供 DAO 评估联动影响）

- JWT 中间件：`act` 存在时以被授权人 `user_id` 裁决，否则以 `sub` 本人裁决（一行级改动）；
- audit_log：记录 agent id + 授权人 id 双字段；
- agent 收到 401/403：引导授权人重新授权的交互流程；
- 其余（AND 不变量、纯选择制 tag 编辑、fail-closed、TTL 缓存）零改动。


## 11. 场景澄清：第三方 agent 已接入 DAO 登录，能否直接复用其 token 操作 Timeline？

**结论：不能。必须取得针对 Timeline 的独立授权，再通过 token exchange 换取专用 delegation token。**

### 场景

第三方 agent X 自身已接入 DAO OAuth（员工在 agent X 上通过 DAO 登录，agent X 持有员工的 access token）。此时 agent X 要操作 Timeline 卡片。

### 为什么直接挪用不成立

1. **同意语义不匹配**：员工在 agent X 登录时的 consent 是「允许 agent X 知道我是谁」（scope = profile/phone，aud = agent X），不包含「允许它操作我的 Timeline 看板」。挪用等于把登录身份的同意静默升级为操作数据的权力。
2. **audience 校验会拒绝**：Timeline 按 R1.6 校验 `aud`，为 agent X 铸造的 token 在 Timeline 门口被拒。若 Timeline 不校验 aud，则**每一个接过 DAO OAuth 的应用**都能静默以员工身份读写 Timeline——Timeline 沦为 confused deputy。
3. **撤销粒度崩溃**：挪用时「agent X 的 Timeline 权限」与「员工在 agent X 的登录态」是同一个 token，收回 Timeline 权限就得杀掉整个登录会话。独立授权后员工可在 DAO 单独撤销「agent X 代我操作 Timeline」（R1.5）。

### 正确流程

```text
首次（一次性 consent）：
  员工在 agent X 点击「连接 Timeline」
    → DAO 出示 consent：「agent X 请求代你操作 Timeline 看板」
    → 员工同意 → DAO 存授权记录（员工 × agent X × timeline scope）

之后每次（自动，员工无感知）：
  agent X 持注册凭证 + 员工的 subject token
    → 调 DAO token exchange（R1.1 认证调用方、校验授权记录）
    → 换取 aud=timeline、sub=agent:X、act.sub=user:员工 的 delegation token
    → 调 Timeline API，Timeline 按该员工的 task-tag 集合裁决
```

### 对应防线的需求条目

| 防线 | 条目 |
|---|---|
| 换取端点认证调用方 + 校验授权记录 | R1.1 |
| token 受众限定 Timeline，防止跨服务重放 | R1.6 |
| 员工可单独撤销对某 agent 的 Timeline 授权 | R1.5 |
| 审计可区分「员工本人」与「agent X 代行」 | R1.3（agent 身份保留在 `sub`） |
