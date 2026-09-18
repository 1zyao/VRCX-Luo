import * as workerTimers from 'worker-timers';

import { adapter } from './adapter/index.js';

/**
 * 跨进程节点注册表。
 *
 * 每个节点每 30s 向共享库 `node_registry` 写一行心跳，记录自己的**配置模式**：
 *   - `'forced'`：显式 VRCX_FeedCollector=true，永不退让
 *   - `'auto'`  ：自动模式，按 node_id 字典序参与选举
 * 120s 无心跳视为失活。调用方用 detectActiveCollectors() 取活跃候选，据此决定
 * 本节点要不要写 feed（见 feedCollector.js）。
 *
 * 心跳行里的 mode 是**静态配置**而非当前状态，所以选举结果变化时不需要改行
 * —— 否则「决定采集」到「行更新」之间有最长一个心跳周期的空窗，接管时两个
 * 节点会同时开始采集。
 *
 * node_id 持久化在 VRCXStorage（每机器一份），**不随会话变化**：崩溃/强杀重启
 * 后新会话若拿到新 id，会把上一会话的残留行误认成「别的活跃节点」而让位，造成
 * 最长一个 TTL 的采集空窗（丢数据）。同机多实例共享 VRCX.json 会拿到同一个
 * id（互相看成自己，都采集）—— 失败方向是多写，可接受。
 *
 * `prefixes` 列保留以与 browse-mode 的 M2 DDL 兼容（feed 侧恒写空串）。
 */
const HEARTBEAT_INTERVAL_MS = 30_000;
/** 活跃判定窗口：超过这个时长没心跳就算死了 */
const COLLECTOR_TTL_MS = 120_000;
/**
 * 陈旧行回收窗口，故意远大于 TTL（10 倍）：跨机器时钟偏移下，快钟节点会把
 * 慢钟节点的新鲜行算成过期并删掉，让活着的节点从注册表里消失。只清「肯定
 * 死了」的行，宁可再生几条垃圾也不要误删活节点。
 */
const STALE_ROW_GC_MS = 10 * 60_000;
const NODE_ID_STORAGE_KEY = 'VRCX_NodeId';

const MISSING_TABLE_RE = /no such table|doesn'?t exist|does not exist/i;

/** @type {string|null} */
let ownNodeId = null;
/** @type {'forced'|'auto'|null} */
let ownMode = null;
/** @type {number|null} */
let heartbeatTimer = null;
let tableMissingWarned = false;

