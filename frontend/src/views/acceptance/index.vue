<template>
  <section class="page" data-module="acceptance">
    <header class="page-head">
      <div>
        <h2>探方验收管理</h2>
        <p class="page-desc">现行验收标准：遗留问题数为零判「通过」；仍有遗留问题判「已整改」并说明遗留原因。结论按现行阈值落库，列表与明细一致。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记/提交验收单</button>
        <button class="btn" type="button" @click="exportRows">导出探方验收清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ display(row, column) }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button class="link" type="button" @click="openDetail(row)">查看明细</button>
            <button
              v-if="String(row.status) === '待验收'"
              class="link"
              type="button"
              @click="runAction('提交验收', row)"
            >
              提交验收
            </button>
            <button
              v-if="canArchive(row)"
              class="link"
              type="button"
              @click="runAction('归档验收', row)"
            >
              归档验收
            </button>
            <button
              v-if="String(row.status) !== '已归档'"
              class="link"
              type="button"
              @click="openEdit(row)"
            >
              修改
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无探方验收数据，可先登记探方验收单</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条探方验收记录，遗留问题总数与上方明细逐单合计一致</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <div v-if="formVisible" class="modal-mask" @click.self="closeForm">
      <form class="modal-panel" @submit.prevent="submitForm">
        <h3 class="modal-title">{{ formMode === 'create' ? '登记探方验收单' : `修改验收单 ${form.验收单号}` }}</h3>
        <p class="modal-tip">同一验收单号重复提交只保存一条；提交后按现行阈值自动判定结论。</p>
        <label class="modal-field">
          <span>验收单号</span>
          <input v-model="form.验收单号" :disabled="formMode === 'edit'" required placeholder="如 ACCE-0005" />
        </label>
        <label class="modal-field">
          <span>验收探方</span>
          <input v-model="form.验收探方" required placeholder="如 T0104" />
        </label>
        <label class="modal-field">
          <span>验收类别</span>
          <input v-model="form.验收类别" placeholder="阶段验收 / 竣工验收" />
        </label>
        <label class="modal-field">
          <span>验收人</span>
          <input v-model="form.验收人" />
        </label>
        <label class="modal-field">
          <span>验收日期</span>
          <input v-model="form.验收日期" type="date" />
        </label>
        <label class="modal-field">
          <span>遗留问题数（整改后）</span>
          <input v-model.number="form.遗留问题数" type="number" min="0" step="1" required />
        </label>
        <label class="modal-check">
          <input v-model="form.submitNow" type="checkbox" />
          保存后立即提交验收（按现行阈值判定结论）
        </label>
        <p v-if="formError" class="error-text">{{ formError }}</p>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="closeForm">取消</button>
          <button class="btn primary" type="submit">保存</button>
        </div>
      </form>
    </div>

    <div v-if="detailRow" class="modal-mask" @click.self="detailRow = null">
      <article class="modal-panel">
        <h3 class="modal-title">验收单明细 · {{ detailRow['验收单号'] }}</h3>
        <dl class="detail-list">
          <template v-for="field in detailFields" :key="field">
            <dt>{{ field }}</dt>
            <dd>{{ display(detailRow, field) }}</dd>
          </template>
          <dt>当前状态</dt>
          <dd>{{ detailRow.status }}</dd>
        </dl>
        <p v-if="String(detailRow.status) === '已归档'" class="modal-tip">
          该验收单已归档，沿用当时的验收结论留档，阈值调整不再重判。
        </p>
        <div class="modal-actions">
          <button class="btn primary" type="button" @click="detailRow = null">关闭</button>
        </div>
      </article>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  downloadEntries,
  getEntry,
  listEntries,
  moduleMeta,
  runAction as applyAction,
  saveAcceptanceDraft,
} from '@/api/local-service'
import { issueCount } from '@/data/acceptance'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('acceptance')
// 验收结论单独一列：表格末尾另有「当前状态」，不再重复展示「验收状态」列，避免明细里重复显示旧结论。
const columns = ['验收单号', '验收探方', '验收类别', '验收人', '验收日期', '遗留问题数', '验收结论']
const detailFields = [...columns]
const statuses = ['待验收', '验收中', '已通过', '已整改', '已归档']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

// 统计与明细同源：概览卡片的遗留问题总数就是当前列表逐单合计，不会再和明细对不齐。
const stats = computed(() => [
  { label: '待验收探方', value: rows.value.filter((row) => String(row.status) === '待验收').length },
  { label: '已通过探方', value: rows.value.filter((row) => String(row.status) === '已通过').length },
  { label: '遗留问题总数', value: rows.value.reduce((sum, row) => sum + issueCount(row), 0) },
])

function display(row: EntryRow, column: string): string | number {
  if (column === '验收结论') {
    return String(row['验收结论'] ?? '') || '—'
  }
  if (column === '遗留问题数') {
    return issueCount(row)
  }
  const value = row[column]
  return value === undefined || value === '' ? '—' : (value as string | number)
}

function canArchive(row: EntryRow): boolean {
  return ['已通过', '已整改', '验收中'].includes(String(row.status))
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  errorMessage.value = result.ok ? '' : result.message
  reload()
}

// ---- 登记 / 修改弹窗：保存走 service，按验收单号去重，结论只在数据层判定落库 ----
type AcceptanceForm = {
  验收单号: string
  验收探方: string
  验收类别: string
  验收人: string
  验收日期: string
  遗留问题数: number
  submitNow: boolean
}

const emptyForm = (): AcceptanceForm => ({
  验收单号: '',
  验收探方: '',
  验收类别: '',
  验收人: '',
  验收日期: new Date().toISOString().slice(0, 10),
  遗留问题数: 0,
  submitNow: true,
})

const formVisible = ref(false)
const formMode = ref<'create' | 'edit'>('create')
const formError = ref('')
const form = reactive<AcceptanceForm>(emptyForm())

function openCreate() {
  formMode.value = 'create'
  Object.assign(form, emptyForm())
  formError.value = ''
  formVisible.value = true
}

function openEdit(row: EntryRow) {
  formMode.value = 'edit'
  Object.assign(form, {
    验收单号: String(row['验收单号'] ?? ''),
    验收探方: String(row['验收探方'] ?? ''),
    验收类别: String(row['验收类别'] ?? ''),
    验收人: String(row['验收人'] ?? ''),
    验收日期: String(row['验收日期'] ?? ''),
    遗留问题数: issueCount(row),
    submitNow: String(row.status) !== '待验收',
  })
  formError.value = ''
  formVisible.value = true
}

function closeForm() {
  formVisible.value = false
}

function submitForm() {
  formError.value = ''
  const result = saveAcceptanceDraft({
    验收单号: form.验收单号,
    验收探方: form.验收探方,
    验收类别: form.验收类别,
    验收人: form.验收人,
    验收日期: form.验收日期,
    遗留问题数: form.遗留问题数,
  })
  if (!result.ok || result.id === undefined) {
    formError.value = result.message
    return
  }
  if (form.submitNow) {
    const submitted = applyAction(meta.key, result.id, '提交验收')
    if (!submitted.ok) {
      formError.value = submitted.message
      reload()
      return
    }
  }
  formVisible.value = false
  reload()
}

// ---- 明细弹窗：直接读落库后的那份记录，页面不另算结论，也就不会重复显示旧结论 ----
const detailRow = ref<EntryRow | null>(null)

function openDetail(row: EntryRow) {
  detailRow.value = getEntry(meta.key, Number(row.id)) ?? row
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '探方验收列表读取失败'
  }
}

onMounted(reload)
</script>
