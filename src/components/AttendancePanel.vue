<script setup>
import { ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import api from '@/api.js'
import { dateKey, formatTime, statusNames } from '@/dashboard.js'
const props = defineProps({ role: String, classes: Array, tasks: Array, records: Array })
const emit = defineEmits(['refresh'])
const selected = ref(null), rows = ref([]), busy = ref(false), loading = ref(false), error = ref('')
const manual = ref(false), members = ref([]), student = ref(null), status = ref('manual'), reason = ref('')
const reviewRow = ref(null)
let version = 0
async function view(task) {
  selected.value = task; rows.value = []; error.value = ''; loading.value = true
  const request = ++version
  try { const data = await api(`/attendance-tasks/${task.id}/records`); if (request === version) rows.value = data.items } catch (e) { if (request === version) error.value = e.message } finally { if (request === version) loading.value = false }
}
async function end(task) {
  try { await ElMessageBox.confirm('未签到学生将被记为缺勤；已记录的异常仍需人工复核。结束后无法重新开启。', '结束考勤', { type: 'warning' }) } catch { return }
  busy.value = true
  try { await api(`/attendance-tasks/${task.id}/end`, { method: 'POST', body: '{}' }); ElMessage.success('考勤已结束'); emit('refresh'); if (selected.value?.id === task.id) await view(task) } catch (e) { ElMessage.error(e.message) } finally { busy.value = false }
}
async function openManual(row = null) {
  reviewRow.value = row; reason.value = ''; student.value = null; status.value = 'manual'
  if (!row) {
    try { members.value = (await api(`/teaching-classes/${selected.value.teaching_class_id}/enrollments`)).items.filter((m) => m.status === 'active') } catch (e) { return ElMessage.error(e.message) }
  }
  manual.value = true
}
async function save() {
  if (busy.value) return
  if ((!reviewRow.value && !student.value) || !reason.value.trim()) return ElMessage.warning('请选择学生并填写原因')
  busy.value = true
  try {
    await api(reviewRow.value ? `/attendance-records/${reviewRow.value.id}/review` : `/attendance-tasks/${selected.value.id}/manual`, { method: reviewRow.value ? 'PATCH' : 'POST', body: JSON.stringify({ student_id: student.value, status: status.value, reason: reason.value }) })
    ElMessage.success('考勤记录已保存'); manual.value = false; await view(selected.value); emit('refresh')
  } catch (e) { ElMessage.error(e.message) } finally { busy.value = false }
}
</script>
<template>
  <el-card shadow="never"><template #header><h2>{{ role === 'teacher' ? '考勤任务' : '个人考勤记录' }}</h2></template>
    <el-table v-if="role === 'teacher'" :data="tasks" empty-text="尚未发起考勤"><el-table-column label="课程" min-width="140"><template #default="{ row }">{{ classes.find((c) => c.id === row.teaching_class_id)?.course_name }}</template></el-table-column><el-table-column label="开始时间" min-width="160"><template #default="{ row }">{{ dateKey(row.start_at) }} {{ formatTime(row.start_at) }}</template></el-table-column><el-table-column label="状态" min-width="130"><template #default="{ row }">{{ row.status === 'active' && Date.parse(row.end_at) <= Date.now() ? '已过期，待结束' : row.status === 'active' ? '开放中' : statusNames[row.status] }}</template></el-table-column><el-table-column label="操作" width="180"><template #default="{ row }"><el-button link type="primary" @click="view(row)">记录 / 复核</el-button><el-button v-if="row.status !== 'ended'" link type="danger" :disabled="busy" @click="end(row)">结束</el-button></template></el-table-column></el-table>
    <div v-if="role === 'teacher' && selected" class="record-heading"><h3>任务 #{{ selected.id }} · 考勤记录</h3><el-button type="primary" plain :disabled="busy" @click="openManual()">人工登记 / 请假</el-button></div>
    <el-alert v-if="error" type="error" :title="error" :closable="false"><template #default><el-button link @click="view(selected)">重试</el-button></template></el-alert>
    <el-table v-if="role === 'student' || selected" v-loading="loading" :data="role === 'student' ? records : rows" empty-text="暂无考勤记录"><el-table-column prop="name" :label="role === 'student' ? '教学班' : '学生'" min-width="130" /><el-table-column v-if="role === 'teacher'" prop="student_no" label="学号" min-width="100" /><el-table-column label="状态" min-width="100"><template #default="{ row }"><el-tag :type="['absent','exception'].includes(row.status) ? 'warning' : 'info'">{{ statusNames[row.status] }}</el-tag></template></el-table-column><el-table-column label="记录时间" min-width="160"><template #default="{ row }">{{ dateKey(row.checked_at) }} {{ formatTime(row.checked_at) }}</template></el-table-column><el-table-column v-if="role === 'teacher'" label="复核" width="90"><template #default="{ row }"><el-button link type="primary" :disabled="busy" @click="openManual(row)">复核</el-button></template></el-table-column></el-table>
    <el-dialog v-model="manual" :title="reviewRow ? '复核考勤记录' : '人工登记 / 请假'" width="min(480px, 94vw)" :close-on-click-modal="false"><el-form label-position="top"><el-form-item v-if="!reviewRow" label="学生" required><el-select v-model="student" placeholder="选择学生"><el-option v-for="m in members" :key="m.student_id" :value="m.student_id" :label="`${m.name} (${m.student_no})`" /></el-select></el-form-item><p v-else>{{ reviewRow.name }} · 当前：{{ statusNames[reviewRow.status] }}</p><el-form-item label="登记状态"><el-select v-model="status"><el-option v-for="s in ['manual', 'present', 'late', 'leave', 'absent', 'exception']" :key="s" :value="s" :label="statusNames[s]" /></el-select></el-form-item><el-form-item label="原因" required><el-input v-model="reason" type="textarea" maxlength="500" show-word-limit /></el-form-item></el-form><template #footer><el-button :disabled="busy" @click="manual = false">取消</el-button><el-button type="primary" :loading="busy" @click="save">保存记录</el-button></template></el-dialog>
  </el-card>
</template>
<style scoped>h2 { margin: 0; font-size: 18px; }.record-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-top: 24px; }h3 { font-size: 16px; }.note { color: var(--el-text-color-secondary); line-height: 1.7; font-size: 13px; }</style>
