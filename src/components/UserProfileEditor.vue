<script setup>
import { reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import api from '@/api.js'

const props = defineProps({ person: Object })
const emit = defineEmits(['close', 'saved'])
const busy = ref(false)
const form = reactive({ number: '', name: '', class_name: '' })
watch(() => props.person, person => {
  if (person) Object.assign(form, {
    number: person.number, name: person.name, class_name: person.class_name || '',
  })
})

async function save() {
  if (busy.value || !props.person) return
  busy.value = true
  try {
    const person = props.person
    const body = { name: form.name }
    if (person.type === 'students') body.class_name = form.class_name
    if (person.number_conflict) {
      body[person.type === 'students' ? 'student_no' : 'teacher_no'] = form.number
    }
    await api(`/${person.type}/${person.id}`, { method: 'PATCH', body: JSON.stringify(body) })
    ElMessage.success('资料已更新')
    emit('saved')
  } catch (error) { ElMessage.error(error.message) } finally { busy.value = false }
}
</script>

<template>
  <el-dialog
    :model-value="!!person" title="修改用户资料"
    width="min(480px, 94vw)" :close-on-click-modal="!busy"
    :close-on-press-escape="!busy" :show-close="!busy" @close="emit('close')"
  >
    <el-form label-position="top" @submit.prevent="save">
      <el-form-item :label="person?.number_conflict ? '修正重复学号 / 工号' : '学号 / 工号'">
        <el-input v-model="form.number" :disabled="!person?.number_conflict || busy" maxlength="64" />
      </el-form-item>
      <el-form-item label="姓名"><el-input v-model="form.name" maxlength="80" :disabled="busy" /></el-form-item>
      <el-form-item v-if="person?.type === 'students'" label="班级">
        <el-input v-model="form.class_name" maxlength="100" :disabled="busy" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button type="primary" :loading="busy" @click="save">保存资料</el-button>
    </template>
  </el-dialog>
</template>
