/**
 * 数据层：内容实体（业务语义，仅在新增/编辑时变化）。
 *
 * 设计决策：不保留单独的 publish_date / publish_time 字段 ——
 * publish_at 已完整覆盖日期与时分，看板的「日列归属」从 publish_at 派生，
 * 「列内顺序」属于视图层（见 src/lib/board-view.ts 的 orders），实体上不冗余存储。
 */

/** 内容类型（5 类，配色见 src/lib/content-data.ts 的 TAGS） */
export type ContentType = '图文' | '视频' | '音频' | '直播' | '数据'

/**
 * 卡片背景色预设色板（v2-M1 F1；v2-M1b 起降级为「写入快捷预设」）：
 * bg_color 是卡片自有属性，直接存具体 hex 色值（小写 #rrggbb）；UI 色板仍提供
 * 8 预设 + 默认，选中后写入数据的是该预设的 hex。hex 选取与 Tailwind 500 色阶一致。
 */
export interface BgColorPreset {
  /** 预设 token（仅 UI 标识与旧数据兼容用，不再写入数据） */
  token: string
  /** 色板里的中文名 */
  label: string
  /** 预设 hex（小写 #rrggbb） */
  hex: string
}
export const BG_COLOR_PRESETS: BgColorPreset[] = [
  { token: 'red', label: '红', hex: '#ef4444' },
  { token: 'orange', label: '橙', hex: '#f97316' },
  { token: 'amber', label: '琥珀', hex: '#f59e0b' },
  { token: 'green', label: '绿', hex: '#22c55e' },
  { token: 'sky', label: '天蓝', hex: '#0ea5e9' },
  { token: 'violet', label: '紫', hex: '#8b5cf6' },
  { token: 'rose', label: '玫瑰', hex: '#f43f5e' },
  { token: 'slate', label: '石灰', hex: '#64748b' },
]

/** 旧色板 token → hex（向后兼容：v2-M1b 前数据/调用可能还带 token） */
export const BG_TOKEN_HEX: Record<string, string> = Object.fromEntries(
  BG_COLOR_PRESETS.map((p) => [p.token, p.hex]),
)

const BG_HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

/**
 * 背景色值归一化（写入口径与读取容错共用）：
 * - '#rgb' / '#rrggbb'（大小写不敏感）→ 小写 #rrggbb
 * - 旧色板 token（'amber' 等，大小写不敏感）→ 对应 hex（数据逐步收敛为 hex）
 * - 其余 → null（非法）
 */
export function normalizeBgColor(raw: string): string | null {
  const v = raw.trim()
  if (!v) return null
  const tokenHex = BG_TOKEN_HEX[v.toLowerCase()]
  if (tokenHex) return tokenHex
  const m = BG_HEX_RE.exec(v)
  if (!m) return null
  const h = m[1].toLowerCase()
  return h.length === 3 ? `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}` : `#${h}`
}

/**
 * 内容状态（3 态，存中文字符串）：
 * - 待执行：刚创建、尚未进入发布流程（新建空卡片的默认状态）
 * - 待发布：已排期、等待发布（导入时 publish_at 在未来的默认推导）
 * - 已发布：已发布、可有 4h/7d 投放数据（导入时 publish_at 在过去的默认推导）
 * 状态是指标的开关：status !== '已发布' → roi / propagation_4h / engagement_4h 恒为 null；
 * 显式标「已发布」可为未来日期的卡片解锁指标录入。
 */
export type ContentStatus = '待执行' | '待发布' | '已发布'

/** 成员（内容/投放负责人目录条目），ContentItem 的两个 owner 字段引用其 id */
export interface Member {
  id: string
  name: string
}

/**
 * 结构化链接（协议 §8）：rel 表示用途（如 publish 发布地址），platform 为可扩展平台串。
 * links 是数组（不设计单一 publish_url）；演进铁律：未来字段只能追加，不得改变已有字段语义。
 */
export interface Link {
  /** 链接条目 id（卡片内唯一即可） */
  id: string
  /** 用途：publish / draft / material … 可扩展字符串 */
  rel: string
  /** 完整 URL */
  url: string
  /** 平台标识（如 xiaohongshu），可扩展字符串，可缺省 */
  platform?: string
}