function generateNodeId() {
    return (
        globalThis.crypto?.randomUUID?.() ||
        `n-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
    );
}

/**
 * 取本机稳定 node_id：优先复用 VRCXStorage 里的，没有就生成并持久化。
 * 持久化失败只影响「崩溃重启后多让位一个 TTL」，不影响正确性。
 *
 * @returns {Promise<string>}
 */
async function resolveNodeId() {
    try {
        const stored = String(
            (await VRCXStorage.Get(NODE_ID_STORAGE_KEY)) ?? ''
        ).trim();
        if (stored) return stored;
    } catch (error) {
        console.warn(
            '[nodeRegistry] 读取 VRCX_NodeId 失败，本次会话用临时 id',
            error
        );
        return generateNodeId();
    }
    const fresh = generateNodeId();
    try {
        await VRCXStorage.Set(NODE_ID_STORAGE_KEY, fresh);
    } catch (error) {
        console.warn(
            '[nodeRegistry] 写入 VRCX_NodeId 失败，下次启动会换 id',
            error
        );
    }
    return fresh;
}

/**
 * 心跳 upsert：单语句原子，不参与业务事务。定时拍失败静默，下一拍重试。
 *
 * @param {import('./adapter/EngineAdapter.js').EngineAdapter} [db]
 * @param {{ throwOnError?: boolean }} [options]
 */
async function beat(db = adapter, { throwOnError = false } = {}) {
    if (!ownNodeId) return;
    const heartbeatAt = new Date().toISOString();
    try {
        await db.upsertPartial(
            'node_registry',
            {
                node_id: ownNodeId,
                mode: ownMode,
                prefixes: '',
                heartbeat_at: heartbeatAt
            },
            {
                mode: ownMode,
                prefixes: '',
                heartbeat_at: heartbeatAt
            },
            'node_id'
        );
    } catch (error) {
        console.error('[nodeRegistry] heartbeat failed', error);
        if (throwOnError) throw error;
    }

    const cutoff = new Date(Date.now() - STALE_ROW_GC_MS).toISOString();
    try {
        const rows = await db.select('node_registry', [
            'node_id',
            'heartbeat_at'
        ]);
        for (const [nodeId, heartbeatAtRow] of rows) {
            if (heartbeatAtRow < cutoff) {
                await db
                    .delete('node_registry', { node_id: nodeId })
                    .catch(() => {});
            }
        }
    } catch (error) {
        console.error('[nodeRegistry] stale row cleanup failed', error);
    }
}

/**
 * 检测活跃候选节点。
 *
 * 返回**全部**新鲜的候选（`'auto'` 与 `'forced'`），而不只是当前正在采集的：
 * 心跳行记录的是配置模式，选举由调用方按同一份名单独立算出，双方结论一致。
 *
 * 表缺失（旧库未迁移）→ 返回 [] + warn-once，调用方按 collector 兜底启动；
 * 其他错误 rethrow。
 *
 * @returns {Promise<Array<{nodeId: string, mode: string, heartbeatAt: string}>>}
 */
async function detectActiveCollectors() {
    let rows;
    try {
        rows = await adapter.select('node_registry', [
            'node_id',
            'mode',
            'prefixes',
            'heartbeat_at'
        ]);
    } catch (error) {
        if (MISSING_TABLE_RE.test(String(error?.message || error))) {
            if (!tableMissingWarned) {
                tableMissingWarned = true;
                console.warn(
                    '[nodeRegistry] node_registry 表不存在，按 collector 兜底启动',
                    error
                );
            }
            return [];
        }
        throw error;
    }
    const cutoff = new Date(Date.now() - COLLECTOR_TTL_MS).toISOString();
    return rows
        .filter(
            ([nodeId, mode, , heartbeatAt]) =>
                (mode === 'auto' || mode === 'forced') &&
                nodeId !== ownNodeId &&
                heartbeatAt >= cutoff
        )
        .map(([nodeId, mode, , heartbeatAt]) => ({
            nodeId,
            mode,
            heartbeatAt
        }));
}

function stopHeartbeat() {
    if (heartbeatTimer !== null) {
        workerTimers.clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }
    ownNodeId = null;
    ownMode = null;
}

/** 优雅退出：删除本节点行后停止心跳（fire-and-forget）。 */
function removeOwnRow() {
    if (ownNodeId) {
        adapter.delete('node_registry', { node_id: ownNodeId }).catch(() => {});
    }
    stopHeartbeat();
}

export const nodeRegistry = {
    /** @type {string|null} */
    get nodeId() {
        return ownNodeId;
    },

    /**
     * 启动节点心跳（先停掉上一轮）。node_id 取自 VRCXStorage，跨会话稳定。
     *
     * 先注册定时器再打第一拍：启动早期表可能还没建（`initNodeRegistry` 在
     * vrcx store 初始化时才跑），首拍失败若直接抛在注册之前，定时器就永远不会
     * 建立，心跳再也不会重试。首拍失败仍抛出，让调用方决定是否降级。
     *
     * @param {'forced'|'auto'} mode
     */
    async startHeartbeat(mode) {
        stopHeartbeat();
        ownNodeId = await resolveNodeId();
        ownMode = mode;
        heartbeatTimer = workerTimers.setInterval(beat, HEARTBEAT_INTERVAL_MS);
        await beat(adapter, { throwOnError: true });
    },

    stopHeartbeat,

    removeOwnRow,

    detectActiveCollectors
};
