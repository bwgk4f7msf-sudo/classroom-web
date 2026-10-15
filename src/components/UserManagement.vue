<script setup>
import { ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import api from '@/api.js'
import UserProfileEditor from './UserProfileEditor.vue'
import { personRow } from '@/user-management.js'

const props = defineProps({ accounts: Array })
const emit = defineEmits(['changed'])
const people = ref([])
const selected = ref(null)
const busy = ref(false)
let version = 0

async function load() {
  const request = ++version
  try {
    const [students, teachers] = await Promise.all([
      api('/students', { cache: 'no-store' }), api('/teachers', { cache: 'no-store' }),
    ])
    if (request !== version) return
    people.value = [
      ...students.items.map(p => personRow(p, 'students')),
      ...teachers.items.map(p => personRow(p, 'teachers')),
    ]
  } catch (error) {
    if (request === version) ElMessage.error(error.message)
  }
}

async function reset(row) {
  if (busy.value || !row.reset_requested) return
  let password
  try {
    const result = await ElMessageBox.prompt(
      `为「${row.name} / ${row.number}」设置新密码`,
      '重置密码并解禁',
      {
        inputType: 'password',
        inputValidator: value => (
          value?.length >= 8 && /\d/.test(value) && /[^0-9]/.test(value)
        ) || '至少 8 位，包含数字和非数字字符',
      },
    )
    password = result.value
  } catch { return }

  busy.value = true
  try {
    await api(`/users/${row.user_id}/reset-password`, {
      method: 'POST', body: JSON.stringify({ password }),
    })
    await load()
    emit('changed')
    ElMessage.success('已重置密码并解禁')
  } catch (error) {
    ElMessage.error(error.message)
    await load()
  } finally { busy.value = false }
}

async function remove(row) {
  if (busy.value) return
  const consequence = row.type === 'teachers'
    ? '其课程将归档。'
    : '其选课将退出。'
  try {
    await ElMessageBox.confirm(
      `确认移除「${row.name} / ${row.number}」？该用户将退出登录。${consequence}`,
      '移除用户',
      { type: 'warning', confirmButtonText: '确认移除', cancelButtonText: '取消' },
    )
  } catch { return }

  busy.value = true
  try {
    await api(`/users/${row.user_id}`, { method: 'DELETE' })
    await load()
    emit('changed')
    ElMessage.success('用户已移除，全部登录已失效')
  } catch (error) { ElMessage.error(error.message) } finally { busy.value = false }
}

async function saved() {
  selected.value = null
  await load()
  emit('changed')
}
watch(() => props.accounts, load, { immediate: true })
</script>

<template>
  <el-card shadow="never" class="section-gap">
    <template #header><h2>学生与教师资料</h2></template>
    <el-table :data="people" row-key="user_id">
      <el-table-column prop="username" label="账号" min-width="110" />
      <el-table-column label="学号 / 工号" min-width="160">
        <template #default="{ row }">
          {{ row.number }}
          <el-tag v-if="row.number_conflict" type="danger" size="small">编号重复，需修正</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="name" label="姓名" min-width="100" />
      <el-table-column label="身份" width="80">
        <template #default="{ row }">{{ row.type === 'students' ? '学生' : '教师' }}</template>
      </el-table-column>
      <el-table-column prop="class_name" label="班级" min-width="100" />
      <el-table-column label="操作" min-width="300">
        <template #default="{ row }">
          <el-button link :disabled="busy" @click="selected = row">修改资料</el-button>
          <el-button
            v-if="row.reset_requested" link type="primary"
            :disabled="busy" @click="reset(row)"
          >重置密码并解禁</el-button>
          <el-button link type="danger" :disabled="busy" @click="remove(row)">
            移除用户
          </el-button>
        </template>
      </el-table-column>
    </el-table>
  </el-card>
  <UserProfileEditor :person="selected" @close="selected = null" @saved="saved" />
</template>
