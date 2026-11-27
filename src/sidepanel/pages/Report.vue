<script setup lang="ts">
import { computed } from 'vue';
import { NButton, NAlert } from 'naive-ui';
import { useCouncilStore } from '../../stores/council.store';
const store = useCouncilStore();
const report = computed(() =>
  store.snapshot.reports.find((r) => r.discussionId === store.selectedId),
);
function download(format: 'markdown' | 'html' | 'json') {
  if (!report.value) return;
  const type = { markdown: 'text/markdown', html: 'text/html', json: 'application/json' }[format];
  const ext = format === 'markdown' ? 'md' : format;
  const url = URL.createObjectURL(
    new Blob([report.value[format]], { type: `${type};charset=utf-8` }),
  );
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `ai-council-${store.selectedId}.${ext}`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
</script>
<template>
  <p class="section-title">Council report</p>
  <h2>最终报告</h2>
  <p class="muted">保留结论、争议、证据及原始消息的对应关系。</p>
  <div v-if="!store.selected" class="empty">请先选择任务。</div>
  <template v-else
    ><n-alert
      v-if="store.selected.status !== 'COMPLETED'"
      type="warning"
      title="本任务未达成完整共识"
      >当前可以导出阶段性记录；导出报告不会使任务变为已完成。</n-alert
    >
    <div class="row">
      <n-button
        type="primary"
        :loading="store.busy"
        @click="store.run({ type: 'report.generate', id: store.selected.id })"
        >{{ report ? '更新报告' : '生成当前报告' }}</n-button
      ><n-button
        v-for="format in ['markdown', 'html', 'json'] as const"
        :key="format"
        :disabled="!report"
        @click="download(format)"
        >导出 {{ format === 'markdown' ? 'Markdown' : format.toUpperCase() }}</n-button
      >
    </div>
    <article v-if="report" class="card">
      <p class="muted">
        报告状态：{{ report.status }} · 生成于 {{ new Date(report.createdAt).toLocaleString() }}
      </p>
      <pre class="pre report-preview">{{ report.markdown }}</pre>
    </article>
    <div v-else class="empty">尚无报告。结束任务后会自动生成，也可随时导出当前记录。</div></template
  >
</template>
