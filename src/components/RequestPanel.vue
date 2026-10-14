<script setup>
import { computed, ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import api from '@/api.js'
const props = defineProps({ admin: Boolean, requests: { type: Array, default: null }, title: String })
const router = useRouter()
const emit = defineEmits(['changed'])
const items = ref([]), busy = ref(false), selected = ref(null)
const displayedItems = computed(() => props.requests ?? items.value)
const kinds = { course_create: '新增课程', course_update: '修改课程安排', session_update: '单次调课', course_cancel: '取消课程', name_change: '修改姓名', password_reset: '重置密码' }
const labels = { course_name: '中文课程名称', english_name: '英文课程名称', name: '姓名 / 教学班名称', term: '学期', reason: '原因', date: '日期', start: '开始时间', end: '结束时间', location: '地点', repeat: '重复方式', interval: '重复间隔', weekdays: '上课日', until: '结束日期' }
function fields(payload) { return Object.entries({ ...payload, ...payload.schedule }).filter(([k]) => k !== 'schedule').map(([key, value]) => [labels[key] || key, key === 'repeat' ? ({ once: '不重复', daily: '按天', weekly: '按周' }[value] || value) : key === 'weekdays' ? value.map(d => '周' + '日一二三四五六'[d]).join('、') : value]) }
const states = { pending: '待审核', approved: '已批准', rejected: '已拒绝' }
async function load() { if (props.requests !== null) return; try { items.value = (await api('/requests')).items } catch (e) { ElMessage.error(e.message) } }
function refresh() { if (props.requests !== null) emit('changed'); else load() }
async function review(row, status) {
  let note
  try { note = (await ElMessageBox.prompt('请输入审核说明', status === 'approved' ? '批准申请' : '拒绝申请', { inputValidator: v => !!v?.trim() || '请填写审核说明', inputPlaceholder: '核实情况或拒绝原因' })).value } catch { return }
  busy.value = true
  try { await api(`/requests/${row.id}`, { method: 'PATCH', body: JSON.stringify({ status, note }) }); ElMessage.success('审核完成'); await load(); emit('changed') } catch (e) { ElMessage.error(e.message) } finally { busy.value = false }
}
onMounted(load)
defineExpose({ load })
</script>
<template>
  <el-card shadow="never" class="section-gap">
    <template #header>
      <div class="section-heading">
        <h2>{{ title || (admin ? '申请审核' : '我的申请') }}</h2>
        <el-button @click="refresh">刷新申请</el-button>
      </div>
    </template>
    <el-table :data="displayedItems" empty-text="暂无申请">
      <el-table-column prop="username" label="申请账号" />
      <el-table-column label="类型">
        <template #default="{ row }">{{ kinds[row.kind] }}</template>
      </el-table-column>
      <el-table-column label="状态">
        <template #default="{ row }">{{ states[row.status] }}</template>
      </el-table-column>
      <el-table-column prop="review_note" label="审核说明" />
      <el-table-column label="操作" min-width="200">
        <template #default="{ row }">
          <el-button link @click="selected = row">查看详情</el-button>
          <template v-if="admin && row.status === 'pending'">
            <el-button
              v-if="row.kind === 'password_reset'"
              link type="primary"
              @click="router.push('/dashboard/users')"
            >去重设密码并解禁</el-button>
            <el-button
              v-else
              link type="primary" :disabled="busy"
              @click="review(row, 'approved')"
            >批准</el-button>
            <el-button
              link type="danger" :disabled="busy"
              @click="review(row, 'rejected')"
            >拒绝</el-button>
          </template>
        </template>
      </el-table-column>
    </el-table>
  </el-card>
  <el-dialog
    :model-value="!!selected" title="申请详情"
    width="min(640px, 94vw)" @close="selected = null"
  >
    <template v-if="selected">
      <p>申请人：{{ selected.username }} · {{ kinds[selected.kind] }} · 目标 ID：{{ selected.target_id || '新课程' }}</p>
      <p>申请时间：{{ selected.created_at }}；审核时间：{{ selected.reviewed_at || '尚未审核' }}</p>
      <el-descriptions :column="1" border>
        <el-descriptions-item
          v-for="[label, value] in fields(selected.payload)"
          :key="label" :label="label"
        >{{ value }}</el-descriptions-item>
      </el-descriptions>
      <p v-if="selected.kind.includes('course') || selected.kind === 'session_update'">课程时间均为北京时间。</p>
      <p>{{ selected.review_note }}</p>
    </template>
  </el-dialog>
</template>
