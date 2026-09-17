/**
 * feed 单写开关。
 *
 * `feed_*` 表是**账号级**观测：同一账号的多个客户端各自轮询 / 收 WS，会看到同
 * 一事件并各自落库，产生重复行。`gamelog*` / `activity*` 是**设备级**数据，各读
 * 各机日志，天然不重复，也不受本开关影响。
 *
 * 多客户端共享同一数据库时，把其中一个节点设为 collector（写 feed），其余节点
 * 设为非 collector：它们照常采集 gamelog、照常更新 UI，只是不落 feed 行。
 *
 * 配置：VRCXStorage flat 键 `VRCX_FeedCollector`（`'true'` / `'false'`）。
 * 缺省或非法值 → collector，单机用户零影响。
 */

let enabled = true;

/**
 * 从 VRCXStorage 读取开关。启动期调用一次；之后由 isFeedCollector() 同步读缓存
 * 值（feed 写入路径是同步的，不能每次 await）。
 *
 * @returns {Promise<void>}
 */
export async function initFeedCollector() {
    try {
        const raw = String((await VRCXStorage.Get('VRCX_FeedCollector')) ?? '')
            .trim()
            .toLowerCase();
        // 只有显式否定才关闭。缺省 / 非法值 fail-safe 归 collector：最坏后果是
        // 双写（与改动前一致），而不是静默不采集。
        enabled = !(raw === 'false' || raw === '0' || raw === 'no');
    } catch (error) {
        console.error(
            '[feed] 读取 VRCX_FeedCollector 失败，按 collector 处理:',
            error
        );
        enabled = true;
    }
}

/**
 * 本节点是否负责写 feed（账号级数据）。
 *
 * @returns {boolean}
 */
export function isFeedCollector() {
    return enabled;
}
