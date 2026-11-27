<script setup lang="ts">
import { ref, watch } from 'vue';
import { NButton, NSwitch, NPopconfirm, NInput } from 'naive-ui';
import type { Participant } from '../../protocols/domain';
import { useCouncilStore } from '../../stores/council.store';
import RoomAvatar from './RoomAvatar.vue';

const props = defineProps<{ participant: Participant }>();
const store = useCouncilStore();
const editName = ref(props.participant.name);
const editAvatar = ref(props.participant.avatar || '');
const avatarPresets = ['🌊', '🌱', '💬', '✨', '🟠', '🤖', '🧠', '🦊', '🐱', '🦉', '🐲', '⚡'];

watch(
  () => [props.participant.name, props.participant.avatar] as const,
  ([name, avatar]) => {
    editName.value = name;
    editAvatar.value = avatar || '';
  },
);

async function checkPage() {
  await store.run({ type: 'participant.check', id: props.participant.id });
}

async function saveProfile() {
  const name = editName.value.trim();
  const avatar = editAvatar.value.trim();
  if (!name) return;
  if (name === props.participant.name && avatar === (props.participant.avatar || '')) return;
  await store.run({
    type: 'participant.update',
    id: props.participant.id,
    input: { name, avatar },
  });
}

async function setBrain(value: boolean) {
  await store.run({
    type: 'participant.update',
    id: props.participant.id,
    input: { role: value ? 'brain' : 'council' },
  });
}

async function onAvatarFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    store.error = '头像只支持图片文件。';
    return;
  }
  if (file.size > 120_000) {
    store.error = '头像图片请小于约 120KB。';
    return;
  }
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('read failed'));
    reader.readAsDataURL(file);
  });
  editAvatar.value = dataUrl;
  await saveProfile();
}
</script>
<template>
  <article
    class="card member-card"
    :class="{ 'is-brain': (participant.role ?? 'council') === 'brain' }"
  >
    <div class="row spread">
      <div class="row member-identity">
        <RoomAvatar :name="editName || participant.name" :avatar="editAvatar" size="lg" />
        <div>
          <h3>
            {{ participant.name }}
            <span v-if="(participant.role ?? 'council') === 'brain'" class="brain-badge">大脑</span>
          </h3>
          <span class="muted">{{ participant.platform }} · {{ participant.adapterVersion }}</span>
        </div>
      </div>
      <n-switch
        :value="participant.enabled"
        :disabled="store.busy"
        :aria-label="`启用 ${participant.name}`"
        @update:value="
          (value) => store.run({ type: 'participant.enable', id: participant.id, enabled: value })
        "
      />
    </div>

    <div class="profile-edit">
      <label class="muted">聊天室显示名</label>
      <n-input
        v-model:value="editName"
        size="small"
        :input-props="{ 'aria-label': `${participant.name} 显示名` }"
        @blur="saveProfile"
      />
      <label class="muted">头像（表情或本地图片）</label>
      <div class="avatar-presets" role="listbox" :aria-label="`${participant.name} 头像预设`">
        <button
          v-for="emoji in avatarPresets"
          :key="emoji"
          type="button"
          class="avatar-preset"
          :class="{ active: editAvatar === emoji }"
          @click="
            editAvatar = emoji;
            saveProfile();
          "
        >
          {{ emoji }}
        </button>
      </div>
      <div class="row">
        <n-input
          v-model:value="editAvatar"
          size="small"
          placeholder="自定义表情，如 🦊"
          :input-props="{ 'aria-label': `${participant.name} 自定义头像` }"
          @blur="saveProfile"
        />
        <label class="avatar-upload">
          上传
          <input type="file" accept="image/*" @change="onAvatarFile" />
        </label>
      </div>
    </div>

    <div class="row spread brain-row">
      <span class="muted">设为大脑（只路由，永不讨论；同时只能有一个）</span>
      <n-switch
        :value="(participant.role ?? 'council') === 'brain'"
        :disabled="store.busy"
        :aria-label="`设 ${participant.name} 为大脑`"
        @update:value="setBrain"
      />
    </div>
    <p>
      <span class="pill">{{ participant.status }}</span>
      <span class="pill"
        >网页自动运行：{{
          participant.capabilities.unattendedAllowed
            ? '页面就绪'
            : participant.check?.firstMessageAllowed || participant.check?.sessionPreparationAllowed
              ? '可自动准备会话，回复待验证'
              : '待检查'
        }}</span
      >
    </p>
    <p class="reason">{{ participant.reason }}</p>
    <p class="muted">
      {{ participant.check?.pageOpen ? '已找到标签页' : '未确认已打开网页' }} · 登录：{{
        participant.check?.login ?? 'unknown'
      }}
      · 网络可用：{{ participant.check?.pageReachable ?? 'unknown' }}
    </p>
    <div class="row">
      <n-button size="small" :disabled="store.busy" @click="checkPage">重新检测（可选）</n-button>
      <n-button
        size="small"
        :disabled="store.busy"
        @click="store.run({ type: 'participant.open', id: participant.id })"
        >打开网页</n-button
      >
      <n-popconfirm @positive-click="store.run({ type: 'participant.remove', id: participant.id })">
        <template #trigger>
          <n-button text size="small" type="error" :disabled="store.busy">删除</n-button>
        </template>
        删除参与者配置？历史消息仍保留参与者 ID。
      </n-popconfirm>
    </div>
    <details v-if="participant.check">
      <summary>查看能力检查依据</summary>
      <p v-if="participant.check.failureCode" class="reason">
        检测代码：{{ participant.check.failureCode }}
      </p>
      <div class="mono">
        读取：{{ participant.capabilities.canReadOutput }} · 发送：{{
          participant.capabilities.canSubmitMessage
        }}
        · 完成检测：{{ participant.capabilities.canDetectCompletion
        }}<br />规则参考（独立于页面检测）：{{ participant.check.policy }} · 技术验证：{{
          participant.check.technicalVerified
        }}<br />检查时间：{{ new Date(participant.check.checkedAt).toLocaleString() }}
      </div>
      <details v-for="item in participant.check.diagnostics ?? []" :key="item.tabId">
        <summary>标签 {{ item.tabId }} · 页面诊断</summary>
        <div class="mono">
          {{ item.origin }}<br />输入框：{{ item.editorFound ?? '未知' }} · 回复数：{{
            item.outputCount ?? '未知'
          }}
          · 已确认空白新会话：{{ item.emptyConversation ?? false }} · 完成控件：{{
            item.completionControlFound ?? '未知'
          }}<br />登录：{{ item.login ?? 'unknown' }} · 生成中：{{ item.busy ?? '未知'
          }}<br />错误：{{ item.errorCode ?? '无' }}<br />匹配选择器：{{
            JSON.stringify(item.selectors ?? {})
          }}
          <template v-if="item.structure"
            ><br />结构诊断（不含聊天正文）：{{ JSON.stringify(item.structure) }}</template
          >
        </div>
      </details>
      <p v-for="source in participant.check.sources" :key="source">
        <a :href="source" target="_blank" rel="noopener noreferrer" class="mono">官方规则来源</a>
      </p>
    </details>
  </article>
</template>
