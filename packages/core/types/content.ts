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
}
