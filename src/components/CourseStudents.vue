<script setup>
import { onUnmounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import api from '@/api.js'

const props = defineProps({ course: Object, role: String })
const emit = defineEmits(['changed'])
const items = ref([])
const loading = ref(false)
const busy = ref(false)
const error = ref('')
let version = 0
onUnmounted(() => { version++ })

async function load() {
  const request = ++version
  if (!props.course) return
  loading.value = true
  error.value = ''
  try {
    const result = await api(`/teaching-classes/${props.course.id}/enrollments`, { cache: 'no-store' })
    if (request === version) items.value = result.items
  } catch (cause) {
    if (request === version) error.value = cause.message
  } finally {
    if (request === version) loading.value = false
  }
}

async function remove(row) {
  if (busy.value) return
  let reason
  try {
    const result = await ElMessageBox.prompt(
      `请填写移除「${row.name} / ${row.student_no}」的原因`,
      props.role === 'admin' ? '移除学生' : '申请移除学生',
      { inputType: 'textarea', inputValidator: value => !!value?.trim() || '请填写原因' },
    )
    reason = result.value
  } catch { return }
  busy.value = true
  try {
    const result = await api(`/enrollments/${row.id}`, {
      method: 'DELETE', body: JSON.stringify({ reason }),
    })
    ElMessage.success(result.requiresApproval ? '移除申请已提交' : '学生已移除')
    await load()
    emit('changed')
  } catch (cause) { ElMessage.error(cause.message) } finally { busy.value = false }
}

watch(() => props.course, load, { immediate: true })
</script>

<template>
  <div class="student-list">
    <div class="list-heading">
      <span>学生名单 · {{ items.length }} 人</span>
      <el-button :loading="loading" @click="load">刷新名单</el-button>
    </div>
    <el-alert v-if="error" type="error" :title="error" :closable="false" />
    <el-table v-loading="loading" :data="items" row-key="id" empty-text="暂无学生">
      <el-table-column prop="student_no" label="学号" min-width="130" />
      <el-table-column prop="name" label="姓名" min-width="110" />
      <el-table-column prop="class_name" label="班级" min-width="120" />
      <el-table-column label="操作" min-width="160">
        <template #default="{ row }">
          <el-tag v-if="row.removal_pending" type="warning" size="small">待审批</el-tag>
          <el-button
            link type="danger"
            :disabled="busy || course.status !== 'active' || (row.removal_pending && role !== 'admin')"
            @click="remove(row)"
          >{{ role === 'admin' ? '移除' : '申请移除' }}</el-button>
        </template>
      </el-table-column>
    </el-table>
  </div>
</template>

<style scoped>
.student-list { min-width: 0; display: grid; gap: 16px; }
.list-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
</style>
