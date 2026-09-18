/**
 * 清理 feed 表的多客户端重复写入（双写 / 多写）。
 *
 * 背景：VRCX 的 feed 数据（好友上下线、位置、简介、状态、模型）是**账号级**的，
 * 由 WebSocket / 轮询事件驱动。同一账号在多台机器上同时运行时（例如一台 24/7
 * 常驻服务器 + 一台日常桌面），两台都会收到同一条好友事件并各自落库，于是同一次
 * 事件被写了 2 份甚至多份。每台机器用**自己的时钟**打 `created_at`
 * （`nowIso()`），所以两份记录的 `created_at` 相差几秒而非全等——靠表约束无法
 * 去重。
 *
 * 本脚本按「同 user + 同事件内容 + created_at 落在时间窗内」识别重复，保留每组
 * 的第一条（最早），删除其余。
 *
 * 用法（默认干跑，只报告不删）：
 *   node build-scripts/clean-feed-duplicates.js
 *   node build-scripts/clean-feed-duplicates.js --apply
 *
 * 参数：
 *   --apply             真正执行删除（缺省只报告）
 *   --window=<秒>       重复判定时间窗，默认 60
 *   --since=<ISO 日期>  只处理该时刻之后的记录，如 --since=2026-08-01
 *   --table=<名字>      只处理某张表（可重复），如 --table=feed_gps
 *   --batch=<条数>      删除批次大小，默认 500
 *   --help
 *
 * 环境变量（优先级高于配置文件；都不设时读本机 VRCX.json）：
 *   VRCX_DB_HOST / VRCX_DB_PORT / VRCX_DB_USER / VRCX_DB_PASS / VRCX_DB_NAME
 *
 * 连接参数解析顺序：环境变量 → %APPDATA%/VRCX/VRCX.json（Linux 为
 * ~/.config/VRCX/VRCX.json）的 VRCX_Database 段 → 内置缺省。在本机运行通常
 * 零参数即可。
 *
 * 幂等：清理后窗口内不再有重复，重复执行是空操作。
 *
 * ⚠️ 删除前请自行备份数据库。本脚本只删「同一事件的多余副本」，不删事件本身。
 */

const mysql = require('mysql2/promise');

/**
 * 每张 feed 表的「事件身份列」。
 *
 * 刻意**不含**：
 *   - id / created_at —— 每个客户端各自生成（`nowIso()`）
 *   - display_name    —— 同一事件的展示名，不参与身份判定
 *   - time            —— 客户端本地推导（`ts - $location_at`），双写的两份必然不同
 *
 * **必须含** `previous_*` 系列。它们不是「本地噪音」，而是区分「同一次变更被写两遍」
 * 与「两次内容相同但确实不同的变更」的关键：真实重复要求新旧值整体一致。
 *
 * 实测依据（本库 308k 行，窗口分桶统计「同身份相邻两行间隔」）：
 *
 *   | 表                 | 0s  | 1-5s | 6-30s | 31-60s | 61-300s |
 *   |--------------------|-----|------|-------|--------|---------|
 *   | feed_gps           |  17 |   82 |    20 |      0 |    5660 |
 *   | feed_online_offline|   5 |   14 |     8 |      0 |     585 |
 *   | feed_bio           |   4 |    0 |     0 |      0 |       3 |
 *   | feed_status        |   1 |    8 |     0 |      0 |     131 |
 *   | feed_avatar        |   8 |   35 |    10 |      0 |    1115 |
 *
 * 30s 以下的样本**全部**出现在 2026-08 之后（多客户端上线时间）；31-60s 是一段
 * **完全空白**的隔离带；61s 以上的样本最早来自 2025-06，即单客户端时代，属于真实
 * 的不同事件。因此 60s 窗口是安全的（30s 亦可，结果相同）。
 *
 * 反例（说明为什么不能省掉 `previous_*`）：2025 年单客户端时期存在大量
 * 「同 user + 同新值 + 间隔 14~55s」的记录，例如 feed_gps 中同一用户先后从
 * `private` 和 `wrld_ed4a35...` 进入同一个世界。若身份不含 `previous_location`，
 * 这些**真实事件**会被当成重复删除——实测会多删 1316 行。
 */
const TABLE_IDENTITY = {
    feed_gps: [
        'user_id',
        'location',
        'world_name',
        'previous_location',
        'group_name'
    ],
    feed_online_offline: [
        'user_id',
        'type',
        'location',
        'world_name',
        'group_name'
    ],
    feed_bio: ['user_id', 'bio', 'previous_bio'],
    feed_status: [
        'user_id',
        'status',
        'status_description',
        'previous_status',
        'previous_status_description'
    ],
    feed_avatar: [
        'user_id',
        'owner_id',
        'avatar_name',
        'current_avatar_image_url',
        'current_avatar_thumbnail_image_url',
        'previous_current_avatar_image_url',
        'previous_current_avatar_thumbnail_image_url'
    ]
};

