<script setup>
import { dateKey, formatTime } from '@/dashboard.js'
defineProps({ sessions: Array, role: String, now: Number })
const emit = defineEmits(['edit'])
</script>

<template>
  <el-table :data="sessions" empty-text="暂未设置课次">
    <el-table-column label="日期" width="115">
      <template #default="{ row }">{{ dateKey(row.start_at) }}</template>
    </el-table-column>
    <el-table-column label="时间" width="125">
      <template #default="{ row }">{{ formatTime(row.start_at) }}–{{ formatTime(row.end_at) }}</template>
    </el-table-column>
    <el-table-column prop="location" label="地点" min-width="100" />
    <el-table-column label="调课说明" min-width="170">
      <template #default="{ row }">
        <template v-if="row.change_reason">
          {{ row.change_reason }}<br>
          原安排：{{ dateKey(row.original_start) }} {{ formatTime(row.original_start) }}
        </template>
        <span v-else>—</span>
      </template>
    </el-table-column>
    <el-table-column v-if="role !== 'student'" label="操作" width="80" fixed="right">
      <template #default="{ row }">
        <el-button link type="primary" :disabled="Date.parse(row.start_at) <= now" @click="emit('edit', row)">
          调课
        </el-button>
      </template>
    </el-table-column>
  </el-table>
</template>
