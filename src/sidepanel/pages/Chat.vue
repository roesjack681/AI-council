<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { NButton, NInput } from 'naive-ui';
import { useCouncilStore } from '../../stores/council.store';
import type { ConsensusPosition, DiscussionMessage, Participant } from '../../protocols/domain';
import RoomAvatar from '../components/RoomAvatar.vue';
import ReportDialog from '../components/ReportDialog.vue';

const store = useCouncilStore();
const draft = ref('');
const detailOpen = ref(false);
const detailMarkdown = ref('');
const timelineEl = ref<HTMLElement | null>(null);
/** When false, message updates must not move the feed (user is reading history). */
const stickFeedToBottom = ref(true);

const positionLabel: Record<ConsensusPosition, string> = {
  AGREE: '同意',
  CONDITIONAL: '有条件同意',
  DISAGREE: '不同意',
  UNCERTAIN: '不确定',
  ABSTAIN: '弃权',
};

const discussions = computed(() =>
  [...store.snapshot.discussions].sort(
    (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id),
  ),
);

const roomMembers = computed(() => {
  const d = store.selected;
  // Brain is router-only and never appears as a chat-room speaker.
  const ids = d
    ? d.participantIds
    : store.snapshot.participants
        .filter((p) => p.enabled && (p.role ?? 'council') !== 'brain')
        .map((p) => p.id);
  return ids.map((id) => memberOf(id));
});

const orphanNotices = computed(() =>
  [...(store.snapshot.chatNotices ?? [])]
    .filter((n) => !n.discussionId && n.type === 'readiness')
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)),
);

const pendingOutgoing = computed(() =>
  [...(store.snapshot.brainRequests ?? [])]
    .filter((job) => !['done', 'cancelled'].includes(job.phase) && !job.discussionId)
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)),
);

const statusText = computed(() => {
  const paused = store.pausedBrainRequests[0];
  if (paused) return paused.error?.detail || '上一条发送需要处理，可点恢复';
  if (store.activeBrainRequest)
    return store.activeBrainRequest.phase === 'pending'
      ? '问题已保存，准备路由…'
      : store.activeBrainRequest.phase === 'routing'
        ? '正在应用路由结果…'
        : '正在等待大脑回复…';
  const d = store.selected;
  if (!d) {
    if (!store.privacyAcknowledged) return '请先在设置中确认隐私提示';
    if (!store.brainParticipant && store.readyParticipants.length < 2)
      return '可点名向成员提问；共识讨论需要两个就绪成员';
    return '可以说点什么';
  }
  if (d.status === 'COMPLETED') return d.mode === 'direct' ? '已回复' : '已达成讨论共识';
  if (d.status === 'FINALIZING') return '正在整理…';
  if (d.status === 'INITIALIZING') return '正在自动打开、检查并准备模型网页…';
  if (d.status === 'PAUSED') return `已暂停：${d.reason ?? '未知原因'}`;
  if (d.status === 'UNRESOLVED') return `未解决：${d.reason ?? ''}`;
  if (d.status === 'FAILED') return `失败：${d.reason ?? ''}`;
  if (d.status === 'CREATED') return '已创建，待启动';
  return '成员回复中…';
});

function hasReport(discussionId: string): boolean {
  return store.snapshot.reports.some((r) => r.discussionId === discussionId);
}

function memberOf(id: string): Pick<Participant, 'id' | 'name' | 'avatar' | 'platform' | 'role'> {
  const live = store.snapshot.participants.find((p) => p.id === id);
  if (live)
    return {
      id: live.id,
      name: live.name,
      avatar: live.avatar || '',
      platform: live.platform,
      role: live.role ?? 'council',
    };
  const snap = store.snapshot.discussions
    .flatMap((d) => d.participantSnapshots ?? [])
    .find((p) => p.id === id);
  return {
    id,
    name: snap?.name ?? id,
    avatar: '',
    platform: snap?.platform ?? 'custom',
    role: 'council',
  };
}

function briefOf(message: DiscussionMessage): string {
  const data = message.structuredData;
  if (data?.brief?.trim()) return data.brief.trim();
  const reasons = data?.positions?.map((p) => p.reason.trim()).filter(Boolean) ?? [];
  if (reasons.length) {
    const joined = reasons.join('；');
    return joined.length > 280 ? `${joined.slice(0, 277)}…` : joined;
  }
  const content = (data?.content ?? message.content).trim();
  return content.length > 280 ? `${content.slice(0, 277)}…` : content || '（无简短摘要）';
}

