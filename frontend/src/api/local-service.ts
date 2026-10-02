import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

// —— 探方验收：现行判定阈值与存量重判 ——
// 判定条件只有这一份：遗留问题数为零判「通过」，仍有遗留判「已整改」并在判定说明里写明原因。
// 列表、明细、概览统计与探方台账都取这里落库的结果，不再各自在页面上算。
export const ACCEPTANCE_PASS_THRESHOLD = 0

const ACCEPTANCE_KEY = 'acceptance'
const TRENCH_KEY = 'trench'
const ACCEPTANCE_ARCHIVED = '已归档'
const ACCEPTANCE_UNSUBMITTED = '待验收'
const ACCEPTANCE_PENDING_STATUSES = ['待验收', '验收中']

export function acceptanceRemainingIssues(row: EntryRow): number {
  const parsed = Number(row['遗留问题数'])
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0
  }
  return Math.trunc(parsed)
}

export function judgeAcceptance(remaining: number): { conclusion: string; note: string } {
  if (remaining <= ACCEPTANCE_PASS_THRESHOLD) {
    return { conclusion: '通过', note: '' }
  }
  return {
    conclusion: '已整改',
    note: `整改后仍遗留 ${remaining} 条问题，按现行阈值（遗留问题数须为 ${ACCEPTANCE_PASS_THRESHOLD}）判为已整改`,
  }
}

// 同一验收单号重复提交只保存一条：后提交的覆盖先提交的。
function dedupeAcceptance(rows: EntryRow[]): EntryRow[] {
  const indexByFormNo = new Map<string, number>()
  const kept: EntryRow[] = []
  for (const row of rows) {
    const formNo = String(row['验收单号'] ?? '').trim()
    if (!formNo) {
      kept.push(row)
      continue
    }
    const existing = indexByFormNo.get(formNo)
    if (existing === undefined) {
      indexByFormNo.set(formNo, kept.length)
      kept.push(row)
    } else {
      kept[existing] = row
    }
  }
  return kept
}

function rejudgeAcceptanceRow(row: EntryRow): EntryRow {
  // 已归档的验收单沿用历史验收单里的结论留档，不按新阈值重判。
  if (String(row.status) === ACCEPTANCE_ARCHIVED) {
    return row
  }
  const status = String(row.status)
  const judged = status !== ACCEPTANCE_UNSUBMITTED
  const { conclusion, note } = judged
    ? judgeAcceptance(acceptanceRemainingIssues(row))
    : { conclusion: '', note: '' }
  return {
    ...row,
    验收结论: conclusion,
    判定说明: note,
    验收状态: status,
    pending: ACCEPTANCE_PENDING_STATUSES.includes(status),
  }
}

// 重判结果落到探方台账：每个探方取最新一张验收单的结论（归档单取当时留档的历史结论）。
function syncTrenchLedger(acceptanceRows: EntryRow[]): void {
  const trenches = listRows(TRENCH_KEY)
  if (trenches.length === 0) {
    return
  }
  const conclusionByTrench = new Map<string, string>()
  for (const row of acceptanceRows) {
    const trenchNo = String(row['验收探方'] ?? '').trim()
    if (trenchNo) {
      conclusionByTrench.set(trenchNo, String(row['验收结论'] ?? ''))
    }
  }
  const next = trenches.map((row) => {
    const trenchNo = String(row['探方编号'] ?? '').trim()
    const conclusion = conclusionByTrench.get(trenchNo) ?? ''
    if (row['验收结论'] !== undefined && String(row['验收结论']) === conclusion) {
      return row
    }
    return { ...row, 验收结论: conclusion }
  })
  if (JSON.stringify(next) !== JSON.stringify(trenches)) {
    saveRows(TRENCH_KEY, next)
  }
}

// 阈值调整之后存量验收单按现行阈值重判并落库；幂等，验收页每次读取前调用。
export function rejudgeAcceptance(): void {
  const current = listRows(ACCEPTANCE_KEY)
  const next = dedupeAcceptance(current).map(rejudgeAcceptanceRow)
  if (JSON.stringify(next) !== JSON.stringify(current)) {
    saveRows(ACCEPTANCE_KEY, next)
  }
  syncTrenchLedger(next)
}

// 概览统计与明细共用同一份落库数据，「遗留问题总数」跟明细对得上。
export function acceptanceStats(): { label: string; value: number }[] {
  const rows = listRows(ACCEPTANCE_KEY)
  return [
    { label: '待验收探方', value: rows.filter((row) => row.status === '待验收').length },
    { label: '已通过探方', value: rows.filter((row) => row.status === '已通过').length },
    {
      label: '遗留问题总数',
      value: rows.reduce((sum, row) => sum + acceptanceRemainingIssues(row), 0),
    },
  ]
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
