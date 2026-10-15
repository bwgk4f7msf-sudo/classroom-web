<script setup>
import { computed, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import RequestPanel from '@/components/RequestPanel.vue'
import UserManagement from '@/components/UserManagement.vue'
import CourseNotifications from '@/components/CourseNotifications.vue'
import SiteHeader from '@/components/SiteHeader.vue'
import CourseEditor from '@/components/CourseEditor.vue'
import CourseCard from '@/components/CourseCard.vue'
import CourseDetails from '@/components/CourseDetails.vue'
import AttendancePanel from '@/components/AttendancePanel.vue'
import AccountSettings from '@/components/AccountSettings.vue'
import StudentEnrollmentDialog from '@/components/StudentEnrollmentDialog.vue'
import { user } from '@/auth.js'
import api from '@/api.js'
import { dateKey, formatDate, formatTime, roleNames, statusNames } from '@/dashboard.js'

const route = useRoute(), router = useRouter()
const loading = ref(false), error = ref(''), saving = ref(false), search = ref('')
const classes = ref([]), sessions = ref([]), users = ref([]), logs = ref([]), records = ref([]), tasks = ref([])
const editor = ref(false), selectedCourse = ref(null), selectedSession = ref(null), details = ref(null)
const enrollment = ref(false), targetClass = ref(null)
const launch = ref(false), launchClass = ref(null), duration = ref(15), lateMinutes = ref(5)
const clock = ref(Date.now()), timer = setInterval(() => { clock.value = Date.now() }, 30000)
onUnmounted(() => { clearInterval(timer); version++ })
const role = computed(() => user.value?.role)
const menus = computed(() => [{ id: '', label: '控制面板', symbol: '▦' }, ...(role.value === 'admin' ? [{ id: 'users', label: '用户管理', symbol: '♙' }] : []), { id: 'courses', label: role.value === 'admin' ? '课程管理' : '课程列表', symbol: '▤' }, ...(role.value !== 'admin' ? [{ id: 'attendance', label: '考勤记录', symbol: '◷' }] : []), { id: 'requests', label: role.value === 'admin' ? '申请审核' : '我的申请', symbol: '✓' }, { id: 'settings', label: '设置', symbol: '⚙' }])
const section = computed(() => String(route.params.section || ''))
const pageTitle = computed(() => menus.value.find((m) => m.id === section.value)?.label)
const navigate = (id = '') => router.push('/dashboard' + (id ? `/${id}` : ''))
const activeClasses = computed(() => classes.value.filter((c) => c.status === 'active'))
const today = computed(() => sessions.value.filter((s) => activeClasses.value.some((c) => c.id === s.teaching_class_id) && dateKey(s.start_at) === dateKey(clock.value)))
const ongoing = computed(() => today.value.filter((s) => Date.parse(s.start_at) <= clock.value && Date.parse(s.end_at) > clock.value))
const requests = ref([])
const pendingRequests = computed(() => requests.value.filter((r) => r.status === 'pending'))
const pendingCount = computed(() => pending.value.length + pendingRequests.value.length)
const pending = computed(() => users.value.filter((u) => u.status === 'pending'))
const courseFor = (id) => classes.value.find((c) => c.id === id)
const nextSession = (id) => sessions.value.find((s) => s.teaching_class_id === id && Date.parse(s.end_at) > clock.value)
const shownClasses = computed(() => activeClasses.value.filter((c) => `${c.course_name} ${c.english_name || ''} ${c.name}`.toLowerCase().includes(search.value.toLowerCase())))
const shownUsers = computed(() => users.value.filter((u) => u.username.toLowerCase().includes(search.value.toLowerCase())))
const detailSessions = computed(() => sessions.value.filter((s) => s.teaching_class_id === details.value?.id))
const liveTasks = computed(() => tasks.value.filter((t) => t.status === 'active' && Date.parse(t.end_at) > clock.value))
const stats = computed(() => role.value === 'admin' ? [['注册用户', users.value.length], ['待处理审批', pendingCount.value], ['有效教学班', activeClasses.value.length], ['今日课次', today.value.length]] : role.value === 'teacher' ? [['我的教学班', activeClasses.value.length], ['今日课次', today.value.length], ['未结束考勤', liveTasks.value.length], ['后续课次', sessions.value.filter((s) => Date.parse(s.start_at) > clock.value).length]] : [['我的课程', activeClasses.value.length], ['今日课次', today.value.length], ['可签到任务', tasks.value.length], ['考勤记录', records.value.length]])
let version = 0
async function refresh() {
  const request = ++version
  if (!user.value) return
  loading.value = true; error.value = ''
  try {
    const result = await Promise.all([api('/schedule'), ...(role.value === 'admin' ? [api('/users'), api('/audit-logs?limit=8'), api('/requests')] : role.value === 'teacher' ? [api('/attendance-tasks')] : [api('/attendance/me'), api('/attendance-tasks/available')])])
    if (request !== version) return
    classes.value = result[0].classes; sessions.value = result[0].sessions
    if (details.value) details.value = courseFor(details.value.id) || null
    if (role.value === 'admin') { users.value = result[1].items; logs.value = result[2].items; requests.value = result[3].items }
    else if (role.value === 'teacher') tasks.value = result[1].items
    else { records.value = result[1].items; tasks.value = result[2].items }
  } catch (e) { if (request === version) { error.value = e.message; if (e.status === 401) router.replace('/login') } } finally { if (request === version) loading.value = false }
}
watch(() => user.value?.id, () => {
  version++; requests.value = []; classes.value = []; sessions.value = []; users.value = []; logs.value = []; records.value = []; tasks.value = []
  editor.value = false; details.value = null; enrollment.value = false; launch.value = false
  if (!user.value) router.replace('/login'); else refresh()
}, { immediate: true })
watch(section, () => { search.value = ''; if (!menus.value.some((m) => m.id === section.value)) router.replace('/dashboard') }, { immediate: true })
async function execute(fn, message) {
  if (saving.value) return false
  saving.value = true
  try { await fn(); ElMessage.success(message); await refresh(); return true } catch (e) { ElMessage.error(e.message); return false } finally { saving.value = false }
}
async function approve(u, status) {
  try { await ElMessageBox.confirm(`${status === 'active' ? '批准 / 启用' : '拒绝 / 停用'}账号「${u.username}」？`, '确认账户操作', { type: 'warning' }) } catch { return }
  await execute(() => api(`/users/${u.id}`, { method: 'PATCH', body: JSON.stringify({ status }) }), '账户状态已更新')
}
async function cancelCourse(c) {
  let reason
  try { reason = (await ElMessageBox.prompt('请输入取消原因', '申请取消课程', { inputValidator: v => !!v?.trim() || '请填写原因' })).value } catch { return }
  if (await execute(() => api(`/scheduled-courses/${c.id}/cancel`, { method: 'POST', body: JSON.stringify({ reason }) }), '取消课程申请已提交')) details.value = null
}
function edit(c = null, s = null) { selectedCourse.value = c; selectedSession.value = s; editor.value = true }
async function archive(c) {
  try { await ElMessageBox.confirm('确认归档该教学班？', '归档教学班', { type: 'warning' }) } catch { return }
  if (await execute(() => api(`/teaching-classes/${c.id}`, { method: 'DELETE' }), '已归档')) details.value = null
}
function addStudent(c = null) {
  targetClass.value = c?.id || activeClasses.value[0]?.id || null
  enrollment.value = true
}
function launchTask() { launchClass.value = activeClasses.value[0]?.id || null; launch.value = true }
async function createTask() {
  if (!launchClass.value || !duration.value || lateMinutes.value == null || lateMinutes.value > duration.value) return ElMessage.warning('请检查课程和签到时间设置')
  const start = Date.now()
  if (await execute(() => api('/attendance-tasks', { method: 'POST', body: JSON.stringify({ teaching_class_id: launchClass.value, start_at: new Date(start).toISOString(), late_at: new Date(start + lateMinutes.value * 60000).toISOString(), end_at: new Date(start + duration.value * 60000).toISOString() }) }), '考勤已开始')) launch.value = false
}
</script>

<template>
  <el-container class="app-layout dashboard-layout" direction="vertical">
    <SiteHeader />
    <div v-if="user" class="workspace">
      <aside class="sidebar">
        <div class="profile"><el-avatar :size="80" :src="user.avatar || undefined">{{ user.username.slice(0, 1).toUpperCase() }}</el-avatar><strong>{{ user.username }}</strong><el-tag size="small" effect="plain">{{ roleNames[role] }}</el-tag></div>
        <el-menu :default-active="section || 'overview'" @select="navigate($event === 'overview' ? '' : $event)"><el-menu-item v-for="m in menus" :key="m.id" :index="m.id || 'overview'"><span class="menu-symbol" aria-hidden="true">{{ m.symbol }}</span>{{ m.label }}</el-menu-item></el-menu>
        <div class="sidebar-caption">SAM-LAB CLASSROOM<br><span>让每一堂课井然有序</span></div>
      </aside>
      <main v-loading="loading" class="dashboard-main">
        <div class="page-heading"><div><el-breadcrumb separator="/"><el-breadcrumb-item>{{ roleNames[role] }}工作台</el-breadcrumb-item><el-breadcrumb-item>{{ pageTitle }}</el-breadcrumb-item></el-breadcrumb><h1>{{ pageTitle }}</h1><p>{{ formatDate(clock) }} · 北京时间</p></div><div class="heading-actions"><el-button :loading="loading" @click="refresh">刷新</el-button><el-button v-if="role === 'teacher'" type="primary" @click="edit()">＋ 添加课程</el-button></div></div>
        <el-alert v-if="error" :title="error" type="error" show-icon :closable="false" class="section-gap"><template #default><el-button link type="primary" @click="refresh">重新加载</el-button></template></el-alert>
        <template v-if="!section">
          <template v-if="role === 'admin'">
            <el-card shadow="never" class="important-card"><template #header><div class="section-heading"><h2>重要信息</h2><el-tag :type="pendingCount ? 'warning' : 'success'">{{ pendingCount ? `${pendingCount} 项待处理` : '暂无待办' }}</el-tag></div></template>
              <el-alert title="教师注册审批" :description="pending.length ? '请核实身份后审批' : '暂无待审核教师'" :type="pending.length ? 'warning' : 'success'" show-icon :closable="false" />
              <el-table v-if="pending.length" :data="pending"><el-table-column prop="username" label="教师账号" /><el-table-column prop="created_at" label="申请时间" /><el-table-column label="操作" width="160"><template #default="{ row }"><el-button link type="primary" :disabled="saving" @click="approve(row, 'active')">批准</el-button><el-button link type="danger" :disabled="saving" @click="approve(row, 'disabled')">拒绝</el-button></template></el-table-column></el-table>
              <RequestPanel admin :requests="pendingRequests" title="待处理申请" @changed="refresh" />
              <el-button link type="primary" @click="navigate('requests')">查看全部申请与审核历史 →</el-button>
            </el-card>
          </template>
          <template v-else>
            <div class="section-heading"><h2>{{ role === 'teacher' ? '正在进行的课程' : '今日课程' }}</h2><el-button link type="primary" @click="navigate('courses')">全部课程 →</el-button></div>
            <div v-if="(role === 'teacher' ? ongoing : today).length" class="course-grid section-gap"><CourseCard v-for="s in (role === 'teacher' ? ongoing : today)" :key="s.id" :course="courseFor(s.teaching_class_id)" :session="s" :now="clock" today @details="details = $event" /></div>
            <el-card v-else shadow="never" class="section-gap"><el-empty :description="role === 'teacher' ? '当前没有正在进行的课程' : '今天暂无课程安排'" :image-size="80"><el-button v-if="role === 'teacher'" type="primary" @click="edit()">添加课程</el-button><el-button v-else @click="navigate('courses')">查看我的课程</el-button></el-empty></el-card>
            <el-card v-if="role === 'teacher'" class="section-gap" shadow="never"><template #header><h2>快速开始</h2></template><div class="quick-actions"><el-button type="primary" plain @click="launchTask">发起人脸考勤</el-button><el-button type="primary" plain @click="navigate('attendance')">人工登记 / 补签</el-button><el-button type="primary" plain @click="edit()">添加课程</el-button><el-button type="primary" plain @click="addStudent()">添加学生</el-button><el-button @click="navigate('attendance')">考勤与异常复核</el-button></div></el-card>
            <el-card v-else class="section-gap" shadow="never"><template #header><h2>考勤提醒</h2></template><el-alert :title="tasks.length ? `当前有 ${tasks.length} 个可签到任务，请使用 Android 端签到` : '当前没有可签到任务'" type="info" :closable="false" show-icon /><el-button class="section-gap" @click="navigate('attendance')">查看个人考勤记录</el-button></el-card>
          </template>
          <div class="stats-grid section-gap"><el-card v-for="[label, value] in stats" :key="label" shadow="never"><el-statistic :title="label" :value="value" /></el-card></div>
          <el-card v-if="role === 'admin'" shadow="never" class="section-gap"><template #header><h2>最近系统活动</h2></template><el-table :data="logs" empty-text="暂无操作记录"><el-table-column prop="action" label="操作" /><el-table-column prop="resource_type" label="资源" /><el-table-column prop="actor_id" label="操作人 ID" width="110" /><el-table-column label="时间"><template #default="{ row }">{{ dateKey(row.created_at) }} {{ formatTime(row.created_at) }}</template></el-table-column></el-table></el-card>
          <el-card v-if="role === 'teacher'" shadow="never" class="section-gap"><template #header><h2>今日课程安排</h2></template><el-table :data="today" empty-text="今天暂无课次"><el-table-column label="课程"><template #default="{ row }">{{ courseFor(row.teaching_class_id)?.course_name }}</template></el-table-column><el-table-column label="时间"><template #default="{ row }">{{ formatTime(row.start_at) }}–{{ formatTime(row.end_at) }}</template></el-table-column><el-table-column prop="location" label="地点" /><el-table-column label="操作"><template #default="{ row }"><el-button link type="primary" @click="details = courseFor(row.teaching_class_id)">查看 / 调课</el-button></template></el-table-column></el-table></el-card>
        </template>
        <el-card v-if="section === 'users' && role === 'admin'" shadow="never"><template #header><div class="section-heading"><h2>账户列表</h2><el-input v-model="search" class="search-input" placeholder="搜索账号" clearable /></div></template><el-table :data="shownUsers" empty-text="暂无用户"><el-table-column prop="username" label="账号" /><el-table-column label="角色"><template #default="{ row }">{{ roleNames[row.role] }}</template></el-table-column><el-table-column label="状态"><template #default="{ row }"><el-tag :type="row.status === 'active' ? 'success' : 'warning'">{{ statusNames[row.status] }}</el-tag></template></el-table-column><el-table-column label="操作"><template #default="{ row }"><el-button v-if="row.role !== 'admin'" link :type="row.status === 'active' ? 'danger' : 'primary'" :disabled="saving" @click="approve(row, row.status === 'active' ? 'disabled' : 'active')">{{ row.status === 'active' ? '停用' : '批准 / 启用' }}</el-button></template></el-table-column></el-table></el-card>
        <template v-if="section === 'courses'"><div class="section-heading"><h2>{{ role === 'student' ? '我的课程' : '教学班与课程安排' }}</h2><el-input v-model="search" class="search-input" placeholder="搜索课程或教学班" clearable /></div><div class="course-grid section-gap"><CourseCard v-for="c in shownClasses" :key="c.id" :course="c" :session="nextSession(c.id)" :now="clock" @details="details = $event" /></div><el-empty v-if="!shownClasses.length" :description="search ? '没有匹配的课程' : '暂无课程，添加课程或联系教师加入教学班'" /></template>
        <AttendancePanel v-if="section === 'attendance' && role !== 'admin'" :role="role" :classes="classes" :tasks="tasks" :records="records" @refresh="refresh" />
        <RequestPanel v-if="section === 'requests'" :admin="role === 'admin'" @changed="refresh" />
        <UserManagement v-if="section === 'users' && role === 'admin'" :accounts="users" @changed="refresh" />
        <CourseNotifications v-if="role === 'student'" :key="user.id" @changed="refresh" />
        <AccountSettings v-if="section === 'settings'" />
      </main>
    </div>
    <CourseEditor v-model="editor" :course="selectedCourse" :session="selectedSession" @saved="refresh" />
    <CourseDetails
      :course="details" :sessions="detailSessions" :role="role" :now="clock" :busy="saving"
      @close="details = null" @edit="edit(details, $event)" @add-student="addStudent(details)"
      @cancel="cancelCourse(details)" @archive="archive(details)" @changed="refresh"
    />
    <StudentEnrollmentDialog
      v-model="enrollment" :classes="classes" :initial-class-id="targetClass" @saved="refresh"
    />
    <el-dialog v-model="launch" title="发起考勤" width="min(480px, 94vw)" :close-on-click-modal="false"><el-form label-position="top"><el-form-item label="课程 / 教学班"><el-select v-model="launchClass" placeholder="请选择课程"><el-option v-for="c in activeClasses" :key="c.id" :value="c.id" :label="`${c.course_name} · ${c.name}`" /></el-select></el-form-item><el-form-item label="签到时长（分钟）"><el-input-number v-model="duration" :min="1" :max="180" :precision="0" /></el-form-item><el-form-item label="开始后多少分钟记为迟到"><el-input-number v-model="lateMinutes" :min="0" :max="duration || 180" :precision="0" /></el-form-item><el-alert title="确认后立即开始考勤" type="info" :closable="false" /></el-form><template #footer><el-button :disabled="saving" @click="launch = false">取消</el-button><el-button type="primary" :loading="saving" @click="createTask">开始考勤</el-button></template></el-dialog>
  </el-container>
</template>

<style scoped>
.dashboard-layout { background: var(--el-bg-color-page); color: var(--el-text-color-primary); }
.workspace { display: flex; flex: 1; min-height: calc(100vh - 50px); }.sidebar { width: 220px; flex: 0 0 220px; background: var(--el-bg-color); border-right: 1px solid var(--el-border-color-light); display: flex; flex-direction: column; }
.profile { padding: 32px 16px 26px; display: flex; flex-direction: column; align-items: center; gap: 12px; }.profile .el-avatar { background: var(--el-color-primary-light-8); color: var(--el-color-primary); font-size: 28px; }.profile strong { overflow-wrap: anywhere; font-size: 18px; }.el-menu { border-right: 0; }.el-menu-item { margin: 4px 12px; border-radius: var(--el-border-radius-base); height: 48px; }.el-menu-item.is-active { background: var(--el-color-primary-light-9); }.menu-symbol { width: 30px; font-size: 20px; }.sidebar-caption { margin-top: auto; padding: 32px 24px; color: var(--el-text-color-secondary); font-size: 11px; line-height: 2; letter-spacing: 1px; }.sidebar-caption span { letter-spacing: 0; }
.dashboard-main { min-width: 0; flex: 1; padding: 30px 36px 48px; max-width: 1600px; }.page-heading { display: flex; align-items: center; justify-content: space-between; gap: 20px; margin-bottom: 28px; }.page-heading h1 { font-size: 26px; margin: 16px 0 8px; }.page-heading p { color: var(--el-text-color-secondary); margin: 0; font-size: 13px; }.heading-actions { display: flex; }h2 { font-size: 18px; margin: 0; font-weight: 600; }.stats-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 18px; }.stats-grid :deep(.el-statistic__content) { font-size: 30px; margin-top: 8px; }.section-gap { margin-top: 24px; }.section-heading { display: flex; justify-content: space-between; align-items: center; gap: 12px; }.course-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px; }.muted { color: var(--el-text-color-secondary); font-size: 13px; line-height: 1.8; }.quick-actions { display: flex; gap: 12px; flex-wrap: wrap; }.quick-actions .el-button { margin: 0; min-height: 42px; }.search-input { max-width: 260px; }.important-card { border-top: 3px solid var(--el-color-primary); }
@media(max-width:1100px) { .dashboard-main { padding: 24px; }.sidebar { width: 185px; flex-basis: 185px; }.stats-grid { gap: 10px; }.course-grid { grid-template-columns: 1fr; } }
@media(max-width:700px) { .workspace { flex-direction: column; }.sidebar { width: 100%; flex-basis: auto; }.profile { flex-direction: row; padding: 14px 18px; }.profile :deep(.el-avatar) { width: 36px; height: 36px; font-size: 18px; }.sidebar-caption { display: none; }.el-menu { display: flex; overflow-x: auto; }.el-menu-item { margin: 0; padding: 0 14px; flex-shrink: 0; }.menu-symbol { display: none; }.dashboard-main { padding: 20px 14px; }.stats-grid { grid-template-columns: repeat(2, minmax(0,1fr)); }.page-heading { flex-wrap: wrap; }.page-heading h1 { font-size: 23px; }.section-heading { flex-wrap: wrap; }.search-input { max-width: 100%; } }
</style>
