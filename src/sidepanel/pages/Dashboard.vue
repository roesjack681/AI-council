<script setup lang="ts">
import { NAlert, NButton } from 'naive-ui';
import { useCouncilStore } from '../../stores/council.store';
import CreateDiscussion from './CreateDiscussion.vue';
import TaskControls from '../components/TaskControls.vue';
const store = useCouncilStore();
</script>
<template>
  <p class="section-title">Local collaboration</p>
  <h2>让观点接受交叉审查</h2>
  <p class="muted tagline">保存问题、追踪争议，依据明确规则判断共识。</p>
  <div class="grid">
    <div class="stat">
      <b>{{ store.snapshot.discussions.length }}</b
      ><span>本地讨论任务</span>
    </div>
    <div class="stat">
      <b>{{ store.snapshot.participants.length }}</b
      ><span>已配置参与模型</span>
    </div>
    <div class="stat">
      <b>{{ store.snapshot.participants.filter((p) => p.capabilities.unattendedAllowed).length }}</b
      ><span>无人值守可用</span>
    </div>
  </div>
  <n-alert type="info" title="网页自动讨论"
    >先在“参与模型”完成网站授权与页面检查，再选择至少两个页面就绪的模型。系统会创建独立讨论标签页并自动交接；网页退出登录、验证码或结构不匹配时会暂停并保留记录。</n-alert
  ><n-button
    v-if="store.snapshot.participants.length < 2"
    secondary
    @click="store.page = 'settings'"
    >先配置 DeepSeek 和豆包</n-button
  ><TaskControls /><CreateDiscussion />
  <div v-if="store.snapshot.discussions.length" class="card">
    <h3>历史任务</h3>
    <div
      v-for="task in [...store.snapshot.discussions].sort((a, b) => b.createdAt - a.createdAt)"
      :key="task.id"
      class="row spread status-line"
    >
      <n-button
        text
        @click="
          store.selectedId = task.id;
          store.page = 'chat';
        "
        >{{ task.title }}</n-button
      ><span class="pill">{{ task.status }}</span>
    </div>
  </div>
  <details class="card">
    <summary>操作日志（最近 200 条）</summary>
    <div v-for="entry in store.snapshot.logs" :key="entry.id" class="mono">
      {{ new Date(entry.createdAt).toLocaleTimeString() }} · {{ entry.level }} · {{ entry.code }} ·
      {{ entry.detail }}
    </div>
    <p v-if="!store.snapshot.logs.length" class="muted">尚无操作日志。</p>
  </details>
</template>
