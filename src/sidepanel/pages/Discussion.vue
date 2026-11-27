<script setup lang="ts">
import { computed, ref } from 'vue';
import { NCheckbox } from 'naive-ui';
import { useCouncilStore } from '../../stores/council.store';
import TaskControls from '../components/TaskControls.vue';
const store = useCouncilStore();
const showPrompts = ref(false);
const messages = computed(() =>
  store.snapshot.messages
    .filter(
      (m) =>
        m.discussionId === store.selectedId && (showPrompts.value || m.direction === 'inbound'),
    )
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)),
);
const rounds = computed(() =>
  store.snapshot.rounds
    .filter((r) => r.discussionId === store.selectedId)
    .sort((a, b) => a.roundNumber - b.roundNumber),
);
const consensus = computed(
  () =>
    store.snapshot.consensusRecords
      .filter((r) => r.discussionId === store.selectedId)
      .sort((a, b) => b.roundNumber - a.roundNumber)[0],
);
</script>
<template>
  <p class="section-title">Discussion timeline</p>
  <h2>实时讨论</h2>
  <div v-if="!store.selected" class="empty">在工作台创建或选择一个讨论任务。</div>
  <template v-else
    ><TaskControls />
    <div class="card">
      <h3>锁定的原始问题</h3>
      <p class="pre">{{ store.selected.originalQuestion }}</p>
      <p class="muted">
        背景：{{ store.selected.context || '未填写' }}<br />约束：{{
          store.selected.constraints.join('；') || '未填写'
        }}
      </p>
    </div>
    <div v-if="consensus" class="card">
      <h3>共识检查 · 第 {{ consensus.roundNumber }} 轮</h3>
      <p>
        完整共识：{{ consensus.reached ? '已达成' : '未达成' }} · 稳定
        {{ consensus.stableRounds }} 轮
      </p>
      <p v-for="reason in consensus.reasons" :key="reason" class="muted">{{ reason }}</p>
    </div>
    <div class="card">
      <div class="row spread">
        <h3>消息时间线</h3>
        <n-checkbox v-model:checked="showPrompts">显示发送队列</n-checkbox>
      </div>
      <div v-if="!messages.length" class="empty">
        尚无模型回复。运行中的任务会在收到并验证真实回复后更新；暂停任务请查看上方原因。
      </div>
      <article v-for="message in messages" :key="message.id" class="message">
        <div class="row spread">
          <b>{{
            store.snapshot.participants.find((p) => p.id === message.participantId)?.name ??
            message.participantId
          }}</b
          ><span class="pill">{{ message.type }} · {{ message.status }}</span>
        </div>
        <p class="pre">{{ message.structuredData?.content ?? message.content }}</p>
        <details>
          <summary>原始记录与关联</summary>
          <p class="mono">
            消息 {{ message.id }}<br />轮次 {{ message.roundId }}<br />关联请求
            {{ message.replyTo ?? '无' }}<br />解析 {{ message.parseStatus }}
          </p>
          <p class="pre">{{ message.content }}</p>
        </details>
      </article>
    </div>
    <details v-for="round in rounds" :key="round.id" class="card">
      <summary>第 {{ round.roundNumber }} 轮 · {{ round.kind }} · {{ round.status }}</summary>
      <p class="pre">{{ round.summary || '本轮进行中' }}</p>
    </details>
    <details class="card">
      <summary>专用会话准备诊断</summary>
      <p
        v-for="session in store.snapshot.browserSessions.filter(
          (s) => s.discussionId === store.selectedId,
        )"
        :key="session.id"
        class="mono"
      >
        {{
          store.snapshot.participants.find((p) => p.id === session.participantId)?.name ??
          session.participantId
        }}
        · 标签 {{ session.tabId }} · {{ session.preparation?.phase ?? '尚未记录' }}<br />
        输入框：{{ session.preparation?.editorFound ?? '未知' }} · 输入为空：{{
          session.preparation?.editorEmpty ?? '未知'
        }}
        · 用户消息：{{ session.preparation?.userCount ?? '未知' }} · 模型回复：{{
          session.preparation?.outputCount ?? '未知'
        }}<br />
        {{ session.preparation?.reason ?? '旧版本记录；下一次准备时更新' }}
      </p>
    </details>
    <details class="card">
      <summary>持久化消息队列</summary>
      <p
        v-for="task in store.snapshot.queue.filter((q) => q.discussionId === store.selectedId)"
        :key="task.id"
        class="mono"
      >
        {{
          store.snapshot.participants.find((p) => p.id === task.participantId)?.name ??
          task.participantId
        }}
        · {{ task.taskType }} · {{ task.status }} · 重试 {{ task.retryCount }} ·
        {{ task.lastError ?? '' }}
        <template v-if="task.status === 'sending'">
          · 只读发送核对 {{ task.confirmationAttempts ?? 0 }}/5（不会直接重发）</template
        >
      </p>
    </details></template
  >
</template>
