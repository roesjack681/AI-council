<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue';
import { NConfigProvider, NAlert, NButton, NPopconfirm, zhCN } from 'naive-ui';
import { useCouncilStore } from '../stores/council.store';
import { extensionMode } from '../services/client';
import Chat from './pages/Chat.vue';
import Settings from './pages/Settings.vue';

const store = useCouncilStore();
const themeOverrides = {
  common: {
    primaryColor: '#1f6b4a',
    primaryColorHover: '#31825f',
    borderRadius: '10px',
    fontFamily:
      '"Segoe UI Variable Text", "Segoe UI", "PingFang SC", "Microsoft YaHei UI", sans-serif',
    fontFamilyMono: 'Consolas, "Sarasa Mono SC", monospace',
  },
};
let timer: ReturnType<typeof setInterval> | undefined;
onMounted(async () => {
  try {
    await store.refresh();
  } catch (e) {
    store.error = String(e);
  }
  timer = setInterval(() => {
    if (!store.busy)
      void store.poll().catch((e) => {
        store.error = String(e);
      });
  }, 3000);
});
onUnmounted(() => {
  if (timer) clearInterval(timer);
});
</script>
<template>
  <n-config-provider :locale="zhCN" :theme-overrides="themeOverrides">
    <header>
      <div class="brand-mark">C</div>
      <div>
        <h1>AI Council</h1>
        <p>多模型聊天室 · 本地核对</p>
      </div>
      <span class="local-badge">本地存储</span>
      <n-button
        class="settings-btn"
        size="tiny"
        quaternary
        :type="store.page === 'settings' ? 'primary' : 'default'"
        :aria-label="store.page === 'settings' ? '切换到聊天' : '打开设置'"
        @click="store.page = store.page === 'settings' ? 'chat' : 'settings'"
        >{{ store.page === 'settings' ? '聊天' : '设置' }}</n-button
      >
    </header>
    <main :class="{ 'main-chat': store.page === 'chat' }">
      <n-alert v-if="!extensionMode" type="info" title="界面预览"
        >当前为本地网页预览，数据与已安装扩展隔离；没有标签页检测和后台无人值守调度能力。</n-alert
      >
      <n-alert
        v-if="store.error"
        type="error"
        title="操作未完成"
        closable
        @close="store.error = ''"
        >{{ store.error }}</n-alert
      >
      <Chat v-if="store.page === 'chat'" />
      <Settings v-else />
      <footer>
        <span>AI Council 0.3.5 · 数据仅保存在当前浏览器</span>
        <n-popconfirm
          @positive-click="store.run({ type: 'data.clear', confirm: 'DELETE_LOCAL_DATA' })"
        >
          <template #trigger>
            <n-button text size="tiny" type="error">清除讨论数据</n-button>
          </template>
          清除任务、消息、证据、报告与网页会话记录？模型配置（名字、头像、平台）会保留。
        </n-popconfirm>
      </footer>
    </main>
  </n-config-provider>
</template>
