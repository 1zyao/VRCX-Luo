import * as workerTimers from 'worker-timers';

import { adapter } from './adapter/index.js';

/**
 * 跨进程节点注册表（BROWSE_MODE_M2_DESIGN.md §2.3-§2.6）。
 *
 * collector 节点每隔 30s 向共享库写入一行心跳；browse 节点启动时通过
 * detectActiveCollectors() 判断是否存在其他活跃 collector。node_id 每会话
 * 随机生成，**不得**持久化到 VRCXStorage（同机多实例共享 VRCX.json，
 * 持久化会导致全部实例误判为同一节点）。
 */
const HEARTBEAT_INTERVAL_MS = 30_000;
const COLLECTOR_TTL_MS = 120_000;

const MISSING_TABLE_RE = /no such table|doesn'?t exist|does not exist/i;

/** @type {string|null} */
let ownNodeId = null;
/** @type {string|null} */
let ownMode = null;
/** @type {string[]} */
let ownPrefixes = [];
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
 * 心跳 upsert：单语句原子，不参与业务事务，失败静默下一拍重试。
 */
async function beat() {
    if (!ownNodeId) return;
    const heartbeatAt = new Date().toISOString();
    try {
        await adapter.upsertPartial(
            'node_registry',
            {
                node_id: ownNodeId,
                mode: ownMode,
                prefixes: ownPrefixes.join(','),
                heartbeat_at: heartbeatAt
            },
            {
                mode: ownMode,
                prefixes: ownPrefixes.join(','),
                heartbeat_at: heartbeatAt
            },
            'node_id'
        );
    } catch (error) {
        console.error('[nodeRegistry] heartbeat failed', error);
    }

    const cutoff = new Date(Date.now() - COLLECTOR_TTL_MS).toISOString();
    try {
        const rows = await adapter.select('node_registry', [
            'node_id',
            'heartbeat_at'
        ]);
        for (const [nodeId, heartbeatAtRow] of rows) {
            if (heartbeatAtRow < cutoff) {
                await adapter
                    .delete('node_registry', { node_id: nodeId })
                    .catch(() => {});
            }
        }
    } catch (error) {
        console.error('[nodeRegistry] stale row cleanup failed', error);
    }
}

/**
 * 检测是否存在其他活跃 collector 节点。
 * 表缺失（旧库未迁移 / 新库尚未初始化）→ 返回 [] + warn-once，
 * 调用方按 collector 兜底启动；其他错误 rethrow。
 *
 * @returns {Promise<Array<{nodeId: string, mode: string, prefixes: string, heartbeatAt: string}>>}
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
                    '[nodeRegistry] node_registry 表不存在，按 collector 模式启动',
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
                mode === 'collector' &&
                nodeId !== ownNodeId &&
                heartbeatAt >= cutoff
        )
        .map(([nodeId, mode, prefixes, heartbeatAt]) => ({
            nodeId,
            mode,
            prefixes,
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
    ownPrefixes = [];
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

    setOwnPrefixes(prefixes) {
        ownPrefixes = prefixes || [];
    },

    /**
     * 启动节点心跳。
     * @param {'collector'|'browse'} mode
     */
    async startHeartbeat(mode) {
        stopHeartbeat();
        ownNodeId = generateNodeId();
        ownMode = mode;
        await beat();
        heartbeatTimer = workerTimers.setInterval(beat, HEARTBEAT_INTERVAL_MS);
    },

    stopHeartbeat,

    /** 优雅退出：删除本节点行后停止心跳（fire-and-forget）。 */
    removeOwnRow,

    detectActiveCollectors
};
