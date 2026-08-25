import { beforeEach, describe, expect, test, vi } from 'vitest';
import { createI18n } from 'vue-i18n';
import { mount } from '@vue/test-utils';

import BrowseModeBanner from '../BrowseModeBanner.vue';
import en from '../../localization/en.json';

const vrcxStoreMock = { isBrowse: false, browseSource: null, detectedNodeIds: [] };

vi.mock('../../stores', () => ({
    useVrcxStore: () => vrcxStoreMock
}));

vi.mock('lucide-vue-next', () => ({
    EyeOff: { template: '<span data-testid="eyeoff" />' }
}));

const i18n = createI18n({
    locale: 'en',
    fallbackLocale: 'en',
    legacy: false,
    globalInjection: false,
    missingWarn: false,
    fallbackWarn: false,
    messages: { en }
});

function mountBanner(overrides = {}) {
    Object.assign(vrcxStoreMock, { isBrowse: false, browseSource: null, detectedNodeIds: [] }, overrides);
    return mount(BrowseModeBanner, {
        global: { plugins: [i18n] }
    });
}

describe('BrowseModeBanner', () => {
    beforeEach(() => {
        Object.assign(vrcxStoreMock, { isBrowse: false, browseSource: null, detectedNodeIds: [] });
    });

    test('非浏览模式不渲染横幅', () => {
        const wrapper = mountBanner();
        expect(wrapper.find('[data-slot="alert"]').exists()).toBe(false);
    });

    test('explicit 浏览模式显示独立文案（不误称"检测到另一个实例"）', () => {
        const wrapper = mountBanner({ isBrowse: true, browseSource: 'explicit' });
        expect(wrapper.find('[data-slot="alert"]').exists()).toBe(true);
        expect(wrapper.text()).toContain(en.browse_mode.banner_text_explicit);
        expect(wrapper.text()).toContain(en.browse_mode.badge);
    });

    test('auto 检测到活跃采集节点时显示数量文案', () => {
        const wrapper = mountBanner({
            isBrowse: true,
            browseSource: 'auto-detected',
            detectedNodeIds: ['node-a', 'node-b']
        });
        const expected = en.browse_mode.banner_text_detected.replace('{count}', '2');
        expect(wrapper.text()).toContain(expected);
    });

    test('auto 但检测列表为空时回退通用文案', () => {
        const wrapper = mountBanner({ isBrowse: true, browseSource: 'auto-detected', detectedNodeIds: [] });
        expect(wrapper.text()).toContain(en.browse_mode.banner_text);
    });
});
