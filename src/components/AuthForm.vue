<script setup>
import { onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import api from '@/api.js'
import { setUser } from '@/auth.js'

const props = defineProps({
  mode: { type: String, required: true, validator: (value) => ['login', 'register'].includes(value) },
})

const router = useRouter()
const busy = ref(false)
const refreshing = ref(false)
const captchaImage = ref('')
const resetMode = ref(false)
const form = reactive({ number: '', name: '', username: '', password: '', confirmPassword: '', role: 'student', code: '' })
const isRegister = props.mode === 'register'

async function refreshCaptcha(force = false) {
  if (refreshing.value || (busy.value && !force)) return
  refreshing.value = true
  captchaImage.value = ''
  form.code = ''
  try {
    captchaImage.value = (await api('/captcha')).image
  } catch (error) {
    ElMessage.error(error.message)
  } finally {
    refreshing.value = false
  }
}

async function submit() {
  if (busy.value || refreshing.value || !captchaImage.value) return
  const username = form.username.trim()
  if (!username || (!resetMode.value && !form.password) || !form.code.trim()) {
    ElMessage.error('请输入账号、密码和验证码')
    return
  }
  if ((isRegister || resetMode.value) && (!form.number.trim() || !form.name.trim())) return ElMessage.error('请输入学号 / 工号和姓名')
  if (isRegister) {
    if (!/^[\p{L}\p{N}_-]{3,24}$/u.test(username)) {
      ElMessage.error('账号须为 3–24 位文字、数字、下划线或短横线')
      return
    }
    if (form.password.length < 8 || !/\d/.test(form.password) || !/[^0-9]/.test(form.password)) {
      ElMessage.error('密码须至少 8 位，并包含数字和非数字字符')
      return
    }
    if (form.password !== form.confirmPassword) {
      ElMessage.error('两次密码不一致！')
      return
    }
  }

  busy.value = true
  try {
    const result = await api(`/auth/${isRegister ? 'register' : resetMode.value ? 'reset-request' : 'login'}`, {
      method: 'POST',
      body: JSON.stringify({ username, password: form.password, code: form.code, role: form.role, name: form.name, number: form.number, [form.role === 'student' ? 'student_no' : 'teacher_no']: form.number }),
    })
    if (isRegister) {
      ElMessage.success(result.message)
      await router.replace('/login')
    } else if (resetMode.value) {
      ElMessage.success(result.message); resetMode.value = false; await refreshCaptcha(true)
    } else {
      setUser(result.user)
      ElMessage.success('登录成功！')
      await router.replace('/dashboard')
    }
  } catch (error) {
    ElMessage.error(error.message)
    await refreshCaptcha(true)
  } finally {
    busy.value = false
  }
}

onMounted(refreshCaptcha)
</script>

<template>
  <section class="auth-section">
    <div class="auth-container">
      <h2>{{ isRegister ? '用户注册' : resetMode ? '申请重置密码' : '用户登录' }}</h2>
        <el-form label-position="top" class="profile-form" @submit.prevent="submit">
          <el-form-item label="账号">
            <el-input v-model="form.username" :placeholder="isRegister ? '设置用户名' : '输入用户名'" size="large" clearable autocomplete="username" />
          </el-form-item>
          <el-form-item v-if="!resetMode" label="密码">
            <el-input v-model="form.password" type="password" show-password placeholder="请输入密码" size="large" clearable :autocomplete="isRegister ? 'new-password' : 'current-password'" />
          </el-form-item>
          <el-form-item v-if="isRegister" label="确认密码">
            <el-input v-model="form.confirmPassword" type="password" show-password placeholder="确认密码" size="large" clearable autocomplete="new-password" />
          </el-form-item>
          <el-form-item v-if="isRegister || resetMode" label="身份">
            <el-radio-group v-model="form.role" class="role-group">
              <el-radio-button value="teacher">教师</el-radio-button>
              <el-radio-button value="student">学生</el-radio-button>
            </el-radio-group>
          </el-form-item>
          <template v-if="isRegister || resetMode"><el-form-item :label="form.role === 'student' ? '学号' : '工号'" required><el-input v-model="form.number" maxlength="64" placeholder="请输入编号" /></el-form-item><el-form-item label="姓名" required><el-input v-model="form.name" maxlength="80" placeholder="请输入真实姓名" /></el-form-item></template>
          <el-alert v-if="resetMode" title="提交后需等待管理员重置密码" type="warning" :closable="false" />
          <el-form-item label="验证码">
            <div class="captcha-group">
              <el-input v-model="form.code" maxlength="5" placeholder="输入图中字符" aria-label="验证码" size="large" :disabled="busy || refreshing" autocomplete="off" />
              <div class="captcha-art">
                <img v-if="captchaImage" :src="captchaImage" alt="登录注册验证码" />
                <span v-else>正在加载验证码…</span>
                <el-button link class="captcha-refresh" :loading="refreshing" :disabled="busy" @click="refreshCaptcha()">刷新验证码</el-button>
              </div>
            </div>
          </el-form-item>
        <div class="button-group">
          <el-button class="auth-submit" type="primary" native-type="submit" :loading="busy">{{ isRegister ? '注册' : resetMode ? '提交重置申请' : '登录' }}</el-button>
          <el-button class="auth-switch" @click="router.push(isRegister ? '/login' : '/register')">{{ isRegister ? '返回登录界面' : '没有账号？去注册' }}</el-button>
          <el-button v-if="!isRegister" class="auth-switch" :disabled="busy" @click="resetMode = !resetMode; refreshCaptcha()">{{ resetMode ? '返回登录' : '忘记密码？申请重置' }}</el-button>
        </div>
        </el-form>
    </div>
  </section>
</template>
