import { listRows, saveRows } from './local-store'
import type { EntryRow } from './types'

// 探方验收的判定规则集中在这里：页面只渲染，不做任何业务判断。
// 现行阈值（以这一版为准）：遗留问题数为零判「通过」，仍有遗留的判「已整改」并说明原因。
export const ACCEPTANCE_KEY = 'acceptance'
export const TRENCH_KEY = 'trench'

export const ACCEPTANCE_PENDING = '待验收'
export const ACCEPTANCE_REVIEWING = '验收中'
export const ACCEPTANCE_PASSED = '已通过'
export const ACCEPTANCE_RECTIFIED = '已整改'
export const ACCEPTANCE_ARCHIVED = '已归档'

export const PASS_CONCLUSION = '通过'

// 已落定、需要按阈值给结论的验收单；待验收的还没判定，已归档的沿用历史结论不参与重判。
const JUDGED_STATUSES = [ACCEPTANCE_REVIEWING, ACCEPTANCE_PASSED, ACCEPTANCE_RECTIFIED]

export function issueCount(row: EntryRow): number {
  const value = Number(row['遗留问题数'])
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

// 现行阈值下的唯一判定入口：零遗留 → 通过；有遗留 → 已整改，并带上遗留原因。
export function judgeConclusion(row: EntryRow): string {
  const remaining = issueCount(row)
  if (remaining === 0) {
    return PASS_CONCLUSION
  }
  return `已整改：仍遗留 ${remaining} 项问题待复核销项`
}

function conclusionStatus(conclusion: string): string {
  return conclusion === PASS_CONCLUSION ? ACCEPTANCE_PASSED : ACCEPTANCE_RECTIFIED
}

type RejudgeResult = {
  rows: EntryRow[]
  changed: boolean
  rejudged: number
}

// 阈值调整后对存量验收单按现行阈值重判。
// 已归档的验收单沿用当时的验收结论留档，只补齐状态标记，不重新判定。
export function rejudgeAcceptance(force = false): RejudgeResult {
  const result: RejudgeResult = { rows: listRows(ACCEPTANCE_KEY), changed: false, rejudged: 0 }
  if (result.rows.length === 0) {
    return result
  }
  const rows = result.rows.map((row) => {
    if (String(row.status) === ACCEPTANCE_ARCHIVED) {
      return row.pending === false
        ? row
        : { ...row, pending: false, '验收状态': ACCEPTANCE_ARCHIVED }
    }
    if (!JUDGED_STATUSES.includes(String(row.status))) {
      return row
    }
    const conclusion = judgeConclusion(row)
    const status = conclusionStatus(conclusion)
    if (
      row['验收结论'] === conclusion &&
      row.status === status &&
      row.pending === false &&
      row['验收状态'] === status
    ) {
      return row
    }
    result.changed = true
    result.rejudged += 1
    return {
      ...row,
      status,
      pending: false,
      abnormal: false,
      '验收结论': conclusion,
      '验收状态': status,
    }
  })
  result.rows = rows
  if (result.changed || force) {
    saveRows(ACCEPTANCE_KEY, rows)
  }
  syncTrenchLedger(rows)
  return result
}

// 重判结果落到探方那边的台账：探方台账展示对应该探方的最新验收结论。
function syncTrenchLedger(acceptanceRows: EntryRow[]): void {
  const trenches = listRows(TRENCH_KEY)
  if (trenches.length === 0) {
    return
  }
  // 同一探方可能有多张验收单，以编号最大的一单（最新一单）为准写入台账。
  const latestByTrench = new Map<string, EntryRow>()
  for (const row of acceptanceRows) {
    const trenchNo = String(row['验收探方'] ?? '').trim()
    if (!trenchNo) {
      continue
    }
    const current = latestByTrench.get(trenchNo)
    if (!current || Number(row.id) > Number(current.id)) {
      latestByTrench.set(trenchNo, row)
    }
  }
  let changed = false
  const next = trenches.map((trench) => {
    const acceptance = latestByTrench.get(String(trench['探方编号'] ?? '').trim())
    if (!acceptance) {
      return trench
    }
    const snapshot = String(acceptance.status) === ACCEPTANCE_ARCHIVED
      ? `已归档（历史结论：${acceptance['验收结论'] ?? '—'}）`
      : String(acceptance['验收结论'] ?? '—')
    if (trench['验收结论'] === snapshot) {
      return trench
    }
    changed = true
    return { ...trench, '验收结论': snapshot }
  })
  if (changed) {
    saveRows(TRENCH_KEY, next)
  }
}
