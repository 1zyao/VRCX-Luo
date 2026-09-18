import * as workerTimers from 'worker-timers';

import { nodeRegistry } from './nodeRegistry.js';

/**
 * feed 单写开关（三态）。
 *
 * `feed_*` 表是**账号级**观测：同一账号的多个客户端各自轮询 / 收 WS，会看到同
 * 一事件并各自落库，产生重复行。`gamelog*` / `activity*` 是**设备级**数据，各读
 * 各机日志，天然不重复，也不受本开关影响。
 *
 * 配置：VRCXStorage flat 键 `VRCX_FeedCollector`
 *   - `'true'`  / `'1'` / `'yes'` → 强制采集（登记为 `forced`，自动节点无条件
 *     让位；适合 24/7 服务器。两台都设 true 时都会采集，等于手动双写）
 *   - `'false'` / `'0'` / `'no'`  → 强制不采集（不写心跳，不参与注册表）
 *   - 缺省 / 其他值               → 自动：没有别的活跃候选者时才采集
 *
 * 选举规则（纯函数，所有节点用同一份注册表名单独立算出同样结论）：
 *   存在 `forced` 候选 → 让位；否则存在 node_id 字典序更小的 `auto` 候选 → 让位。
 * 心跳行记录的是**配置模式**而非当前状态，所以决定采集后无需回写行 —— 否则
 * 「决定」到「行更新」之间有空窗，接管时两个节点会同时开始采集。
 *
 * 失败方向统一为 fail-open（继续采集）：最坏是多写一份，而不是静默不采集。
 *
 * 已知边界：
 *   - 门禁是**节点级**的，feed 是账号级。多账号且各机器登录账号集合不同时，
 *     让位的那台所持有的账号会没人写 feed。当前部署所有机器同一账号，无影响；
 *     若将来要多账号混跑，需要把选举按 `node_registry.prefixes` 分账号做。
 *   - `heartbeat_at` 用各节点本地时钟，靠 NTP 保证偏移远小于 120s TTL。
 *     偏移超过 TTL 会让选举失效（快钟节点看不到慢钟节点）。彻底修法是用数据库
 *     自己的时钟打时间戳，需要按引擎写 raw SQL，暂不做。
 */

const SCAN_INTERVAL_MS = 60_000;

/** @type {'true'|'false'|'auto'} */
let mode = 'auto';
/** 存在活跃 `forced` 候选、或 node_id 更小的活跃 `auto` 候选 → 本节点让位 */
let peerWins = false;
/** @type {number|null} */
let scanTimer = null;

function normalizeMode(raw) {
    const value = String(raw ?? '')
        .trim()
        .toLowerCase();
    if (value === 'false' || value === '0' || value === 'no') return 'false';
    if (value === 'true' || value === '1' || value === 'yes') return 'true';
    return 'auto';
}

/**
 * 本节点是否负责写 feed（账号级数据）。同步读缓存，feed 写入路径直接调用。
 *
 * @returns {boolean}
 */
export function isFeedCollector() {
    if (mode === 'false') return false;
    if (mode === 'true') return true;
    return !peerWins;
}

/**
 * 重新探测候选并更新本节点判定。导出供测试直接驱动（定时器回调在 jsdom 里
 * 不易触发）。
 *
 * @returns {Promise<void>}
 */
export async function refreshPeerState() {
    // forced / 关闭 不参与选举，也不该被重复调用改判定。
    if (mode !== 'auto') return;
    let peers;
    try {
        peers = await nodeRegistry.detectActiveCollectors();
    } catch (error) {
        // 探测失败保持上一次判定：最坏后果是多写一会儿，而不是静默停采。
        console.warn('[feed] collector 探测失败，保持当前判定:', error);
        return;
    }
    const own = nodeRegistry.nodeId;
    const nextPeerWins =
        peers.some((peer) => peer.mode === 'forced') ||
        peers.some((peer) => peer.mode === 'auto' && peer.nodeId < own);
    if (nextPeerWins !== peerWins) {
        peerWins = nextPeerWins;
        console.log(
            peerWins
                ? '[feed] 检测到其他活跃采集者，本节点暂停写 feed'
                : '[feed] 未检测到其他活跃采集者，本节点接管写 feed'
        );
    }
}

/**
 * 启动期调用一次（重复调用安全：先停掉上一轮）。
 *
 * @returns {Promise<void>}
 */
export async function initFeedCollector() {
    stopFeedCollector();

    try {
        mode = normalizeMode(await VRCXStorage.Get('VRCX_FeedCollector'));
    } catch (error) {
        console.error(
            '[feed] 读取 VRCX_FeedCollector 失败，按自动处理:',
            error
        );
        mode = 'auto';
    }

    if (mode === 'false') {
        console.log('[feed] VRCX_FeedCollector=false，本节点不写 feed');
        return;
    }

    if (mode === 'true') {
        // 显式强制：登记为 forced，自动节点看到后无条件让位。
        try {
            await nodeRegistry.startHeartbeat('forced');
        } catch (error) {
            console.warn('[feed] 心跳登记失败，仍强制采集:', error);
        }
        console.log('[feed] VRCX_FeedCollector=true，本节点强制采集 feed');
        return;
    }

    // 先登记再判定：另一台同时启动时能看到本节点，选举才有依据。
    // 首拍失败（启动早期表还没建）不阻止扫描 —— 心跳定时器已在 startHeartbeat
    // 内注册，30s 后自动重试；这里继续探测，避免一次抖动就永久放弃自动接管。
    try {
        await nodeRegistry.startHeartbeat('auto');
    } catch (error) {
        console.warn('[feed] 心跳登记失败，仍按当前判定采集:', error);
    }

    await refreshPeerState();
    scanTimer = workerTimers.setInterval(refreshPeerState, SCAN_INTERVAL_MS);
    console.log(
        `[feed] 自动模式：当前${isFeedCollector() ? '采集' : '不采集'} feed`
    );
}

/** 停扫描 + 删除本节点心跳行 + 重置判定（fire-and-forget 删除）。 */
export function stopFeedCollector() {
    if (scanTimer !== null) {
        workerTimers.clearInterval(scanTimer);
        scanTimer = null;
    }
    nodeRegistry.removeOwnRow();
    mode = 'auto';
    peerWins = false;
}