/**
 * 分组（v2-M2 F3 统一分组模型，2026-09-08 终稿）：{ id, name }，数组序 = 列顺序，≤ 61 个。
 * 不分模式：日期只不过是组名恰巧是 YYYY-MM-DD 的组。
 * 「未分组」是虚拟系统列：不占 groups[] 数据、不可删/改名/排序，恒为第一列；
 * 卡片 group_id 缺省/悬空（加载兜底重置）= 未分组。
 */
export interface Group {
  id: string
  name: string
}

/** 分组总数上限（虚拟「未分组」列不占名额；group_create 超限 → 400） */
export const MAX_GROUPS = 61

export interface ContentItem {
  /** 内容唯一键 */
  id: string

  /** 内容标题（卡片主文案，可 inline 编辑） */
  title: string

  /** 内容类型：图文 / 视频 / 音频 / 直播 / 数据 */
  type: ContentType

  /**
   * 计划发布时间（口径：「计划」发布时间，非实际发布），
   * ISO 本地格式 "YYYY-MM-DDTHH:mm"。
   * 看板日列归属取日期部分；跨日拖拽只改日期部分、保留时分。
   */
  publish_at: string

  /**
   * 投放效率 ROI = 发布后 7 天归因销售额（revenue_attributed_7d）÷ 广告花费（ad_spend）。
   * 仅存储计算结果（1 位小数），分子分母不冗余存储。
   * null 语义：status ≠ '已发布'（未发布，无投放数据）——按状态而非按时间判定。
   */
  roi: number | null

  /** 评审备注 / 复盘文案，允许为空字符串 */
  comment: string

  /**
   * 归属产品 id，引用 content-data.ts 的产品目录（seed 目录优先、内置目录 fallback）。
   * `''` 语义 = 未归属，显示「不明」；目录查不到的 id 同样显示「不明」
   * （tooltip 保留原始 id 便于排查）。
   */
  product_id: string

  /** 内容状态：待执行 / 待发布 / 已发布（口径见 ContentStatus） */
  status: ContentStatus

  /** 内容负责人（成员目录 id）；`''` = 未分配，目录未命中的存量 id 同样显示「未分配」 */
  content_owner_id: string

  /** 投放负责人（成员目录 id）；语义同 content_owner_id */
  delivery_owner_id: string

  /**
   * 发布后 4 小时曝光量（口径：曝光 impressions，发布时刻起 4 小时窗口）。
   * null 语义：status ≠ '已发布'，尚无 4h 数据。
   */
  propagation_4h: number | null

  /**
   * 发布后 4 小时互动量（口径：点赞 + 评论 + 分享 + 收藏 的总和，同 4 小时窗口）。
   * null 语义：status ≠ '已发布'，尚无 4h 数据。
   */
  engagement_4h: number | null

  /**
   * 结构化链接（协议 §8，可缺省）：发布地址 / 素材地址等。
   * comment 只作人工备注，机器协议一律走本字段。
   */
  links?: Link[]

  /**
   * 卡片背景色（v2-M1 F1，可缺省）：卡片自有属性，存具体 hex 色值（小写 #rrggbb；
   * 写入时 #rgb 与大写归一化）。v2-M1b 前的存量数据可能是色板 token（'amber' 等），
   * 读取方经 normalizeBgColor 容错解析。缺省 = 默认白底；「默认」= 移除字段。
   */
  bg_color?: string

  /**
   * 置灰标记（v2-M1 F2，可缺省）：true = 卡片半透明退到背景（仍可读可拖拽可编辑）；
   * undefined/false = 正常点亮。点亮 = 解除置灰（透明度 0.45 → 1 过渡，表现层负责）。
   */
  dimmed?: boolean

  /**
   * 分组 id（v2-M2 F3 统一分组模型，可缺省）：引用 BoardDoc.groups 的分组 id，
   * 决定列归属（publish_at 与分组彻底脱钩，纯信息字段）。
   * 缺省 / 悬空（加载时重置）= 虚拟「未分组」列；写入 null/空串 = 归未分组（移除语义）。
   */
  group_id?: string

  /**
   * 前序卡片 id 数组（v2-M3 F4 卡片关系，可缺省）：多对多有向依赖「前序 → 后续」。
   * **唯一写入源**：客户端/agent 只写 pre_ids；元素须为同看板已存在卡片 id
   * （自环拒绝、重复去重；成环允许，环由视图层降级处理，数据层不禁止）。
   */
  pre_ids?: string[]