function stanceChips(message: DiscussionMessage): ConsensusPosition[] {
  const positions = message.structuredData?.positions ?? [];
  const order: ConsensusPosition[] = ['DISAGREE', 'CONDITIONAL', 'UNCERTAIN', 'ABSTAIN', 'AGREE'];
  const set = new Set(positions.map((p) => p.position));
  if (!set.size && message.type === 'AGREEMENT') set.add('AGREE');
  if (!set.size && message.type === 'DISAGREEMENT') set.add('DISAGREE');
  return order.filter((p) => set.has(p));
}

function inboundFor(discussionId: string): DiscussionMessage[] {
  return store.snapshot.messages
    .filter(
      (m) =>
        m.discussionId === discussionId &&
        m.direction === 'inbound' &&
        (m.parseStatus === 'valid' ||
          m.parseStatus === 'PARSE_FAILED' ||
          m.parseStatus === 'not_applicable'),
    )
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

function lastValidInbound(discussionId: string): DiscussionMessage | undefined {
  return [...inboundFor(discussionId)]
    .reverse()
    .find((m) => m.parseStatus === 'valid' || m.parseStatus === 'not_applicable');
}

function nearBottom(el: HTMLElement, slack = 48): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= slack;
}

function onTimelineScroll(): void {
  const el = timelineEl.value;
  if (!el) return;
  stickFeedToBottom.value = nearBottom(el);
}

function scrollTimelineToBottom(): void {
  const el = timelineEl.value;
  if (!el) return;
  stickFeedToBottom.value = true;
  el.scrollTop = el.scrollHeight;
}

async function send() {
  const text = draft.value;
  if (!text.trim() || !store.canAsk) return;
  await store.ask(text);
  if (!store.error) draft.value = '';
  await nextTick();
  scrollTimelineToBottom();
}

async function openDetails(discussionId: string) {
  detailMarkdown.value = '加载中…';
  detailOpen.value = true;
  await store.run({ type: 'report.generate', id: discussionId });
  if (store.error) {
    detailMarkdown.value = store.error;
    return;
  }
  const latest = store.snapshot.reports
    .filter((r) => r.discussionId === discussionId)
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  detailMarkdown.value = latest?.markdown ?? '暂无报告内容。';
}