/**
 * 解析数据库连接参数。
 *
 * 优先级：环境变量 > 本机 VRCX 配置（%APPDATA%/VRCX/VRCX.json 或
 * ~/.config/VRCX/VRCX.json）> 内置缺省。这样在本机跑时通常零参数即可。
 *
 * @returns {{host: string, port: number, user: string, password: string, database: string}}
 */
function loadDefaults() {
    const fromFile = readVrcxConfig();
    return {
        host: process.env.VRCX_DB_HOST || fromFile?.host || '127.0.0.1',
        port: Number(process.env.VRCX_DB_PORT || fromFile?.port || 3306),
        user: process.env.VRCX_DB_USER || fromFile?.username || 'vrcx',
        password: process.env.VRCX_DB_PASS ?? fromFile?.password ?? '',
        database: process.env.VRCX_DB_NAME || fromFile?.name || 'vrcx'
    };
}

/**
 * 读取本机 VRCX 的 VRCX.json，取其中的 VRCX_Database 段。
 * 文件不存在 / 解析失败时返回 null（不报错，交给调用方回退）。
 *
 * @returns {{host?: string, port?: string|number, username?: string, password?: string, name?: string}|null}
 */
function readVrcxConfig() {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const candidates = [
        process.env.APPDATA
            ? path.join(process.env.APPDATA, 'VRCX', 'VRCX.json')
            : null,
        path.join(os.homedir(), '.config', 'VRCX', 'VRCX.json')
    ].filter(Boolean);
    for (const file of candidates) {
        try {
            if (!fs.existsSync(file)) continue;
            const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
            const cfg = JSON.parse(raw);
            if (cfg && cfg.VRCX_Database) return cfg.VRCX_Database;
        } catch {
            // 读取失败就试下一个候选
        }
    }
    return null;
}

function parseArgs(argv) {
    const opts = {
        apply: false,
        window: 60,
        since: '',
        tables: [],
        batch: 500,
        help: false
    };
    for (const arg of argv) {
        if (arg === '--apply') opts.apply = true;
        else if (arg === '--help' || arg === '-h') opts.help = true;
        else if (arg.startsWith('--window='))
            opts.window = Number(arg.slice('--window='.length));
        else if (arg.startsWith('--since='))
            opts.since = arg.slice('--since='.length);
        else if (arg.startsWith('--table='))
            opts.tables.push(arg.slice('--table='.length));
        else if (arg.startsWith('--batch='))
            opts.batch = Number(arg.slice('--batch='.length));
        else {
            console.error(`未知参数: ${arg}（--help 查看用法）`);
            process.exit(2);
        }
    }
    if (!Number.isFinite(opts.window) || opts.window < 0) {
        console.error('--window 必须是非负数字（秒）');
        process.exit(2);
    }
    if (!Number.isFinite(opts.batch) || opts.batch < 1) {
        console.error('--batch 必须是正数');
        process.exit(2);
    }
    return opts;
}

const HELP = `清理 feed 表的多客户端重复写入（默认干跑，只报告不删）

用法:
  node build-scripts/clean-feed-duplicates.js [--apply] [选项]

选项:
  --apply             真正执行删除（缺省只报告）
  --window=<秒>       重复判定时间窗，默认 60
  --since=<ISO 日期>  只处理该时刻之后的记录，如 --since=2026-08-01
  --table=<名字>      只处理某张表（可重复），如 --table=feed_gps
  --batch=<条数>      删除批次大小，默认 500
  --help              显示本帮助

环境变量: VRCX_DB_HOST VRCX_DB_PORT VRCX_DB_USER VRCX_DB_PASS VRCX_DB_NAME

⚠️ 删除前请自行备份数据库。`;

/**
 * 把 ISO 字符串转成毫秒时间戳；无法解析时返回 NaN。
 * @param {string} iso
 * @returns {number}
 */
function isoToMs(iso) {
    return Date.parse(iso);
}

/**
 * 找出某张表里可删除的重复行 id。
 *
 * 单趟扫描：按 created_at 升序遍历，用 Map<身份key, 上一次出现时间> 判断当前行是否
 * 落在上一次出现的窗口内。比较基准是**上一次出现**（不论它被保留还是删除），因此
 * 连续多份写入会被完整收敛为一条：
 *   A(t=0) A(t=40) A(t=80)，窗口 60 → 保留 t=0，删除 t=40 与 t=80。
 * 若改成「与上次保留比较」，t=80 会被保留，留下 2 份，收敛不彻底。
 *
 * 窗口 60s 有实测依据：对本库统计「同身份相邻两行」的间隔分布，31-60s 是一段
 * **完全空白**的隔离带——30s 以下的样本全部出现在 2026-08 之后（多客户端上线
 * 时间），61s 以上的样本最早来自 2025-06（单客户端时代，属真实的不同事件）。
 * 详见 TABLE_IDENTITY 上方的分桶表。
 *
 * @param {import('mysql2/promise').Connection} conn
 * @param {string} table - 完整表名（含用户前缀）
 * @param {string[]} identity - 身份列
 * @param {{window: number, since: string}} opts
 * @returns {Promise<{scanned: number, dupIds: number[], samples: Array<object>}>}
 */
