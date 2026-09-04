<script setup lang="ts">
defineProps<{ active: boolean }>();
</script>
<template><section v-if="active" class="flex flex-col lg:flex-row items-start gap-4 xl:gap-5"><slot /></section></template>
