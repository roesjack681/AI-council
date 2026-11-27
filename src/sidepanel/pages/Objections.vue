<script setup lang="ts">
import { computed, ref } from 'vue';
import { NInput, NSelect, NButton, NForm, NFormItem, NAlert } from 'naive-ui';
import type { FactInput } from '../../protocols/domain';
import { useCouncilStore } from '../../stores/council.store';
const store = useCouncilStore();
const claimId = ref('');
const source = ref('');
const description = ref('');
const status = ref<FactInput['verificationStatus']>('UNVERIFIED');
const operands = ref('');
const expected = ref('');
const operation = ref<'sum' | 'product'>('sum');
const claims = computed(() =>
  store.snapshot.claims.filter((c) => c.discussionId === store.selectedId),
);
const frozen = computed(
  () =>
    !store.selected ||
    ['COMPLETED', 'UNRESOLVED', 'FAILED', 'FINALIZING'].includes(store.selected.status),
);
async function record() {
  await store.run({
    type: 'fact.record',
    input: {
      discussionId: store.selectedId,
      claimId: claimId.value,
      evidenceSource: source.value,
      evidenceDescription: description.value,
      verificationStatus: status.value,
    },
  });
}
async function calculate() {
  const numbers = operands.value
    .split(/[,，\s]+/)
    .filter(Boolean)
    .map(Number);
  if (
    !numbers.length ||
    numbers.some((n) => !Number.isFinite(n)) ||
    !expected.value.trim() ||
    !Number.isFinite(Number(expected.value))
  ) {
    store.error = '请输入有限数值与预期结果';
    return;
  }
  await store.run({
    type: 'fact.calculate',
    input: {
      discussionId: store.selectedId,
      claimId: claimId.value,
      operation: operation.value,
      operands: numbers,
      expected: Number(expected.value),
    },
  });
}
async function loadFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  if (file.size > 50_000) {
    store.error = '文档片段不能超过 50 KB';
    return;
  }
  try {
    description.value = await file.text();
    source.value = `用户本地文档：${file.name}`;
  } catch {
    store.error = '本地文件读取失败';
  }
}
</script>
<template>
  <p class="section-title">Objections & evidence</p>
  <h2>争议与事实核验</h2>
  <p class="muted">模型一致不等于事实正确。证据和成员立场分别保存。</p>
  <div v-if="!store.selected" class="empty">请先选择任务。</div>
  <template v-else
    ><div
      v-if="!store.snapshot.objections.some((o) => o.discussionId === store.selectedId)"
      class="empty"
    >
      尚无已记录争议。
    </div>
    <article
      v-for="objection in store.snapshot.objections.filter(
        (o) => o.discussionId === store.selectedId,
      )"
      :key="objection.id"
      class="card"
    >
      <div class="row spread">
        <h3>{{ objection.title }}</h3>
        <span class="pill">{{ objection.severity }} · {{ objection.status }}</span>
      </div>
      <p class="pre">{{ objection.description }}</p>
      <p class="mono">
        {{ objection.id }}<br />结论：{{ objection.relatedClaimId }} v{{ objection.claimVersion
        }}<br />来源：{{ objection.sourceMessageId }}
      </p>
      <p v-for="review in objection.reviews" :key="review.messageId" class="muted">
        {{ review.participantId }}：{{ review.action }} — {{ review.reason }}
      </p>
      <p v-if="objection.resolution" class="reason">{{ objection.resolution }}</p>
    </article>
    <div class="card">
      <h3>核心结论与立场</h3>
      <div v-if="!claims.length" class="muted">尚无来自真实回复的结构化结论。</div>
      <article v-for="claim in claims" :key="claim.id">
        <p class="pre">
          <b>v{{ claim.version }} · {{ claim.category }}</b
          ><br />{{ claim.description }}
        </p>
        <p
          v-for="position in store.snapshot.positions.filter((p) => p.claimId === claim.id)"
          :key="position.id"
          class="muted"
        >
          {{
            store.snapshot.participants.find((p) => p.id === position.participantId)?.name ??
            position.participantId
          }}：{{ position.position }}（v{{ position.claimVersion }}） — {{ position.reason }}
        </p>
        <p class="mono">{{ claim.id }} · 来源 {{ claim.sourceMessageId }}</p>
      </article>
    </div>
    <div class="card">
      <h3>添加独立核验证据</h3>
      <n-alert type="info"
        >这里保存用户提供的文档核验结果，或执行本地算式验证；不会自动访问来源网址。证据绑定结论版本，修订后需重新核验。</n-alert
      ><n-form label-placement="top"
        ><n-form-item label="关联结论"
          ><n-select
            v-model:value="claimId"
            :options="claims.map((c) => ({ label: `v${c.version} ${c.description}`, value: c.id }))"
            aria-label="证据关联结论" /></n-form-item
        ><n-form-item label="证据来源"
          ><n-input
            v-model:value="source"
            :input-props="{ 'aria-label': '证据来源' }" /></n-form-item
        ><n-form-item label="证据说明与核验依据"
          ><n-input
            v-model:value="description"
            type="textarea"
            :input-props="{ 'aria-label': '证据说明' }" /></n-form-item
        ><label class="muted"
          >载入本地文本片段（50 KB 内）<input
            type="file"
            accept=".txt,.md"
            @change="loadFile" /></label
        ><n-form-item label="核验状态"
          ><n-select
            v-model:value="status"
            :options="
              ['VERIFIED', 'CONTRADICTED', 'UNVERIFIED', 'INSUFFICIENT', 'NOT_APPLICABLE'].map(
                (v) => ({ label: v, value: v }),
              )
            "
            aria-label="核验状态" /></n-form-item
        ><n-button
          :loading="store.busy"
          :disabled="frozen || !claimId || !source.trim() || description.trim().length < 3"
          @click="record"
          >保存证据记录</n-button
        ></n-form
      >
      <details>
        <summary>本地计算验证</summary>
        <div class="stack">
          <n-select
            v-model:value="operation"
            :options="[
              { label: '求和', value: 'sum' },
              { label: '乘积', value: 'product' },
            ]"
            aria-label="计算方式"
          /><n-input
            v-model:value="operands"
            placeholder="数字，用空格或逗号隔开"
            :input-props="{ 'aria-label': '计算操作数' }"
          /><n-input
            v-model:value="expected"
            placeholder="预期结果"
            :input-props="{ 'aria-label': '预期计算结果' }"
          /><n-button :disabled="frozen || !claimId" @click="calculate"
            >执行并保存计算证据</n-button
          >
        </div>
      </details>
    </div>
    <div class="card">
      <h3>证据记录</h3>
      <article
        v-for="fact in store.snapshot.factChecks.filter((f) => f.discussionId === store.selectedId)"
        :key="fact.id"
      >
        <p>
          <span class="pill">{{ fact.verificationStatus }}</span>
          <span class="muted">{{ fact.provenance }} · v{{ fact.claimVersion }}</span>
        </p>
        <p class="pre">{{ fact.evidenceDescription }}</p>
        <p class="mono">{{ fact.evidenceSource }}<br />{{ fact.id }}</p>
      </article>
    </div></template
  >
</template>