async function findDuplicates(conn, table, identity, opts) {
    const where = opts.since ? ' WHERE created_at >= ?' : '';
    const args = opts.since ? [opts.since] : [];
    const [rows] = await conn.query(
        `SELECT id, created_at, ${identity.map((c) => `\`${c}\``).join(', ')} FROM \`${table}\`${where} ORDER BY created_at ASC, id ASC`,
        args
    );

    const windowMs = opts.window * 1000;
    /** @type {Map<string, number>} */
    const lastSeenAt = new Map();
    const dupIds = [];
    const samples = [];

    for (const row of rows) {
        const at = isoToMs(row.created_at);
        const key = identity.map((c) => String(row[c] ?? '')).join('\u0000');
        const prev = lastSeenAt.get(key);
        if (
            prev !== undefined &&
            Number.isFinite(at) &&
            at - prev <= windowMs
        ) {
            dupIds.push(row.id);
            if (samples.length < 3) {
                samples.push({
                    id: row.id,
                    created_at: row.created_at,
                    gapS: Math.round((at - prev) / 1000)
                });
            }
            lastSeenAt.set(key, at);
            continue;
        }
        if (Number.isFinite(at)) {
            lastSeenAt.set(key, at);
        }
    }

    return { scanned: rows.length, dupIds, samples };
}

/**
 * 分批删除给定 id。
 * @param {import('mysql2/promise').Connection} conn
 * @param {string} table
 * @param {number[]} ids
 * @param {number} batch
 * @returns {Promise<number>} 实际删除行数
 */
async function deleteByIds(conn, table, ids, batch) {
    let deleted = 0;
    for (let i = 0; i < ids.length; i += batch) {
        const chunk = ids.slice(i, i + batch);
        const [res] = await conn.query(
            `DELETE FROM \`${table}\` WHERE id IN (${chunk.map(() => '?').join(',')})`,
            chunk
        );
        deleted += Number(res.affectedRows || 0);
    }
    return deleted;
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
        console.log(HELP);
        return;
    }

    const conn = await mysql.createConnection(loadDefaults());

    const [tableRows] = await conn.query(
        "SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE '%\\_feed\\_%'"
    );
    const allTables = tableRows.map((r) => r.t);
    if (allTables.length === 0) {
        console.error('未找到 feed 表');
        await conn.end();
        process.exit(1);
    }

    const wanted = allTables.filter((t) => {
        const suffix = Object.keys(TABLE_IDENTITY).find((s) =>
            t.endsWith('_' + s)
        );
        if (!suffix) return false;
        if (opts.tables.length > 0 && !opts.tables.includes(suffix))
            return false;
        return true;
    });

    console.log(
        `模式: ${opts.apply ? '⚠️  APPLY（会删除）' : 'DRY-RUN（只报告）'}` +
            `  窗口: ${opts.window}s` +
            (opts.since ? `  since: ${opts.since}` : '') +
            `  表: ${wanted.length}/${allTables.length}`
    );
    console.log('');

    let totalDup = 0;
    let totalScanned = 0;
    for (const table of wanted) {
        const suffix = Object.keys(TABLE_IDENTITY).find((s) =>
            table.endsWith('_' + s)
        );
        const identity = TABLE_IDENTITY[suffix];
        const { scanned, dupIds, samples } = await findDuplicates(
            conn,
            table,
            identity,
            opts
        );
        totalScanned += scanned;
        totalDup += dupIds.length;

        let deleted = 0;
        if (opts.apply && dupIds.length > 0) {
            deleted = await deleteByIds(conn, table, dupIds, opts.batch);
        }
        console.log(
            `${table}\n  扫描 ${scanned}  重复 ${dupIds.length}` +
                (opts.apply ? `  已删除 ${deleted}` : '')
        );
        if (!opts.apply && samples.length > 0) {
            for (const s of samples) {
                console.log(
                    `    例: id=${s.id} created_at=${s.created_at} 距上一条 ${s.gapS}s`
                );
            }
        }
    }

    console.log('');
    console.log(
        `合计: 扫描 ${totalScanned}  重复 ${totalDup}` +
            (opts.apply
                ? `  已删除 ${totalDup}`
                : '  （干跑，未删除；加 --apply 执行）')
    );

    await conn.end();
}

main().catch((e) => {
    console.error('执行失败:', e.message);
    process.exit(1);
});
