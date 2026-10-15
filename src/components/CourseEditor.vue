<script setup>
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import api from '@/api.js'
import { generateSessions } from '../../shared/schedule.js'
const props = defineProps({ modelValue: Boolean, course: Object, session: Object })
const emit = defineEmits(['update:modelValue', 'saved'])
const busy = ref(false), formRef = ref()
const form = reactive({})
const weekdays = ['日', '一', '二', '三', '四', '五', '六']
const local = (iso) => new Date(new Date(iso).getTime() + 8 * 3600000).toISOString()
watch(() => props.modelValue, (open) => {
  if (!open) return
  const tomorrow = local(Date.now() + 86400000).slice(0, 10)
  Object.assign(form, {
    course_name: '', english_name: '', name: '',
    term: `${new Date().getFullYear()} 学年`, reason: '',
    schedule: {
      date: tomorrow, start: '13:30', end: '15:00',
      repeat: 'weekly', interval: 1,
      weekdays: [new Date(`${tomorrow}T00:00:00Z`).getUTCDay()],
      until: tomorrow, location: '',
    },
  })
  if (props.course) Object.assign(form, { course_name: props.course.course_name, english_name: props.course.english_name || '', name: props.course.name, term: props.course.term, schedule: props.course.schedule ? JSON.parse(JSON.stringify(props.course.schedule)) : form.schedule })
  if (props.session) Object.assign(form.schedule, { date: local(props.session.start_at).slice(0, 10), start: local(props.session.start_at).slice(11, 16), end: local(props.session.end_at).slice(11, 16), repeat: 'once', location: props.session.location })
  formRef.value?.clearValidate()
})
const preview = computed(() => { try { return { items: generateSessions(form.schedule) } } catch (e) { return { error: e.message, items: [] } } })
const required = (message) => [{ required: true, message, trigger: 'blur' }]
async function save() {
  if (busy.value) return
  if (!await formRef.value.validate().catch(() => false)) return
  if (preview.value.error) return ElMessage.error(preview.value.error)
  busy.value = true
  try {
    const result = await api(props.session ? `/course-sessions/${props.session.id}` : props.course ? `/scheduled-courses/${props.course.id}` : '/scheduled-courses', {
      method: props.session ? 'PATCH' : props.course ? 'PUT' : 'POST', body: JSON.stringify(props.session ? { ...form.schedule, reason: form.reason } : form),
    })
    ElMessage.success(result.requiresApproval ? '申请已提交，管理员批准后生效' : props.course ? '课程安排已更新' : '课程已创建')
    emit('saved'); emit('update:modelValue', false)
  } catch (e) { ElMessage.error(e.message) } finally { busy.value = false }
}
</script>

<template>
  <el-dialog :model-value="modelValue" :title="session ? '调整单次课程' : course ? '修改后续课程安排' : '添加课程'" width="min(680px, 94vw)" class="course-dialog" :close-on-click-modal="false" :before-close="(done) => { if (!busy) done() }" @update:model-value="emit('update:modelValue', $event)">
    <el-form ref="formRef" :model="form" label-position="top" @submit.prevent="save">
      <template v-if="!session">
        <div class="form-grid">
          <el-form-item label="中文课程名称" prop="course_name" :rules="required('请输入中文课程名称')"><el-input v-model="form.course_name" placeholder="例如：C 程序设计" maxlength="100" /></el-form-item>
          <el-form-item label="英文课程名称" prop="english_name" :rules="required('请输入英文课程名称')"><el-input v-model="form.english_name" placeholder="例如：C Programming" maxlength="100" /></el-form-item>
          <el-form-item label="教学班名称" prop="name" :rules="required('请输入教学班名称')"><el-input v-model="form.name" placeholder="例如：计算机 2026 级 1 班" maxlength="100" /></el-form-item>
          <el-form-item label="学期" prop="term" :rules="required('请输入学期')"><el-input v-model="form.term" maxlength="64" /></el-form-item>
        </div>
        <el-divider content-position="left">上课安排</el-divider>
      </template>
      <el-alert v-if="course && !session" title="将替换未开始的课次" type="warning" :closable="false" show-icon />
      <div class="form-grid">
        <el-form-item label="上课日期（北京时间）" required><el-date-picker v-model="form.schedule.date" type="date" value-format="YYYY-MM-DD" placeholder="选择日期" /></el-form-item>
        <el-form-item label="上课地点" prop="schedule.location" :rules="required('请输入上课地点')"><el-input v-model="form.schedule.location" placeholder="例如：第一教学楼 1001" maxlength="100" /></el-form-item>
        <el-form-item label="开始时间" required><el-time-picker v-model="form.schedule.start" format="HH:mm" value-format="HH:mm" placeholder="开始时间" /></el-form-item>
        <el-form-item label="结束时间" required><el-time-picker v-model="form.schedule.end" format="HH:mm" value-format="HH:mm" placeholder="结束时间" /></el-form-item>
      </div>
      <template v-if="!session">
        <el-form-item label="重复周期"><el-radio-group v-model="form.schedule.repeat"><el-radio-button value="once">不重复</el-radio-button><el-radio-button value="daily">按天</el-radio-button><el-radio-button value="weekly">按周</el-radio-button></el-radio-group></el-form-item>
        <div v-if="form.schedule.repeat !== 'once'" class="form-grid">
          <el-form-item label="重复间隔"><el-input-number v-model="form.schedule.interval" :min="1" :max="12" /> <span class="muted">{{ form.schedule.repeat === 'weekly' ? '周' : '天' }}一次</span></el-form-item>
          <el-form-item label="重复结束日期" required><el-date-picker v-model="form.schedule.until" value-format="YYYY-MM-DD" placeholder="选择结束日期" /></el-form-item>
        </div>
        <el-form-item v-if="form.schedule.repeat === 'weekly'" label="每周上课日"><el-checkbox-group v-model="form.schedule.weekdays"><el-checkbox v-for="day in [1,2,3,4,5,6,0]" :key="day" :value="day">周{{ weekdays[day] }}</el-checkbox></el-checkbox-group></el-form-item>
      </template>
      <el-form-item v-if="course || session" label="调课原因" prop="reason" :rules="required('请填写调课原因')"><el-input v-model="form.reason" type="textarea" placeholder="例如：节假日调课" maxlength="500" show-word-limit /></el-form-item>
      <el-alert :type="preview.error ? 'warning' : 'info'" :closable="false" :title="preview.error || `预计生成 ${preview.items.length} 次课程`" />
      <div v-if="preview.items.length" class="schedule-preview"><el-tag v-for="item in preview.items.slice(0, 5)" :key="item.start_at" type="info">{{ local(item.start_at).slice(0,10) }} {{ form.schedule.start }}–{{ form.schedule.end }}</el-tag><span v-if="preview.items.length > 5" class="muted">等 {{ preview.items.length }} 次</span></div>
    </el-form>
    <template #footer><el-button :disabled="busy" @click="emit('update:modelValue', false)">取消</el-button><el-button type="primary" :loading="busy" @click="save">{{ course ? '保存调整' : '创建课程' }}</el-button></template>
  </el-dialog>
</template>

<style scoped>
.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0 20px; }
.form-grid :deep(.el-date-editor) { width: 100%; }
.muted { color: var(--el-text-color-secondary); font-size: 13px; line-height: 1.7; }
.schedule-preview { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
@media(max-width:600px) { .form-grid { grid-template-columns: 1fr; } }
</style>
