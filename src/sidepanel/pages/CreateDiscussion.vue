<script setup lang="ts">
import { ref, computed } from 'vue';
import { NForm, NFormItem, NInput, NInputNumber, NSelect, NCheckbox, NButton } from 'naive-ui';
import { useCouncilStore } from '../../stores/council.store';
const store = useCouncilStore();
const title = ref('');
const question = ref('');
const context = ref('');
const constraints = ref('');
const expected = ref('');
const participantIds = ref<string[]>([]);
const maxRounds = ref(10);
const stable = ref(2);
const timeout = ref(180);
const retries = ref(2);
const privacy = ref(false);
const options = computed(() =>
  store.snapshot.participants
    .filter((p) => p.enabled)
    .map((p) => ({ label: `${p.name} · ${p.status}`, value: p.id })),
);
async function create(start = false) {
  if (!privacy.value) return;
  await store.run({
    type: 'discussion.create',
    input: {
      title: title.value,
      originalQuestion: question.value,
      context: context.value,
      constraints: constraints.value
        .split('\n')
        .map((v) => v.trim())
        .filter(Boolean),
      expectedOutput: expected.value,
      participantIds: participantIds.value,
      maxRounds: maxRounds.value,
      stableRoundsRequired: stable.value,
      timeoutMs: timeout.value * 1000,
      maxRetries: retries.value,
      privacyAcknowledged: true,
    },
  });
  if (start && !store.error) {
    await store.run({ type: 'discussion.start', id: store.selectedId });
    store.page = 'chat';
  }
}
</script>
<template>
  <div class="card">
    <h3>创建讨论任务</h3>
    <n-form label-placement="top"
      ><n-form-item label="任务标题"
        ><n-input
          v-model:value="title"
          :input-props="{ 'aria-label': '任务标题' }"
          placeholder="给本次讨论起一个名字" /></n-form-item
      ><n-form-item label="原始问题"
        ><n-input
          v-model:value="question"
          type="textarea"
          :autosize="{ minRows: 3, maxRows: 8 }"
          :input-props="{ 'aria-label': '原始问题' }"
          placeholder="描述你需要解决的问题；创建后原始问题保持不变" /></n-form-item
      ><n-form-item label="参与模型（至少两个）"
        ><n-select
          v-model:value="participantIds"
          multiple
          :options="options"
          aria-label="参与模型选择"
      /></n-form-item>
      <details>
        <summary>背景、约束与运行设置</summary>
        <n-form-item label="已知条件"
          ><n-input
            v-model:value="context"
            type="textarea"
            :input-props="{ 'aria-label': '已知条件' }" /></n-form-item
        ><n-form-item label="必须遵守的约束（每行一项）"
          ><n-input
            v-model:value="constraints"
            type="textarea"
            :input-props="{ 'aria-label': '约束' }" /></n-form-item
        ><n-form-item label="期望结果"
          ><n-input v-model:value="expected" :input-props="{ 'aria-label': '期望结果' }"
        /></n-form-item>
        <div class="grid">
          <n-form-item label="最大轮数"
            ><n-input-number
              v-model:value="maxRounds"
              :min="2"
              :max="100"
              :precision="0"
              :show-button="false"
              :input-props="{ 'aria-label': '最大轮数' }" /></n-form-item
          ><n-form-item label="稳定共识轮数"
            ><n-input-number
              v-model:value="stable"
              :min="2"
              :max="10"
              :precision="0"
              :show-button="false"
              :input-props="{ 'aria-label': '稳定共识轮数' }" /></n-form-item
          ><n-form-item label="回答超时（秒）"
            ><n-input-number
              v-model:value="timeout"
              :min="1"
              :max="3600"
              :precision="0"
              :show-button="false"
              :input-props="{ 'aria-label': '超时秒数' }" /></n-form-item
          ><n-form-item label="最大重试次数"
            ><n-input-number
              v-model:value="retries"
              :min="0"
              :max="5"
              :precision="0"
              :show-button="false"
              :input-props="{ 'aria-label': '最大重试次数' }"
          /></n-form-item>
        </div>
      </details>
      <p class="muted">
        启动后，原始问题、约束和讨论上下文会通过网页发送给所选的第三方模型。请勿包含不适合共享的隐私或机密数据。
      </p>
      <n-checkbox v-model:checked="privacy">我已了解上下文向参与平台共享的范围</n-checkbox>
      <p class="row">
        <n-button
          type="primary"
          secondary
          :loading="store.busy"
          :disabled="!title.trim() || !question.trim() || participantIds.length < 2 || !privacy"
          @click="create(false)"
          >保存任务</n-button
        ><n-button
          type="primary"
          :loading="store.busy"
          :disabled="!title.trim() || !question.trim() || participantIds.length < 2 || !privacy"
          @click="create(true)"
          >保存并启动</n-button
        >
      </p></n-form
    >
  </div>
</template>
