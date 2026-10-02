import { MODULE_BY_KEY } from '@/data/modules'
import {
  ACCEPTANCE_ARCHIVED,
  ACCEPTANCE_KEY,
  PASS_CONCLUSION,
  judgeConclusion,
  rejudgeAcceptance,
} from '@/data/acceptance'
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

// 验收结论按现行阈值落库，存量验收单在读取前先重判一遍（幂等，无改动不写库）。
function ensureAcceptance(): EntryRow[] {
  return rejudgeAcceptance().rows
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
  if (key === ACCEPTANCE_KEY) {
    ensureAcceptance()
  }
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function getEntry(key: string, id: number): EntryRow | undefined {
  if (key === ACCEPTANCE_KEY) {
    ensureAcceptance()
  }
  return listRows(key).find((row) => Number(row.id) === id)
}

// 同一验收单重复提交只保存一条：按验收单号唯一，再次提交更新原单而不是新增。
export function saveAcceptanceDraft(draft: {
  验收单号: string
  验收探方: string
  验收类别: string
  验收人: string
  验收日期: string
  遗留问题数: number
}): ActionResult & { id?: number; duplicated?: boolean } {
  const code = draft.验收单号.trim()
  if (!code) {
    return { ok: false, message: '验收单号不能为空' }
  }
  if (!draft.验收探方.trim()) {
    return { ok: false, message: '验收探方不能为空' }
  }
  const rows = ensureAcceptance()
  const index = rows.findIndex((row) => String(row['验收单号'] ?? '') === code)
  const remaining = Math.max(0, Math.floor(Number(draft.遗留问题数) || 0))
  const base: EntryRow = {
    ...(index >= 0 ? rows[index] : { id: 0, status: '待验收', pending: true, abnormal: false }),
    验收单号: code,
    验收探方: draft.验收探方.trim(),
    验收类别: draft.验收类别.trim(),
    验收人: draft.验收人.trim(),
    验收日期: draft.验收日期,
    遗留问题数: remaining,
  }
  if (index >= 0 && String(rows[index].status) === ACCEPTANCE_ARCHIVED) {
    return { ok: false, message: `验收单 ${code} 已归档，按当时结论留档，不能再次提交` }
  }
  let duplicated = false
  if (index >= 0) {
    // 同一单号重复提交：只保留这一条，并按现行阈值重新给结论。
    duplicated = true
    const submitted = String(rows[index].status) !== '待验收'
    const conclusion = submitted ? judgeConclusion(base) : (String(base['验收结论'] ?? '') || '')
    const status = submitted
      ? (conclusion === PASS_CONCLUSION ? '已通过' : '已整改')
      : '待验收'
    rows[index] = {
      ...base,
      status,
      pending: !submitted,
      验收结论: conclusion,
      验收状态: status,
    }
  } else {
    rows.push({
      ...base,
      id: rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1,
      status: '待验收',
      pending: true,
      abnormal: false,
      验收结论: '',
      验收状态: '待验收',
    })
  }
  saveRows(ACCEPTANCE_KEY, rows)
  rejudgeAcceptance()
  const saved = rows.find((row) => String(row['验收单号'] ?? '') === code)
  return {
    ok: true,
    id: saved ? Number(saved.id) : undefined,
    duplicated,
    message: duplicated ? `验收单 ${code} 已按本次提交更新，未重复建档` : `验收单 ${code} 已登记`,
  }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)

  // 验收单的「提交验收 / 归档验收」走现行阈值判定，结论直接落库。
  if (key === ACCEPTANCE_KEY) {
    const rows = ensureAcceptance()
    const index = rows.findIndex((row) => Number(row.id) === id)
    if (index < 0) {
      return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
    }
    const row = rows[index]
    if (action === '提交验收') {
      if (String(row.status) === ACCEPTANCE_ARCHIVED) {
        return { ok: false, message: '验收单已归档，沿用历史验收结论，不能重复提交' }
      }
      const conclusion = judgeConclusion(row)
      const status = conclusion === PASS_CONCLUSION ? '已通过' : '已整改'
      rows[index] = {
        ...row,
        status,
        pending: false,
        abnormal: false,
        验收结论: conclusion,
        验收状态: status,
      }
      saveRows(ACCEPTANCE_KEY, rows)
      rejudgeAcceptance()
      return { ok: true, message: `验收单已提交，按现行阈值判定为「${conclusion}」` }
    }
    if (action === '归档验收') {
      if (String(row.status) === ACCEPTANCE_ARCHIVED) {
        return { ok: false, message: '验收单已经归档，不用重复操作' }
      }
      if (String(row.status) === '待验收') {
        return { ok: false, message: '验收单尚未提交，归档前请先按现行阈值验收' }
      }
      rows[index] = {
        ...row,
        status: ACCEPTANCE_ARCHIVED,
        pending: false,
        验收状态: ACCEPTANCE_ARCHIVED,
      }
      saveRows(ACCEPTANCE_KEY, rows)
      rejudgeAcceptance()
      return { ok: true, message: `验收单已归档，按当时结论「${row['验收结论']}」留档` }
    }
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }

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
  if (key === ACCEPTANCE_KEY || key === 'trench') {
    // 重置回示例数据后同样按现行阈值重判，并把结论补进探方台账。
    rejudgeAcceptance()
  }
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  if (key === ACCEPTANCE_KEY) {
    ensureAcceptance()
  }
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
  // 概览读取前先跑一遍验收重判，保证探方台账里的结论与验收单一致。
  rejudgeAcceptance()
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
