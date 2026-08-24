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
import { nodeRegistry } from './services/database/nodeRegistry.js';

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

// H1 graceful exit (BROWSE_MODE_M2_DESIGN.md §2.5): 正常退出删除本节点
// 心跳行，避免崩溃残留被 TTL 误判；fire-and-forget，不阻塞退出流程。
window.addEventListener('beforeunload', () => {
    nodeRegistry.removeOwnRow();
});

app.mount('#root');
