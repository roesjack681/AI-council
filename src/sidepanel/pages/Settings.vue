<script setup lang="ts">
import { ref, watch } from 'vue';
import { NInput, NSelect, NButton, NForm, NFormItem, NAlert, NCheckbox } from 'naive-ui';
import { platformCatalog } from '../../adapters/registry';
import type { Platform, VerificationPolicy } from '../../protocols/domain';
import { useCouncilStore } from '../../stores/council.store';
import ModelCard from '../components/ModelCard.vue';
import RoomAvatar from '../components/RoomAvatar.vue';
import Objections from './Objections.vue';
import TaskControls from '../components/TaskControls.vue';
import { requestModelSiteAccess } from '../../services/site-access';

const council = useCouncilStore();
const verificationOptions: { label: string; value: VerificationPolicy }[] = [
  { label: '讨论共识（单独标示未核实事实）', value: 'discussion_only' },
  { label: '独立证据（关键事实未核实则不通过）', value: 'independent_evidence' },
];
const platformOptions = [
  ...platformCatalog.map((p) => ({ label: p.name, value: p.id })),
  { label: '自定义（待适配）', value: 'custom' },
];
const defaults: Record<Platform, { name: string; avatar: string; url: string }> = {
  deepseek: { name: 'DeepSeek', avatar: '🌊', url: 'https://chat.deepseek.com' },
  doubao: { name: '豆包', avatar: '🌱', url: 'https://www.doubao.com/chat/' },
  chatgpt: { name: 'ChatGPT', avatar: '💬', url: 'https://chatgpt.com' },
  gemini: { name: 'Gemini', avatar: '✨', url: 'https://gemini.google.com' },
  claude: { name: 'Claude', avatar: '🟠', url: 'https://claude.ai' },
  custom: { name: '', avatar: '🤖', url: '' },
};
const platform = ref<Platform>('deepseek');
const participantName = ref(defaults.deepseek.name);
const avatar = ref(defaults.deepseek.avatar);
const websiteUrl = ref(defaults.deepseek.url);
const avatarPresets = ['🌊', '🌱', '💬', '✨', '🟠', '🤖', '🧠', '🦊', '🐱', '🦉', '🐲', '⚡'];

watch(platform, (next) => {
  const item = platformCatalog.find((p) => p.id === next);
  const preset = defaults[next];
  participantName.value = item?.name ?? preset.name;
  websiteUrl.value = item?.url ?? preset.url;
  avatar.value = preset.avatar;
});

async function add() {
  try {
    if (
      !(await requestModelSiteAccess([{ platform: platform.value, websiteUrl: websiteUrl.value }]))
    ) {
      council.error = '需要首次允许网站访问权限，后续提问会自动启动和检查。';
      return;
    }
  } catch (error) {
    council.error = error instanceof Error ? error.message : String(error);
    return;
  }
  await council.run({
    type: 'participant.add',
    input: {
      platform: platform.value,
      name: participantName.value,
      avatar: avatar.value,
      websiteUrl: websiteUrl.value,
      enabled: true,
    },
  });
}

