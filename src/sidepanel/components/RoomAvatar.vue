<script setup lang="ts">
import { computed } from 'vue';

const props = withDefaults(
  defineProps<{
    name: string;
    avatar?: string;
    size?: 'sm' | 'md' | 'lg';
  }>(),
  { avatar: '', size: 'md' },
);

const isImage = computed(
  () =>
    props.avatar.startsWith('data:image/') ||
    props.avatar.startsWith('https://') ||
    props.avatar.startsWith('blob:'),
);
const glyph = computed(() => {
  if (props.avatar && !isImage.value) return props.avatar.slice(0, 4);
  const ch = props.name.trim().charAt(0);
  return ch || '?';
});
const tone = computed(() => {
  let h = 0;
  for (const c of props.name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const hues = [152, 28, 210, 188, 42, 265, 320];
  return hues[h % hues.length];
});
</script>
<template>
  <span class="room-avatar" :class="`room-avatar-${size}`" :title="name" :aria-label="name">
    <img v-if="isImage" :src="avatar" alt="" class="room-avatar-img" />
    <span v-else class="room-avatar-glyph" :style="{ background: `hsl(${tone} 42% 36%)` }">{{
      glyph
    }}</span>
  </span>
</template>
