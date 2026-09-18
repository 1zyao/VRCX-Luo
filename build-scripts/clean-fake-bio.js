/**
 * 清理 feed_bio 的「虚假简介变更」记录。
 *
 * 背景：2026-09 中旬 VRChat 把 `bio` 从 user 对象移到了 `profile/{userId}` 端点。
 * 未跟进该变更的旧版客户端读 `userJson.bio` 恒为空串，于是每个 InfoFetch 周期都
 * 会看到「bio 从 <真值> 变成空」并落一条记录；而已经跟进该变更的客户端读到的是
 * 真值，又把「空 → 真值」落一条。两边各自把对方刚写的那条当「上一次」，来回
 * **乒乓**，产生大量成对的无意义记录：
 *
 *   09-15 23:59  bio=""        previous_bio="砂糖：许晓浅…"   ← 旧版写空
 *   09-16 00:16  bio="砂糖…"    previous_bio=""              ← 新版写回真值
 *   09-16 00:17  bio=""        previous_bio="砂糖…"          ← 旧版又写空
 *   …
 *
 * 用户简介实际从未变过，这些记录全部是假的。
 *
 * 识别特征（三个条件任一命中即为假行）：
 *   - `bio = ''`                        —— 旧版写的空值
 *   - `previous_bio = ''`               —— 新版从空值「恢复」出来的对照行
 *   - `bio = previous_bio`              —— 无变化的写入
 * 真实的简介变更必然 `bio` 与 `previous_bio` 都非空且不相等，不会被误删。
 *
 * 用法（默认干跑，只报告不删）：
 *   node build-scripts/clean-fake-bio.js
 *   node build-scripts/clean-fake-bio.js --apply
 *
 * 参数：
 *   --apply              真正执行删除（缺省只报告）
 *   --cutoff=<ISO 日期>  只处理该时刻之后的记录，默认 2026-09-15T00:00:00.000Z
 *                        （API 变更落地、乒乓开始的时间点）
 *   --batch=<条数>       删除批次大小，默认 500
 *   --help
 *
 * 环境变量（优先级高于配置文件；都不设时读本机 VRCX.json）：
 *   VRCX_DB_HOST / VRCX_DB_PORT / VRCX_DB_USER / VRCX_DB_PASS / VRCX_DB_NAME
 *
 * 幂等：清理后再跑是空操作。
 *
 * ⚠️ 删除前请自行备份数据库。删除后每个用户的「最后一条 bio」会回落到乒乓开始
 * 之前的真实值，UI 的简介历史随之恢复正常。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const mysql = require('mysql2/promise');

const DEFAULT_CUTOFF = '2026-09-15T00:00:00.000Z';
const DEFAULT_BATCH = 500;

const HELP = `清理 feed_bio 的虚假简介变更记录（默认干跑，只报告不删）

用法:
  node build-scripts/clean-fake-bio.js [--apply] [选项]

选项:
  --apply              真正执行删除（缺省只报告）
  --cutoff=<ISO 日期>  只处理该时刻之后的记录，默认 ${DEFAULT_CUTOFF}
  --batch=<条数>       删除批次大小，默认 ${DEFAULT_BATCH}
  --help               显示本帮助

环境变量: VRCX_DB_HOST VRCX_DB_PORT VRCX_DB_USER VRCX_DB_PASS VRCX_DB_NAME

⚠️ 删除前请自行备份数据库。`;

/**
 * 解析命令行参数。
 * @param {string[]} argv
 */
function parseArgs(argv) {
    const opts = {
        apply: false,
        cutoff: DEFAULT_CUTOFF,
        batch: DEFAULT_BATCH,
        help: false
    };
    for (const arg of argv) {
        if (arg === '--apply') opts.apply = true;
        else if (arg === '--help' || arg === '-h') opts.help = true;
        else if (arg.startsWith('--cutoff=')) opts.cutoff = arg.slice(9);
        else if (arg.startsWith('--batch=')) opts.batch = Number(arg.slice(8));
        else {
            console.error('未知参数: ' + arg);
            process.exit(2);
        }
    }
    if (!Number.isFinite(Date.parse(opts.cutoff))) {
        console.error('--cutoff 不是合法日期: ' + opts.cutoff);
        process.exit(2);
    }
    if (!Number.isFinite(opts.batch) || opts.batch < 1) {
        console.error('--batch 必须是正数');
        process.exit(2);
    }
    return opts;
}

/**
 * 连接参数解析顺序：环境变量 → VRCX.json 的 VRCX_Database 段 → 内置缺省。
 * @returns {{host: string, port: number, user: string, password: string, database: string}}
 */
