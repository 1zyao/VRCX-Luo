import { VueQueryPlugin } from '@tanstack/vue-query';
import { createApp } from 'vue';

import {
    i18n,
    initComponents,
    initPlugins,
    initRouter,
    initSentry
} from './plugins';
import { initPiniaPlugins, pinia } from './stores';
import { queryClient } from './queries';
import { initAccountHubWatcher } from './services/accountHub.js';
import { stopFeedCollector } from './services/database/feedCollector.js';

import App from './App.vue';

// The DB adapter singleton is initialised by `initInteropApi()` in
// `src/plugins/interopApi.js`, which reads `VRCX_Database.mode` from
// VRCXStorage once and calls `initAdapter(mode)`. That runs before
// `configRepository.init()` and before any module that touches the
// database, so by the time `app.js` executes, the singleton is already
// bound to the right engine (sqlite / postgresql / mysql). `app.js`
// no longer calls `initAdapter()` itself — the previous top-level
// `await initAdapter()` was parameterless and read VRCXStorage at
// module load, which competed with the interopApi call and read the
// same global twice. Centralising the call in interopApi keeps engine
// detection in one place and matches the MySQL branch's contract.
await initPlugins();
await initPiniaPlugins();

// #region | Hey look it's most of VRCX!

const app = createApp(App);

app.use(pinia).use(i18n).use(VueQueryPlugin, { queryClient });
initComponents(app);
initRouter(app);
await initSentry(app);

// Initialise multi-account hub watcher (after Pinia is up)
initAccountHubWatcher();

app.mount('#root');

// 退出时尽力注销 node_registry 心跳行，让其他节点立刻接管（而非等满 120s TTL）。
// beforeunload 里不能 await，DB 删除是 fire-and-forget，失败由 TTL 兜底。
window.addEventListener('beforeunload', () => {
    stopFeedCollector();
});
