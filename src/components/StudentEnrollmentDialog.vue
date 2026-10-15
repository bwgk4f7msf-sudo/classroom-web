<script setup>
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import api from '@/api.js'

const props = defineProps({ modelValue: Boolean, classes: Array, initialClassId: Number })
const emit = defineEmits(['update:modelValue', 'saved'])
const classId = ref(null)
const query = ref('')
const page = ref(1)
const total = ref(0)
const pageSize = 20
const items = ref([])
const selected = ref([])
const table = ref()
const loading = ref(false)
const busy = ref(false)
const error = ref('')
let version = 0
let searchTimer

const activeClasses = computed(() => props.classes?.filter(row => row.status === 'active') || [])

function clearSelection() {
  table.value?.clearSelection()
  selected.value = []
}

function close() {
  if (!busy.value) emit('update:modelValue', false)
}

async function load() {
  const request = ++version
  clearTimeout(searchTimer)
  error.value = ''
  if (!props.modelValue || !classId.value) {
    items.value = []
    total.value = 0
    loading.value = false
    return
  }
  loading.value = true
  try {
    const params = new URLSearchParams({ q: query.value, page: page.value, page_size: pageSize })
    const result = await api(`/teaching-classes/${classId.value}/student-candidates?${params}`, {
      cache: 'no-store',
    })
    if (request !== version) return
    items.value = result.items
    total.value = result.total
    await nextTick()
    if (request !== version) return
    for (const row of items.value.filter(row => row.enrolled)) {
      table.value?.toggleRowSelection(row, false)
    }
  } catch (cause) {
    if (request === version) {
      items.value = []
      total.value = 0
      error.value = cause.message
    }
  } finally {
    if (request === version) loading.value = false
  }
}

function search() {
  version++
  clearTimeout(searchTimer)
  loading.value = true
  searchTimer = setTimeout(() => {
    page.value = 1
    load()
  }, 250)
}

function changePage(value) {
  page.value = value
  load()
}

async function save() {
  if (busy.value || loading.value || error.value) return
  if (!classId.value || !selected.value.length) return ElMessage.warning('请选择教学班和学生')
  if (selected.value.length > 500) return ElMessage.warning('每次最多加入 500 名学生')
  busy.value = true
  try {
    const result = await api(`/teaching-classes/${classId.value}/enrollments/batch`, {
      method: 'POST', body: JSON.stringify({ student_ids: selected.value.map(row => row.id) }),
    })
    const skipped = result.skipped ? `，${result.skipped} 名学生已在班中` : ''
    ElMessage.success(`已加入 ${result.added} 名学生${skipped}`)
    emit('saved')
    emit('update:modelValue', false)
  } catch (cause) {
    ElMessage.error(cause.message)
  } finally {
    busy.value = false
  }
}

watch(() => props.modelValue, open => {
  clearTimeout(searchTimer)
  version++
  clearSelection()
  query.value = ''
  page.value = 1
  items.value = []
  total.value = 0
  error.value = ''
  if (open) {
    classId.value = props.initialClassId || activeClasses.value[0]?.id || null
    load()
  }
})

function changeClass() {
  clearSelection()
  query.value = ''
  page.value = 1
  items.value = []
  load()
}

onUnmounted(() => {
  version++
  clearTimeout(searchTimer)
})
</script>

<template>
  <el-dialog
    :model-value="modelValue" title="添加学生" width="min(760px, 94vw)"
    :close-on-click-modal="false" :before-close="done => { if (!busy) done() }"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <el-form label-position="top" @submit.prevent="save">
      <el-form-item label="课程 / 教学班">
        <el-select v-model="classId" :disabled="busy" placeholder="请选择课程" @change="changeClass">
          <el-option
            v-for="course in activeClasses" :key="course.id" :value="course.id"
            :label="`${course.course_name} · ${course.name}`"
          />
        </el-select>
      </el-form-item>
      <el-form-item label="搜索学生">
        <el-input
          v-model="query" clearable maxlength="80" :disabled="busy || !classId"
          placeholder="输入学号或姓名搜索，留空显示全部学生" @input="search"
        />
      </el-form-item>
    </el-form>
    <el-alert v-if="!classId" title="暂无有效教学班，请先添加课程" type="info" :closable="false" />
    <el-alert v-if="error" :title="error" type="error" :closable="false">
      <template #default><el-button link type="primary" @click="load">重新加载</el-button></template>
    </el-alert>
    <div class="list-heading">
      <span>{{ query ? '搜索结果' : '全部有效学生' }} · {{ total }} 人</span>
      <el-button :disabled="busy || loading || !classId" @click="load">刷新名单</el-button>
    </div>
    <el-table
      ref="table" v-loading="loading || busy" :inert="loading || busy"
      :data="items" row-key="id" max-height="360"
      :empty-text="query ? '没有匹配的学生' : '暂无有效学生'"
      @selection-change="selected = $event"
    >
      <el-table-column
        type="selection" width="48" reserve-selection
        :selectable="row => !row.enrolled"
      />
      <el-table-column prop="student_no" label="学号" min-width="140" />
      <el-table-column prop="name" label="姓名" min-width="110" />
      <el-table-column prop="class_name" label="班级" min-width="110" />
      <el-table-column label="状态" width="90">
        <template #default="{ row }">
          <el-tag v-if="row.enrolled" type="info" size="small">已加入</el-tag>
          <span v-else>可加入</span>
        </template>
      </el-table-column>
    </el-table>
    <div class="list-footer">
      <span>已选 {{ selected.length }} 人（翻页保留）</span>
      <el-button link :disabled="busy || !selected.length" @click="clearSelection">清空选择</el-button>
      <el-pagination
        :current-page="page" :page-size="pageSize" :total="total" :disabled="busy || loading"
        layout="prev, pager, next" :pager-count="5" hide-on-single-page @current-change="changePage"
      />
    </div>
    <template #footer>
      <el-button :disabled="busy" @click="close">取消</el-button>
      <el-button
        type="primary" :loading="busy" :disabled="loading || !!error || !classId || !selected.length"
        @click="save"
      >加入选中的 {{ selected.length }} 名学生</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.el-select { width: 100%; }
.list-heading, .list-footer { display: flex; align-items: center; gap: 12px; }
.list-heading { justify-content: space-between; margin: 12px 0; }
.list-footer { flex-wrap: wrap; margin-top: 16px; }
.el-pagination { margin-left: auto; }
@media (max-width: 600px) {
  .el-pagination { width: 100%; margin-left: 0; justify-content: center; }
}
</style>
