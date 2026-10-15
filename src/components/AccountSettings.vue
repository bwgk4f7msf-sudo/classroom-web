<script setup>
import { reactive, ref, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { user, setUser } from '@/auth.js'
import { roleNames } from '@/dashboard.js'
import api from '@/api.js'
const profile = ref(null), name = ref(''), nameBusy = ref(false)
onMounted(async () => { try { profile.value = (await api('/profile')).profile; name.value = profile.value?.name || '' } catch (e) { ElMessage.error(e.message) } })
async function requestName() {
  nameBusy.value = true
  try { await api('/profile/name-request', { method: 'POST', body: JSON.stringify({ name: name.value }) }); ElMessage.success('姓名修改申请已提交，请在我的申请中查看审核结果') } catch (e) { ElMessage.error(e.message) } finally { nameBusy.value = false }
}
const busy = ref(false)
const form = reactive({ currentPassword: '', password: '', confirm: '' })
async function save() {
  if (busy.value) return
  if (!form.currentPassword || form.password.length < 8 || !/\d/.test(form.password) || !/[^0-9]/.test(form.password)) return ElMessage.error('请填写原密码，新密码须至少 8 位且包含数字和非数字字符')
  if (form.password !== form.confirm) return ElMessage.error('两次新密码不一致')
  busy.value = true
  try { await api('/auth/password', { method: 'PATCH', body: JSON.stringify(form) }); ElMessage.success('密码已更新，请重新登录'); setUser(null) } catch (e) { ElMessage.error(e.message) } finally { busy.value = false }
}
</script>
<template>
  <el-card v-if="user" shadow="never" class="settings-card"><template #header><h2>账户与安全</h2></template>
    <el-descriptions :column="1" border><el-descriptions-item label="账号">{{ user.username }}</el-descriptions-item><el-descriptions-item label="身份">{{ roleNames[user.role] }}</el-descriptions-item><el-descriptions-item label="排课时区">Asia/Shanghai（北京时间）</el-descriptions-item></el-descriptions>
    <template v-if="profile"><h3>个人资料</h3><p>学号 / 工号：{{ profile.student_no || profile.teacher_no }}</p><p>当前姓名：{{ profile.name }}</p><el-form label-position="top" @submit.prevent="requestName"><el-form-item label="申请修改姓名"><el-input v-model="name" maxlength="80" /></el-form-item><el-button native-type="submit" :loading="nameBusy">提交管理员审核</el-button></el-form></template>
    <h3>修改密码</h3><el-form label-position="top" @submit.prevent="save"><el-form-item label="原密码" required><el-input v-model="form.currentPassword" type="password" show-password autocomplete="current-password" /></el-form-item><el-form-item label="新密码" required><el-input v-model="form.password" type="password" show-password autocomplete="new-password" placeholder="请输入新密码" /></el-form-item><el-form-item label="确认新密码" required><el-input v-model="form.confirm" type="password" show-password autocomplete="new-password" /></el-form-item><el-button type="primary" native-type="submit" :loading="busy">更新密码</el-button></el-form>
  </el-card>
</template>
<style scoped>.settings-card { max-width: 620px; }h2 { margin: 0; font-size: 18px; }h3 { margin-top: 28px; font-size: 16px; }</style>