function resolveConnection() {
    const env = {
        host: process.env.VRCX_DB_HOST,
        port: process.env.VRCX_DB_PORT,
        user: process.env.VRCX_DB_USER,
        password: process.env.VRCX_DB_PASS,
        database: process.env.VRCX_DB_NAME
    };
    if (env.host && env.user) {
        return {
            host: env.host,
            port: Number(env.port) || 3306,
            user: env.user,
            password: env.password || '',
            database: env.database || 'vrcx'
        };
    }

    const candidates = [
        path.join(
            process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
            'VRCX',
            'VRCX.json'
        ),
        path.join(os.homedir(), '.config', 'VRCX', 'VRCX.json')
    ];
    for (const file of candidates) {
        try {
            const json = JSON.parse(
                fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
            );
            const db = json.VRCX_Database;
            if (db?.host) {
                return {
                    host: db.host,
                    port: Number(db.port) || 3306,
                    user: db.username,
                    password: db.password || '',
                    database: db.name || 'vrcx'
                };
            }
        } catch {
            // 换下一个候选
        }
    }

    return {
        host: '127.0.0.1',
        port: 3306,
        user: 'vrcx',
        password: '',
        database: 'vrcx'
    };
}

/**
 * 定位带用户前缀的 feed_bio 表。
 * @param {import('mysql2/promise').Connection} conn
 * @returns {Promise<string>}
 */
async function findBioTable(conn) {
    const [tables] = await conn.query("SHOW TABLES LIKE '%\\_feed\\_bio'");
    const names = tables.map((row) => Object.values(row)[0]);
    if (names.length === 0) {
        throw new Error('库里找不到 *_feed_bio 表');
    }
    if (names.length > 1) {
        console.warn(
            '发现多张 feed_bio 表，只处理第一张: ' + names.join(', ')
        );
    }
    return names[0];
}

/** 假行谓词 */
const FAKE_PREDICATE =
    "(bio = '' OR previous_bio = '' OR bio = previous_bio)";

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
        console.log(HELP);
        return;
    }

    const conn = await mysql.createConnection(resolveConnection());
    const table = await findBioTable(conn);
    console.log(
        (opts.apply ? '模式: APPLY（真正删除）' : '模式: DRY-RUN（只报告）') +
            '  cutoff: ' +
            opts.cutoff +
            '  表: ' +
            table
    );

    const [[total]] = await conn.query(
        `SELECT COUNT(*) c, SUM(created_at < ?) old_rows FROM \`${table}\``,
        [opts.cutoff]
    );
    const [[fake]] = await conn.query(
        `SELECT COUNT(*) c FROM \`${table}\` WHERE created_at >= ? AND ${FAKE_PREDICATE}`,
        [opts.cutoff]
    );
    const [[kept]] = await conn.query(
        `SELECT COUNT(*) c FROM \`${table}\` WHERE created_at >= ? AND NOT ${FAKE_PREDICATE}`,
        [opts.cutoff]
    );

    console.log('\n总行数: ' + total.c + '（窗口前 ' + total.old_rows + '）');
    console.log('窗口内假行: ' + fake.c + '  ← 拟删除');
    console.log('窗口内保留: ' + kept.c + '  ← 真实变更');

    const [perUser] = await conn.query(
        `SELECT user_id, COUNT(*) c FROM \`${table}\` WHERE created_at >= ? AND ${FAKE_PREDICATE} GROUP BY user_id ORDER BY c DESC LIMIT 10`,
        [opts.cutoff]
    );
    console.log('\n假行最多的 10 个用户:');
    for (const row of perUser) {
        console.log('  ' + row.user_id + '  ' + row.c + ' 行');
    }

    const [samples] = await conn.query(
        `SELECT id, created_at, LEFT(bio, 20) bio, LEFT(previous_bio, 20) prev FROM \`${table}\` WHERE created_at >= ? AND ${FAKE_PREDICATE} ORDER BY id DESC LIMIT 5`,
        [opts.cutoff]
    );
    console.log('\n样本:');
    for (const row of samples) {
        console.log(
            '  id=' +
                row.id +
                ' ' +
                row.created_at +
                '  bio=' +
                JSON.stringify(row.bio) +
                '  prev=' +
                JSON.stringify(row.prev)
        );
    }

    if (!opts.apply) {
        console.log('\n（干跑，未删除；加 --apply 执行）');
        await conn.end();
        return;
    }

    let deleted = 0;
    for (;;) {
        const [res] = await conn.query(
            `DELETE FROM \`${table}\` WHERE created_at >= ? AND ${FAKE_PREDICATE} LIMIT ${opts.batch}`,
            [opts.cutoff]
        );
        const n = Number(res.affectedRows || 0);
        deleted += n;
        if (n === 0) break;
    }
    console.log('\n已删除 ' + deleted + ' 行');

    const [[after]] = await conn.query(
        `SELECT COUNT(*) c FROM \`${table}\` WHERE created_at >= ?`,
        [opts.cutoff]
    );
    console.log('窗口内剩余: ' + after.c + ' 行');
    await conn.end();
}

main().catch((err) => {
    console.error('失败:', err.message);
    process.exit(1);
});
