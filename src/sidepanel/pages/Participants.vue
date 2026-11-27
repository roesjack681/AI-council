<script setup lang="ts">
import { ref, watch } from 'vue';
import { NInput, NSelect, NButton, NForm, NFormItem, NAlert } from 'naive-ui';
import { platformCatalog } from '../../adapters/registry';
import type { Platform } from '../../protocols/domain';
import { useCouncilStore } from '../../stores/council.store';
import ModelCard from '../components/ModelCard.vue';
const council = useCouncilStore();
const platformOptions = [
  ...platformCatalog.map((p) => ({ label: p.name, value: p.id })),
  { label: '自定义（待适配）', value: 'custom' },
];
const platform = ref<Platform>('deepseek');
const participantName = ref('DeepSeek');
const websiteUrl = ref('https://chat.deepseek.com');
watch(platform, (next) => {
  const item = platformCatalog.find((p) => p.id === next);
  participantName.value = item?.name ?? '';
  websiteUrl.value = item?.url ?? '';
});
async function add() {
  await council.run({
    type: 'participant.add',
    input: {
      platform: platform.value,
      name: participantName.value,
      avatar: '',
      websiteUrl: websiteUrl.value,
      enabled: true,
    },
  });
}
</script>
<template>
  <p class="section-title">Council members</p>
  <h2>参与模型</h2>
  <p class="muted tagline">使用你已登录的网页账号。无需模型 API 或 API Key。</p>
  <n-alert type="info" title="通过已登录网页自动收发"
    >打开平台并登录，点击“检查能力”授予该网站访问权限。已确认的 DeepSeek
    空白新会话可直接启动首轮，读取和完成检测将在首条真实回复中验证；其他页面仍按实际匹配结果检测。不会读取密码或
    Cookie。</n-alert
  >
  <div class="card">
    <h3>添加参与者</h3>
    <n-form label-placement="top"
      ><n-form-item label="平台"
        ><n-select
          v-model:value="platform"
          :options="platformOptions"
          aria-label="平台" /></n-form-item
      ><n-form-item label="名称"
        ><n-input
          v-model:value="participantName"
          :input-props="{ 'aria-label': '参与者名称' }"
          placeholder="例如 DeepSeek 技术评审" /></n-form-item
      ><n-form-item label="网页地址"
        ><n-input
          v-model:value="websiteUrl"
          :input-props="{ 'aria-label': '网页地址' }"
          placeholder="https://" /></n-form-item
      ><n-button
        type="primary"
        :loading="council.busy"
        :disabled="!participantName.trim() || !websiteUrl.trim()"
        @click="add"
        >添加参与者</n-button
      ></n-form
    >
  </div>
  <ModelCard
    v-for="participant in council.snapshot.participants"
    :key="participant.id"
    :participant="participant"
  />
  <div v-if="!council.snapshot.participants.length" class="empty">
    先添加 DeepSeek 和豆包，检查各自的平台能力。
  </div>
</template>
