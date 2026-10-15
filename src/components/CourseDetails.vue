<script setup>
import { ref, watch } from 'vue'
import CourseStudents from './CourseStudents.vue'
import CourseSessionTable from './CourseSessionTable.vue'

const props = defineProps({ course: Object, sessions: Array, role: String, now: Number, busy: Boolean })
const emit = defineEmits(['close', 'edit', 'add-student', 'cancel', 'archive', 'changed'])
const tab = ref('schedule')
watch(() => props.course?.id, () => { tab.value = 'schedule' })
</script>

<template>
  <el-drawer
    :model-value="!!course" :title="`${course?.course_name || ''} · 课程安排`"
    size="min(820px, 100vw)" class="course-details" @close="emit('close')"
  >
    <section v-if="course" class="detail-content">
      <p class="course-meta">{{ course.english_name }} · {{ course.teacher_name }} · 北京时间</p>
      <div v-if="role !== 'student'" class="course-actions">
        <el-button type="primary" :disabled="busy || course.status !== 'active'" @click="emit('edit', null)">
          修改后续课程安排
        </el-button>
        <el-button :disabled="busy || course.status !== 'active'" @click="emit('add-student')">添加学生</el-button>
        <el-button :disabled="busy" @click="tab = 'students'">学生名单</el-button>
        <el-button
          v-if="role === 'admin'" type="danger" plain
          :disabled="busy || course.status !== 'active'" @click="emit('archive')"
        >归档教学班</el-button>
        <el-button
          v-else type="danger" plain
          :disabled="busy || course.status !== 'active'" @click="emit('cancel')"
        >申请取消课程</el-button>
      </div>
      <el-tabs v-if="role !== 'student'" v-model="tab" class="detail-tabs">
        <el-tab-pane label="课程安排" name="schedule">
          <CourseSessionTable :sessions="sessions" :role="role" :now="now" @edit="emit('edit', $event)" />
        </el-tab-pane>
        <el-tab-pane label="学生名单" name="students" lazy>
          <CourseStudents :course="course" :role="role" @changed="emit('changed')" />
        </el-tab-pane>
      </el-tabs>
      <CourseSessionTable v-else :sessions="sessions" :role="role" :now="now" />
    </section>
  </el-drawer>
</template>

<style scoped>
:global(.course-details .el-drawer__header) { margin-bottom: 0; padding: 24px; gap: 16px; }
:global(.course-details .el-drawer__title) { overflow-wrap: anywhere; line-height: 1.5; }
:global(.course-details .el-drawer__body) { padding: 0 24px 24px; min-width: 0; }
.detail-content { display: flex; flex-direction: column; gap: 24px; min-width: 0; }
.course-meta { margin: 0; color: var(--el-text-color-secondary); font-size: 13px; line-height: 1.8; overflow-wrap: anywhere; }
.course-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
.course-actions .el-button { margin: 0; min-height: 40px; max-width: 100%; white-space: normal; height: auto; }
.detail-tabs { width: 100%; min-width: 0; }
@media (max-width: 480px) {
  :global(.course-details .el-drawer__header) { padding: 20px 16px; }
  :global(.course-details .el-drawer__body) { padding: 0 16px 20px; }
  .course-actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .course-actions .el-button { width: 100%; padding: 10px 8px; }
}
</style>
