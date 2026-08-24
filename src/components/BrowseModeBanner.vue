<template>
    <Alert v-if="vrcxStore.isBrowse" variant="warning" class="mx-3 mt-3 shrink-0">
        <EyeOff class="size-4" />
        <AlertTitle class="truncate">{{ t('browse_mode.badge') }}</AlertTitle>
        <AlertDescription class="text-xs!">{{ t('browse_mode.banner_text') }}</AlertDescription>
    </Alert>
</template>

<script setup>
    import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
    import { EyeOff } from 'lucide-vue-next';
    import { useI18n } from 'vue-i18n';

    import { useVrcxStore } from '../stores';

    const vrcxStore = useVrcxStore();
    const { t } = useI18n();
</script>
