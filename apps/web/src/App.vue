<script setup lang="ts">
import { onMounted } from 'vue'
import { RouterView } from 'vue-router'
import { usePreferencesStore } from './modules/settings/preferences.store'

const preferences = usePreferencesStore()
onMounted(() => preferences.apply())
</script>

<template>
  <RouterView />
</template>
