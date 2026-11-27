<script setup lang="ts">
import { NButton, NPopconfirm } from 'naive-ui';
import { useCouncilStore } from '../../stores/council.store';
import { terminal } from '../../core/task-manager';
const store = useCouncilStore();
</script>
<template>
  <div v-if="store.selected" class="card">
    <div class="row spread">
      <h3>{{ store.selected.title }}</h3>
      <span class="pill">{{ store.selected.status }}</span>
    </div>
    <p class="muted">
      第 {{ store.selected.currentRound }} / {{ store.selected.maxRounds }} 轮 · 连续无进展
      {{ store.selected.noProgressRounds }} 轮
    </p>
    <progress :value="store.selected.currentRound" :max="store.selected.maxRounds" />
    <p v-if="store.selected.reason" class="reason">{{ store.selected.reason }}</p>
    <p v-if="store.selected.reasonDetail" class="reason">{{ store.selected.reasonDetail }}</p>
    <div class="row">
      <n-button
        v-if="['CREATED', 'PAUSED'].includes(store.selected.status)"
        type="primary"
        size="small"
        :loading="store.busy"
        @click="store.run({ type: 'discussion.start', id: store.selected.id })"
        >{{ store.selected.status === 'PAUSED' ? '重新检查并恢复' : '检查能力并启动' }}</n-button
      ><n-button
        v-if="!terminal(store.selected.status) && store.selected.status !== 'PAUSED'"
        size="small"
        :disabled="store.busy"
        @click="store.run({ type: 'discussion.pause', id: store.selected.id })"
        >暂停</n-button
      ><n-popconfirm
        v-if="!terminal(store.selected.status)"
        @positive-click="store.run({ type: 'discussion.stop', id: store.selected!.id })"
        ><template #trigger
          ><n-button type="error" secondary size="small" :disabled="store.busy"
            >终止</n-button
          ></template
        >终止任务并生成未达成共识报告？</n-popconfirm
      ><n-popconfirm
        v-if="
          terminal(store.selected.status) || ['CREATED', 'PAUSED'].includes(store.selected.status)
        "
        @positive-click="store.run({ type: 'discussion.delete', id: store.selected!.id })"
        ><template #trigger
          ><n-button text type="error" size="small" :disabled="store.busy"
            >删除任务</n-button
          ></template
        >永久删除该任务及其消息、证据、报告？</n-popconfirm
      >
    </div>
  </div>
</template>
