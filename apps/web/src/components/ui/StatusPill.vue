<script setup lang="ts">
defineProps<{ tone: 'success' | 'warning' | 'danger' | 'info' | 'neutral'; label: string }>()
</script>

<template>
  <span class="status-pill" :class="`tone-${tone}`"><span class="status-dot" />{{ label }}</span>
</template>
