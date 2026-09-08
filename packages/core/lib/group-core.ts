/**
 * 分组（v2-M2 F3 统一分组模型，2026-09-08 终稿）核心规则（纯函数，core 唯一定义，三端复用）
 *
 * 覆盖：
 * - newChangeSetGroupId：change-set group_create 的服务端 id 分配（内容哈希确定性，
 *   同 newChangeSetItemId 风格——同一 change-set 内容重试 id 不变）
 * - migrateGroupId / migrateLegacyGroups：存量看板加载时自动迁移（一次性、幂等）——
 *   老板无 groups 字段时，派生「今天 ±30 天」共 61 个同名日期组（含空日期列，
 *   所见与 v1 滑动窗口首屏一致），窗口内卡片按 publish_at 日期回填 group_id；
 *   窗口外卡片不留组（归虚拟「未分组」列），绝不自动建组（避免 61 上限被静默打爆）
 * - resolveWriteTimeGroup：写入时归属解析（一次性，非运行时耦合）——
 *   create/patch 卡片未显式给 group_id 但带 publish_at 时，挂入组名 == 该日期的组；
 *   无同名日期组 → 归未分组。patch-core / changeset-core / GUI 改期共用本函数
 * - 虚拟「未分组」列不占 groups[] 数据：group_id 缺省/'' = 未分组
 *
 * 本文件保持纯 TypeScript（含 erasable 类型标注），不依赖 DOM / Node API。
 */
import type { ContentItem, Group } from '../types/content'
import { publishDateOf } from './board-view.ts'
import { sha1Hex } from './import-core.ts'

/**
 * group_create 的服务端 id 分配：grp- 前缀 + 内容哈希（name + client_ref + op 序号），
 * 与 newChangeSetItemId 同构——同一 change-set 内容重试得到同一 id（协议 §5.4 幂等），
 * 同 set 内两个同名分组（不同 op 位）也不会撞 id。
 */
export function newChangeSetGroupId(name: string, clientRef: string | null, opIndex: number): string {
  return `grp-${sha1Hex(`${name}|${clientRef ?? ''}|#${opIndex}`).slice(0, 16)}`
}

/** 迁移日期组 id：按日期确定性生成（同一日期重复迁移得到同一 id，幂等关键） */
export function migrateGroupId(date: string): string {
  return `grp-${sha1Hex(`migrate|${date}`).slice(0, 12)}`
}

/** YYYY-MM-DD 组名判定（导航/迁移/归属解析共用的「日期组」口径） */
const DATE_NAME_RE = /^\d{4}-\d{2}-\d{2}$/
export const isDateGroupName = (name: string): boolean => DATE_NAME_RE.test(name)

/** 迁移窗口半径：今天 ±30 天 = 61 个日期组（与 v1 滑动窗口首屏一致） */
export const MIGRATE_WINDOW_RADIUS = 30

/** date("YYYY-MM-DD") ± n 天（本地时区语义，纯字符串/Date 运算） */
function shiftDay(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  dt.setDate(dt.getDate() + n)
  const p2 = (x: number) => String(x).padStart(2, '0')
  return `${dt.getFullYear()}-${p2(dt.getMonth() + 1)}-${p2(dt.getDate())}`
}

export interface MigrateResult {
  /** 今天 ±30 天同名日期组（升序 = 列顺序），恒 61 个（含无卡片的空日期列） */
  groups: Group[]
  /** itemId → 分组 id（仅窗口内卡片；窗口外卡片不在表中 = 归「未分组」） */
  assignments: Record<string, string>
}

/**
 * 存量迁移（加载时自动、一次性、幂等）：老板无 groups 字段 → 派生今天 ±30 天
 * 共 61 个同名日期组，窗口内卡片按 publish_at 日期回填 group_id；
 * 窗口外（历史/未来离群）卡片不分配（归「未分组」虚拟列，保持可见可拖）。
 * 纯函数：不改写 items；同日重跑/多端并发迁移得到同一份 groups（确定性 id）。
 */
export function migrateLegacyGroups(items: ContentItem[], today: string): MigrateResult {
  const groups: Group[] = []
  const byDate = new Map<string, string>()
  for (let i = -MIGRATE_WINDOW_RADIUS; i <= MIGRATE_WINDOW_RADIUS; i++) {
    const date = shiftDay(today, i)
    const id = migrateGroupId(date)
    groups.push({ id, name: date })
    byDate.set(date, id)
  }
  const assignments: Record<string, string> = {}
  for (const it of items) {
    const gid = byDate.get(publishDateOf(it))
    if (gid) assignments[it.id] = gid
  }
  return { groups, assignments }
}

/**
 * 写入时归属解析（一次性，非运行时耦合）：未显式指定 group_id 的写入带着
 * publish_at 时，若存在组名 == publish_at 日期部分（YYYY-MM-DD）的组 → 挂入该组；
 * 无同名日期组 → undefined（归「未分组」，绝不自动建组）。
 * 显式传 group_id（含 null）时调用方不走本函数，以显式值为准。
 * 落盘恒为 group_id：之后组改名卡片不跟随（引用稳定）。
 */
export function resolveWriteTimeGroup(groups: Group[], publishAt: string): string | undefined {
  const date = publishAt.slice(0, 10)
  if (!isDateGroupName(date)) return undefined
  return groups.find((g) => g.name === date)?.id
}
