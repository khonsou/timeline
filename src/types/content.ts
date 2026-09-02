/**
 * 数据层：内容实体（业务语义，仅在新增/编辑时变化）。
 *
 * 设计决策：不保留单独的 publish_date / publish_time 字段 ——
 * publish_at 已完整覆盖日期与时分，看板的「日列归属」从 publish_at 派生，
 * 「列内顺序」属于视图层（见 src/lib/board-view.ts 的 orders），实体上不冗余存储。
 */

/** 内容类型（5 类，配色见 src/lib/content-data.ts 的 TAGS） */
export type ContentType = '图文' | '视频' | '音频' | '直播' | '数据'

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
   * null 语义：publish_at 晚于当前时间（未来计划内容，未发布，无投放数据）。
   */
  roi: number | null

  /** 评审备注 / 复盘文案，允许为空字符串 */
  comment: string

  /** 归属产品 id，引用 content-data.ts 的 PRODUCTS 目录 */
  product_id: string

  /**
   * 发布后 4 小时曝光量（口径：曝光 impressions，发布时刻起 4 小时窗口）。
   * null 语义：未发布（publish_at 在未来），尚无 4h 数据。
   */
  propagation_4h: number | null

  /**
   * 发布后 4 小时互动量（口径：点赞 + 评论 + 分享 + 收藏 的总和，同 4 小时窗口）。
   * null 语义：未发布（publish_at 在未来），尚无 4h 数据。
   */
  engagement_4h: number | null
}