  /**
   * 后续卡片 id 数组（v2-M3 F4，可缺省）：**core 镜像字段，外部只读**——
   * 不变量 A.post_ids ∋ B ⇔ B.pre_ids ∋ A；写 pre_ids 时同事务自动维护，
   * 直接 patch post_ids → 400；加载兜底按 pre_ids 重建（悬空 id 剔除）。
   */
  post_ids?: string[]
}

// ---------------------------------------------------------------------------
// Change Set（变更集，协议 §4.2 / §6）：卡片读写的唯一自动化写入口径。
// v1 仅 create / patch 两种 op；delete / reorder 不支持。
// ---------------------------------------------------------------------------

/** create op：服务端分配 id（客户端不可指定）；client_ref 用于追踪提交结果 */
export interface ChangeSetCreateOp {
  op: 'create'
  client_ref?: string
  /** 部分 Item 字段（不含 id）；title / publish_at 必填，其余缺省按新建卡片默认 */
  item: Partial<Omit<ContentItem, 'id'>>
}

/** patch op：与单卡 PATCH 同一套白名单与校验规则 */
export interface ChangeSetPatchOp {
  op: 'patch'
  item_id: string
  changes: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// v2-M2 F3：分组管理 3 个 doc 级 op（统一分组模型，2026-09-08 终稿，无 group_mode）
// set 内先建后引用：group_create 的 client_ref 可被同 set 后续 op 的
// group_id / move_to / before_group_id 直接引用（复用 pending「set 内前序可见」模式）
// ---------------------------------------------------------------------------

/** group_create：服务端分配确定性内容哈希 id（同 newChangeSetItemId 风格，重试幂等）；分组满 61 → 400 */
export interface ChangeSetGroupCreateOp {
  op: 'group_create'
  client_ref?: string
  group: { name: string }
}

/** group_patch：重命名 / 调列序（before_group_id = 移到该分组之前；null = 移到末尾） */
export interface ChangeSetGroupPatchOp {
  op: 'group_patch'
  group_id: string
  changes: { name?: string; before_group_id?: string | null }
}

/**
 * group_delete：删组。move_to 可缺省 = 组内卡片归「未分组」虚拟列；
 * 显式给出时须指向已存在分组（不能是被删分组自身；同 set 新建分组的 client_ref 可引用）。
 */
export interface ChangeSetGroupDeleteOp {
  op: 'group_delete'
  group_id: string
  move_to?: string
}

export type ChangeSetOp =
  | ChangeSetCreateOp
  | ChangeSetPatchOp
  | ChangeSetGroupCreateOp
  | ChangeSetGroupPatchOp
  | ChangeSetGroupDeleteOp

/** 变更集状态机（终态不可逆）：pending → committed / conflicted / rejected / expired */
export type ChangeSetStatus = 'pending' | 'committed' | 'conflicted' | 'rejected' | 'expired'

/** 来源标记：客户端自报，服务端原样透传记录（防君子不防小人） */
export interface ChangeSetSource {
  type: string
  external_run_id?: string
}

/** 执行者身份：第一版客户端自报；未来可由 agent token 载荷派生 */
export interface ChangeSetActor {
  type: string
  id: string
}

/** committed 结果中 create 的 client_ref → 服务端分配 id 的映射（按 operations 顺序） */
export interface ChangeSetCreatedItem {
  client_ref: string | null
  id: string
}

/** committed 结果中 group_create 的 client_ref → 服务端分配分组 id 的映射（v2-M2） */
export interface ChangeSetCreatedGroup {
  client_ref: string | null
  id: string
}

/** 提交结果：committed 时含 version 与 items/groups 映射；rejected 时含完整 errors */
export interface ChangeSetResult {
  /** committed：提交后的看板 version（+1） */
  version?: number
  /** committed：create 的 client_ref → id 映射 */
  items?: ChangeSetCreatedItem[]
  /** committed：group_create 的 client_ref → id 映射（v2-M2） */
  groups?: ChangeSetCreatedGroup[]
  /** rejected：全量校验错误（全批拒绝，不产生部分结果） */
  errors?: string[]
}

export interface ChangeSet {
  change_set_id: string
  board_id: string
  status: ChangeSetStatus
  /** 创建时的看板 version；真正的并发检查发生在 commit */
  base_version: number
  operations: ChangeSetOp[]
  source?: ChangeSetSource
  actor?: ChangeSetActor
  created_at: string
  /** 服务端创建时写入，默认有效期 24 小时；过期为惰性标记（查询/提交时判定） */
  expires_at: string
  result?: ChangeSetResult | null
}
