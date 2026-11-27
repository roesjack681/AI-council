<script setup lang="ts">
import { onBeforeUnmount, ref, useId, watch } from 'vue';

const props = defineProps<{ show: boolean; markdown: string }>();
const emit = defineEmits<{ 'update:show': [value: boolean] }>();
const dialog = ref<HTMLDialogElement | null>(null);
const titleId = useId();
watch(
  [() => props.show, dialog],
  ([show, element]) => {
    if (show && element && !element.open) element.showModal();
    else if (!show && element?.open) element.close();
  },
  { flush: 'post', immediate: true },
);
function close(): void {
  dialog.value?.close();
}
function onBackdrop(event: MouseEvent): void {
  if (event.target !== dialog.value || !dialog.value) return;
  const box = dialog.value.getBoundingClientRect();
  if (
    event.clientX < box.left ||
    event.clientX > box.right ||
    event.clientY < box.top ||
    event.clientY > box.bottom
  )
    close();
}
onBeforeUnmount(close);
</script>
<template>
  <dialog
    ref="dialog"
    class="report-dialog"
    :aria-labelledby="titleId"
    @close="emit('update:show', false)"
    @click="onBackdrop"
  >
    <div class="report-dialog-header">
      <h2 :id="titleId">讨论详情</h2>
      <button
        type="button"
        class="report-dialog-close"
        autofocus
        aria-label="关闭讨论详情"
        @click="close"
      >
        关闭
      </button>
    </div>
    <pre class="report-preview pre">{{ markdown }}</pre>
  </dialog>
</template>