watch(
  () => [
    store.snapshot.messages.length,
    store.snapshot.chatNotices?.length ?? 0,
    store.snapshot.discussions.length,
  ],
  async () => {
    if (!stickFeedToBottom.value) return;
    await nextTick();
    if (stickFeedToBottom.value) scrollTimelineToBottom();
  },
);
</script>
<template>
  <div class="chat-layout room">
    <div class="room-header">
      <div class="room-members" aria-label="聊天室成员">
        <div class="room-member">
          <RoomAvatar name="我" avatar="🙂" size="sm" />
          <span>我</span>
        </div>
        <div v-for="m in roomMembers" :key="m.id" class="room-member">
          <RoomAvatar :name="m.name" :avatar="m.avatar" size="sm" />
          <span>{{ m.name }}</span>
        </div>
      </div>
      <div class="chat-status room-status">
        <span>{{ statusText }}</span>
        <div class="row">
          <n-button
            v-if="store.activeBrainRequest || store.pausedBrainRequests[0]"
            size="tiny"
            :disabled="store.busy"
            @click="
              store.run({
                type: 'brain.cancel',
                id: (store.activeBrainRequest ?? store.pausedBrainRequests[0])!.id,
              })
            "
            >取消路由</n-button
          >
          <n-button
            v-if="store.pausedBrainRequests[0]"
            size="tiny"
            type="primary"
            :loading="store.busy"
            @click="store.run({ type: 'brain.resume', id: store.pausedBrainRequests[0]!.id })"
            >重试</n-button
          >
          <n-button
            v-if="
              !store.activeBrainRequest &&
              (store.selected?.status === 'PAUSED' || store.selected?.status === 'CREATED')
            "
            size="tiny"
            type="primary"
            :loading="store.busy"
            @click="store.resumeSelected()"
            >{{ store.selected?.status === 'PAUSED' ? '重新检查并恢复' : '启动' }}</n-button
          >
          <n-button
            v-if="
              store.selected &&
              !['COMPLETED', 'UNRESOLVED', 'FAILED', 'CREATED', 'PAUSED'].includes(
                store.selected.status,
              )
            "
            size="tiny"
            :disabled="store.busy"
            @click="store.run({ type: 'discussion.pause', id: store.selected.id })"
            >暂停</n-button
          >
        </div>
      </div>
    </div>

    <div ref="timelineEl" class="chat-timeline room-feed" @scroll.passive="onTimelineScroll">
      <div
        v-if="!discussions.length && !orphanNotices.length && !pendingOutgoing.length"
        class="empty chat-empty"
      >
        在下方输入，发给聊天室成员。
      </div>

      <section v-for="notice in orphanNotices" :key="notice.id" class="chat-thread">
        <div class="room-divider"><span>就绪检查</span></div>
        <div class="room-row room-row-system">
          <div class="room-avatar-slot">
            <RoomAvatar name="系统" avatar="📋" />
          </div>
          <div class="room-col">
            <div class="room-name-row">
              <span class="room-name">系统</span>
            </div>
            <div class="room-bubble">
              <p class="brief pre">{{ notice.body }}</p>
            </div>
          </div>
        </div>
      </section>

      <section v-for="job in pendingOutgoing" :key="job.id" class="chat-thread">
        <div class="room-row room-row-self">
          <div class="room-avatar-slot">
            <RoomAvatar name="我" avatar="🙂" />
          </div>
          <div class="room-col">
            <div class="room-name-row">
              <span class="room-name">我</span>
            </div>
            <div class="room-bubble room-bubble-self">
              <p class="pre">{{ job.question }}</p>
            </div>
          </div>
        </div>
      </section>

      <section v-for="d in discussions" :key="d.id" class="chat-thread">
        <div class="room-row room-row-self">
          <div class="room-avatar-slot">
            <RoomAvatar name="我" avatar="🙂" />
          </div>
          <div class="room-col">
            <div class="room-name-row">
              <span class="room-name">我</span>
            </div>
            <div class="room-bubble room-bubble-self">
              <p class="pre">{{ d.originalQuestion }}</p>
            </div>
          </div>
        </div>

        <div
          v-for="message in inboundFor(d.id)"
          :key="message.id"
          class="room-row"
          :class="{ 'room-row-failed': message.parseStatus === 'PARSE_FAILED' }"
        >
          <div class="room-avatar-slot">
            <RoomAvatar
              :name="memberOf(message.participantId).name"
              :avatar="memberOf(message.participantId).avatar"
            />
          </div>
          <div class="room-col">
            <div class="room-name-row">
              <span class="room-name">{{ memberOf(message.participantId).name }}</span>
              <span v-for="pos in stanceChips(message)" :key="pos" class="stance" :data-pos="pos">{{
                positionLabel[pos]
              }}</span>
              <span
                v-if="!stanceChips(message).length && message.parseStatus === 'PARSE_FAILED'"
                class="stance"
                data-pos="UNCERTAIN"
                >解析失败</span
              >
            </div>
            <div class="room-bubble">
              <p class="brief">
                {{
                  message.parseStatus === 'PARSE_FAILED'
                    ? `${message.parseError?.detail ?? '回复未通过协议校验'}。${d.status === 'PAUSED' ? '任务已暂停，原文已保留。' : '系统将按重试上限尝试修复。'}`
                    : briefOf(message)
                }}
              </p>
            </div>
          </div>
        </div>

        <div
          v-if="
            lastValidInbound(d.id) &&
            (d.status === 'COMPLETED' || d.status === 'UNRESOLVED' || hasReport(d.id))
          "
          class="detail-cta"
        >
          <n-button size="tiny" quaternary type="primary" @click="openDetails(d.id)"
            >查看详情</n-button
          >
        </div>
        <p v-else-if="d.status === 'UNRESOLVED' || d.status === 'FAILED'" class="reason thread-end">
          {{ d.reason }}{{ d.reasonDetail ? ` · ${d.reasonDetail}` : '' }}
        </p>
      </section>
    </div>

    <p
      v-if="
        (store.snapshot.recoveredDrafts ?? []).some(
          (draft) => draft.discussionId === store.selectedId && draft.phase === 'cleared',
        )
      "
      class="muted"
    >
      旧网页草稿已保留在设置中，本题使用本次问题继续。
    </p>
    <form class="chat-composer" @submit.prevent="send">
      <n-input
        v-model:value="draft"
        type="textarea"
        :rows="3"
        :disabled="!store.canAsk"
        :placeholder="
          store.activeBrainRequest || store.hasRunningDiscussion
            ? '可以发送新问题，上一题会暂停并保留记录…'
            : store.canAsk
              ? '发消息…'
              : '请先在右上角设置中准备成员并确认隐私'
        "
        :input-props="{ 'aria-label': '提问' }"
        @keydown.enter.exact.prevent="send"
      />
      <n-button
        type="primary"
        attr-type="submit"
        :loading="store.busy"
        :disabled="!draft.trim() || !store.canAsk"
        >发送</n-button
      >
    </form>
  </div>

  <ReportDialog v-model:show="detailOpen" :markdown="detailMarkdown" />
</template>