async function onAvatarFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    council.error = '头像只支持图片文件。';
    return;
  }
  if (file.size > 120_000) {
    council.error = '头像图片请小于约 120KB。';
    return;
  }
  avatar.value = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('read failed'));
    reader.readAsDataURL(file);
  });
}
</script>
<template>
  <p class="section-title">Settings</p>
  <h2>聊天室成员</h2>
  <p class="muted tagline">配置成员后即可提问；程序自动打开、检查并准备模型网页。</p>

  <div class="card">
    <h3>隐私确认</h3>
    <p class="muted">
      问题与讨论内容会通过本机 Chrome 写入各 AI 网页会话，并保存在本机 IndexedDB。不读取密码或
      Cookie，不调用模型 API。
    </p>
    <n-checkbox
      :checked="council.privacyAcknowledged"
      :disabled="council.privacyAcknowledged"
      @update:checked="(v) => v && council.acknowledgePrivacy()"
    >
      我已了解，允许将问题发送到已登录的模型网页
    </n-checkbox>
  </div>

  <n-alert type="info" title="通过已登录网页自动收发">
    首次允许 Chrome
    网站访问权限；发送问题后程序自动启动和检查。若账号需要登录或网页要求验证，请在网站完成，程序会保留任务。
  </n-alert>

  <div class="card">
    <n-form-item label="新任务的共识要求">
      <n-select
        aria-label="共识要求"
        :value="council.verificationPolicy"
        :options="verificationOptions"
        @update:value="council.setVerificationPolicy"
      />
    </n-form-item>
    <p class="muted">
      讨论共识仅表示成员意见一致；独立证据模式还要求记录关键事实的核验结果。已创建任务保留原设置。
    </p>
    <h3>添加成员</h3>
    <div class="row member-identity" style="margin-bottom: 12px">
      <RoomAvatar :name="participantName || '新成员'" :avatar="avatar" size="lg" />
      <span class="muted">预览</span>
    </div>
    <n-form label-placement="top">
      <n-form-item label="平台">
        <n-select v-model:value="platform" :options="platformOptions" aria-label="平台" />
      </n-form-item>
      <n-form-item label="聊天室名字">
        <n-input
          v-model:value="participantName"
          :input-props="{ 'aria-label': '参与者名称' }"
          placeholder="例如 技术评审 DeepSeek"
        />
      </n-form-item>
      <n-form-item label="头像">
        <div class="avatar-presets" role="listbox" aria-label="头像预设">
          <button
            v-for="emoji in avatarPresets"
            :key="emoji"
            type="button"
            class="avatar-preset"
            :class="{ active: avatar === emoji }"
            @click="avatar = emoji"
          >
            {{ emoji }}
          </button>
        </div>
        <div class="row" style="margin-top: 8px">
          <n-input
            v-model:value="avatar"
            placeholder="自定义表情或保留上传结果"
            :input-props="{ 'aria-label': '自定义头像' }"
          />
          <label class="avatar-upload">
            上传
            <input type="file" accept="image/*" @change="onAvatarFile" />
          </label>
        </div>
      </n-form-item>
      <n-form-item label="网页地址">
        <n-input
          v-model:value="websiteUrl"
          :input-props="{ 'aria-label': '网页地址' }"
          placeholder="https://"
        />
      </n-form-item>
      <n-button
        type="primary"
        :loading="council.busy"
        :disabled="!participantName.trim() || !websiteUrl.trim()"
        @click="add"
        >加入聊天室</n-button
      >
    </n-form>
  </div>

  <ModelCard
    v-for="participant in council.snapshot.participants"
    :key="participant.id"
    :participant="participant"
  />
  <div v-if="!council.snapshot.participants.length" class="empty">
    添加一名成员即可点名提问；共识讨论需要两名成员。可另设「大脑」负责路由。
  </div>
  <p v-else class="muted">
    可选：把一个已登录模型设为大脑。大脑只做意图路由，不会进入共识讨论。
    <template v-if="council.brainParticipant">
      当前大脑：{{ council.brainParticipant.name }}
    </template>
  </p>

  <details
    v-if="council.snapshot.discussions.length || council.snapshot.brainRequests.length"
    class="card"
  >
    <summary>任务管理与运行诊断</summary>
    <n-form-item label="当前任务">
      <n-select
        v-model:value="council.selectedId"
        aria-label="诊断任务"
        :options="
          council.snapshot.discussions.map((task) => ({
            label: `${task.title} · ${task.status}`,
            value: task.id,
          }))
        "
      />
    </n-form-item>
    <TaskControls />
    <h3>持久化消息队列</h3>
    <p
      v-for="task in council.snapshot.queue.filter(
        (task) => task.discussionId === council.selectedId,
      )"
      :key="task.id"
      class="mono"
    >
      {{
        council.snapshot.participants.find((p) => p.id === task.participantId)?.name ??
        task.participantId
      }}
      · {{ task.taskType }} · {{ task.status }} · 重试 {{ task.retryCount }} ·
      {{ task.lastError ?? '' }}
    </p>
    <h3>大脑请求</h3>
    <div
      v-for="request in council.snapshot.brainRequests.filter(
        (request) => !['done', 'cancelled'].includes(request.phase),
      )"
      :key="request.id"
    >
      <p>{{ request.question }} · {{ request.phase }}</p>
      <p>{{ request.error?.code }} {{ request.error?.detail }}</p>
      <n-button
        size="tiny"
        v-if="request.phase === 'paused'"
        @click="council.run({ type: 'brain.resume', id: request.id })"
        >恢复路由</n-button
      >
      <n-button size="tiny" @click="council.run({ type: 'brain.cancel', id: request.id })"
        >取消路由</n-button
      >
    </div>
  </details>
  <details v-if="council.selected" class="card">
    <summary>当前任务的争议与独立证据</summary>
    <Objections />
  </details>
  <div class="row" style="margin-top: 16px">
    <details v-if="council.snapshot.recoveredDrafts?.length" class="card">
      <summary>已保留的网页草稿</summary>
      <p class="muted">
        这些内容已单独保存在本地，不会作为本题消息发送。恢复按钮只填回空输入框，不发送。
      </p>
      <details v-for="draft in council.snapshot.recoveredDrafts" :key="draft.id">
        <summary>
          {{
            council.snapshot.participants.find((p) => p.id === draft.participantId)?.name ??
            '网页草稿'
          }}
          · {{ new Date(draft.createdAt).toLocaleString() }}
        </summary>
        <pre class="pre report-preview">{{ draft.content }}</pre>
        <n-button
          size="small"
          :disabled="council.busy"
          @click="council.run({ type: 'draft.restore', id: draft.id })"
          >恢复到原输入框（不发送）</n-button
        >
      </details>
    </details>
    <n-button type="primary" @click="council.page = 'chat'">返回聊天室</n-button>
    <span class="muted"
      >就绪讨论成员 {{ council.readyParticipants.length }} /
      {{
        council.snapshot.participants.filter((p) => p.enabled && (p.role ?? 'council') !== 'brain')
          .length
      }}
      ·
      {{ council.brainParticipant ? `大脑 ${council.brainParticipant.name}` : '未指定大脑' }}</span
    >
  </div>
</template>
