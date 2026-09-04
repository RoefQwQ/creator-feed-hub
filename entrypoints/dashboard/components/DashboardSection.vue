<script setup lang="ts">
defineProps<{ active: boolean; className?: string }>();
</script>
<template><section v-if="active" :class="className"><slot /></section></template>
