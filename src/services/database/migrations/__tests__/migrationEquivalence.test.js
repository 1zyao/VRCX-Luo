/**
 * Migration equivalence tests (issue #3 Phase 7.1 + 7.3).
 *
 * Runs the REAL migration runner (`src/services/database/migrations/index.js`
 * `runMigrations`) against a REAL in-memory SQLite database (Node built-in
 * `node:sqlite` DatabaseSync) and verifies the post-migration state:
 *  - per-fix/per-schema-change assertions (old `tableAlter`/`tableFixes`
 *    semantics are the equivalence oracle), and
 *  - a holistic normalized-dump comparison against a committed golden
 *    fixture (`__fixtures__/v16-expected.dump`), plus
 *  - an idempotency test (running the migration twice yields an identical
 *    dump).
 *
 * Golden regeneration (local dev only — NEVER set in CI):
 *   $env:WRITE_GOLDEN='1'; npm test -- migrationEquivalence "normalized dump"
 *   Remove-Item Env:WRITE_GOLDEN
 *
 * The production `adapter` singleton is mocked with a `MemorySQLiteAdapter`
 * backed by the in-memory DatabaseSync; `configRepository` is mocked with an
 * in-memory Map. The real `.map` files and the real runner are used as-is.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GOLDEN_PATH = resolve(__dirname, '__fixtures__/v16-expected.dump');

let db;
let memAdapter;
const configStore = new Map();

// Mock the adapter singleton + factory. The runner imports `adapter` from
// `../adapter/index.js` (relative to the runner); vi.mock resolves to the
// same absolute module, so this intercepts the runner's import. The getter
// reads the live `memAdapter` (set in beforeEach) lazily.
vi.mock('../../adapter/index.js', () => ({
    get adapter() {
        return memAdapter;
    },
    createAdapter: () => memAdapter
}));

// Mock configRepository. The runner imports the default export and calls
// `setInt`/`getInt` for version checkpoints.
vi.mock('../../../config.js', () => ({
    default: {
        setInt: vi.fn(async (k, v) => {
            configStore.set(k, String(v));
        }),
        getInt: vi.fn(async (k, d) =>
            configStore.has(k) ? Number(configStore.get(k)) : d
        )
    }
}));

// Import the runner AFTER mocks (vitest hoists vi.mock above imports).
import { runMigrations } from '../index.js';

beforeEach(async () => {
    configStore.clear();
    const { DatabaseSync } = await import('node:sqlite');
    const { MemorySQLiteAdapter } = await import('./memoryAdapter.js');
    const { buildPreV16Fixture } = await import('./preV16Fixture.js');
    db = new DatabaseSync(':memory:');
    buildPreV16Fixture(db);
    memAdapter = new MemorySQLiteAdapter(db);
});

afterEach(() => {
    try {
        db?.close();
    } catch {
        /* ignore close errors */
    }
    db = undefined;
    memAdapter = undefined;
});

// ── Direct query helpers (bypass the adapter; read straight from the DB) ──

function allRows(table, cols = '*') {
    return db.prepare(`SELECT ${cols} FROM "${table}"`).all();
}

function columnsOf(table) {
    return db
        .prepare(`PRAGMA table_info("${table}")`)
        .all()
        .map((r) => r.name);
}

function indexesOn(table) {
    return db
        .prepare(
            "SELECT name, tbl_name FROM sqlite_schema WHERE type='index' AND tbl_name=?"
        )
        .all(table);
}

const PREFIXES = ['userA1', 'userB2'];

// ── Schema equivalence ───────────────────────────────────────────────────

describe('v16 migration — schema equivalence', () => {
    test('SC1/SC2: adds group_name to *_feed_gps and *_feed_online_offline (both prefixes)', async () => {
        await runMigrations(0, 16);
        for (const p of PREFIXES) {
            expect(columnsOf(`${p}_feed_gps`)).toContain('group_name');
            expect(columnsOf(`${p}_feed_online_offline`)).toContain(
                'group_name'
            );
            // existing rows get the DEFAULT '' value
            for (const r of allRows(`${p}_feed_gps`)) {
                expect(r.group_name).toBe('');
            }
            for (const r of allRows(`${p}_feed_online_offline`)) {
                expect(r.group_name).toBe('');
            }
        }
    });

    test('SC3: gamelog_location.group_name backfilled from groupName; groupName column dropped', async () => {
        await runMigrations(0, 16);
        const cols = columnsOf('gamelog_location');
        expect(cols).toContain('group_name');
        expect(cols).not.toContain('groupName');
        const rows = allRows('gamelog_location', 'id, group_name');
        const byId = new Map(rows.map((r) => [r.id, r.group_name]));
        expect(byId.get(1)).toBe('OldGroup'); // backfilled
        expect(byId.get(2)).toBe(''); // groupName was NULL -> default ''
        expect(byId.get(3)).toBe('SoloGroup'); // backfilled
    });

    test('SC4/SC5: adds friend_number to *_friend_log_current and *_friend_log_history (both prefixes)', async () => {
        await runMigrations(0, 16);
        for (const p of PREFIXES) {
            expect(columnsOf(`${p}_friend_log_current`)).toContain(
                'friend_number'
            );
            expect(columnsOf(`${p}_friend_log_history`)).toContain(
                'friend_number'
            );
            for (const r of allRows(`${p}_friend_log_current`)) {
                expect(r.friend_number).toBe(0);
            }
            for (const r of allRows(`${p}_friend_log_history`)) {
                expect(r.friend_number).toBe(0);
            }
        }
    });

    test('SC6: adds time to *_avatar_history (both prefixes)', async () => {
        await runMigrations(0, 16);
        for (const p of PREFIXES) {
            expect(columnsOf(`${p}_avatar_history`)).toContain('time');
            for (const r of allRows(`${p}_avatar_history`)) {
                expect(r.time).toBe(0);
            }
        }
    });

    test('SC7-SC10: creates the 4 gamelog indexes', async () => {
        await runMigrations(0, 16);
        const locIdx = indexesOn('gamelog_location').map((r) => r.name);
        const jlIdx = indexesOn('gamelog_join_leave').map((r) => r.name);
        expect(locIdx).toContain('idx_gamelog_location_world_created');
        expect(jlIdx).toContain('idx_gamelog_jl_location');
        expect(jlIdx).toContain('idx_gamelog_jl_user_created');
        expect(jlIdx).toContain('idx_gamelog_jl_display_created');
    });

    test('SC11: creates a user_id index on BOTH *_friend_log_history tables (F2 fix)', async () => {
        await runMigrations(0, 16);
        for (const p of PREFIXES) {
            const idx = indexesOn(`${p}_friend_log_history`);
            expect(
                idx,
                `expected a user_id index on ${p}_friend_log_history`
            ).toHaveLength(1);
            // F2 fix: name auto-generated as ${table}_user_id_idx
            expect(idx[0].name).toBe(`${p}_friend_log_history_user_id_idx`);
        }
    });
});

// ── Data-fix equivalence ─────────────────────────────────────────────────

describe('v16 migration — data-fix equivalence', () => {
    test('D1: deletes post-2022-05-04 Veteran<->Trusted Legend swaps only', async () => {
        await runMigrations(0, 16);
        for (const p of PREFIXES) {
            const rows = allRows(
                `${p}_friend_log_history`,
                'id, trust_level, previous_trust_level, created_at'
            );
            const byId = new Map(rows.map((r) => [r.id, r]));
            // rows 1 & 2: post-cutoff Veteran<->Trusted swap -> deleted
            expect(byId.has(1)).toBe(false);
            expect(byId.has(2)).toBe(false);
            // row 3: pre-cutoff (2022-01-01) -> kept even though it's the swap pair
            expect(byId.has(3)).toBe(true);
            // row 4: Veteran/NUser (not the swap pair) -> kept
            expect(byId.has(4)).toBe(true);
        }
    });

    test('D2: zeroes negative gps time; leaves non-negative untouched', async () => {
        await runMigrations(0, 16);
        for (const p of PREFIXES) {
            const rows = allRows(`${p}_feed_gps`, 'id, time');
            rows.sort((a, b) => a.id - b.id);
            expect(rows.map((r) => r.time)).toEqual([0, 10, 0]);
        }
    });

    test('D3: deletes notifications whose type contains a dot', async () => {
        await runMigrations(0, 16);
        for (const p of PREFIXES) {
            const rows = allRows(`${p}_notifications`, 'id, type');
            // after the full migration no row may have a dotted type
            for (const r of rows) {
                expect(r.type).not.toMatch(/\./);
            }
            const ids = rows.map((r) => r.id);
            // dotted-type rows are gone
            expect(ids).not.toContain('n1');
            expect(ids).not.toContain('n2');
            // a non-dot groupChange row (after cutoff) survives the full run
            expect(ids).toContain('n3');
        }
    });

    test('D4: deletes notifications with null/empty created_at', async () => {
        await runMigrations(0, 16);
        for (const p of PREFIXES) {
            const rows = allRows(`${p}_notifications`, 'id, created_at');
            const ids = rows.map((r) => r.id);
            expect(ids).not.toContain('n4'); // null created_at
            expect(ids).not.toContain('n5'); // '' created_at
            expect(ids).toContain('n6'); // valid created_at
            for (const r of rows) {
                expect(r.created_at).not.toBe(null);
                expect(r.created_at).not.toBe('');
            }
        }
    });

    test('D5: deletes groupChange notifications before 2024-04-23T03:00:00Z', async () => {
        await runMigrations(0, 16);
        for (const p of PREFIXES) {
            const rows = allRows(`${p}_notifications`, 'id, created_at, type');
            const ids = rows.map((r) => r.id);
            expect(ids).not.toContain('n7'); // 2024-01-01 groupChange, before cutoff
            expect(ids).toContain('n3'); // 2024-05 groupChange, after cutoff
            expect(ids).toContain('n8'); // 2024-05 groupChange, after cutoff
        }
    });

    test('D6: fixes CancelFriendRequst typo to CancelFriendRequest (no quotes) (F1 fix)', async () => {
        await runMigrations(0, 16);
        for (const p of PREFIXES) {
            const rows = allRows(`${p}_friend_log_history`, 'id, type');
            const types = rows.map((r) => r.type);
            // the previously-misspelled row is now exactly CancelFriendRequest
            expect(types).toContain('CancelFriendRequest');
            // NO row stores the value WITH surrounding single quotes
            expect(types).not.toContain("'CancelFriendRequest'");
            // already-correct rows unchanged
            const byId = new Map(rows.map((r) => [r.id, r.type]));
            expect(byId.get(5)).toBe('CancelFriendRequest');
            expect(byId.get(6)).toBe('CancelFriendRequest');
            expect(byId.get(7)).toBe('FriendRequest');
        }
    });

    test('D7: rewrites traveling OnPlayerLeft location from latest matching OnPlayerJoined', async () => {
        await runMigrations(0, 16);
        const rows = allRows(
            'gamelog_join_leave',
            'id, display_name, location'
        );
        const byId = new Map(rows.map((r) => [r.id, r]));
        // Alice: joined wrld_abc:12345 then left "traveling" -> backfilled
        expect(byId.get(11).location).toBe('wrld_abc:12345');
        // Dave: left "traveling" with no matching join -> unchanged
        expect(byId.get(12).location).toBe('traveling');
    });

    test('D8: zeroes OnPlayerLeft time exceeding per-location SUM only for known locations (F3 fix)', async () => {
        await runMigrations(0, 16);
        const rows = allRows('gamelog_join_leave', 'id, location, time');
        const byId = new Map(rows.map((r) => [r.id, r]));
        // wrld_xyz:1 SUM(time)=300; Eve 500>300 -> 0
        expect(byId.get(13).time).toBe(0);
        // Fay 150<300 -> unchanged
        expect(byId.get(14).time).toBe(150);
        // Gus: location wrld_nogamelog:1 has NO gamelog_location rows.
        // F3 EXISTS guard -> not zeroed (matches old getGameLogInstancesTime
        // Map-guard behavior where unknown locations are skipped).
        expect(byId.get(15).time).toBe(50);
    });

    test('D9: strips " (" suffix from display_name', async () => {
        await runMigrations(0, 16);
        const rows = allRows('gamelog_join_leave', 'id, display_name');
        const byId = new Map(rows.map((r) => [r.id, r.display_name]));
        expect(byId.get(16)).toBe('Bob'); // "Bob (old)" -> "Bob"
        expect(byId.get(17)).toBe('Charlie'); // no suffix -> unchanged
        expect(byId.get(18)).toBe(''); // " (leading)" -> ""
    });
});

// ── Holistic dump + idempotency ──────────────────────────────────────────

describe('v16 migration — holistic dump + idempotency', () => {
    test('normalized dump matches committed golden', async () => {
        const { normalizeDump } = await import('./dumpNormalizer.js');
        await runMigrations(0, 16);
        const actual = normalizeDump(db);
        if (process.env.WRITE_GOLDEN === '1') {
            writeFileSync(GOLDEN_PATH, actual, 'utf8');
            return; // do not assert on the write path
        }
        const expected = readFileSync(GOLDEN_PATH, 'utf8');
        // Normalize line endings — golden file may have CRLF on Windows checkout
        expect(actual.replace(/\r\n/g, '\n')).toBe(expected.replace(/\r\n/g, '\n'));
    });

    test('idempotent: running runMigrations(0,16) twice yields an identical dump', async () => {
        const { normalizeDump } = await import('./dumpNormalizer.js');
        await runMigrations(0, 16);
        const first = normalizeDump(db);
        await runMigrations(0, 16);
        const second = normalizeDump(db);
        expect(second).toBe(first);
    });
});

// ── v17: node_registry ───────────────────────────────────────────────────

describe('v17 migration — node_registry', () => {
    test('creates node_registry with full columns and node_id primary key', async () => {
        await runMigrations(0, 17);
        const cols = columnsOf('node_registry');
        expect(cols).toEqual(
            expect.arrayContaining([
                'node_id',
                'mode',
                'prefixes',
                'heartbeat_at'
            ])
        );
        const pk = db
            .prepare(`PRAGMA table_info("node_registry")`)
            .all()
            .filter((c) => c.pk === 1);
        expect(pk.map((c) => c.name)).toEqual(['node_id']);
    });

    test('upgrades an existing v16 database idempotently', async () => {
        await runMigrations(0, 16);
        const { normalizeDump } = await import('./dumpNormalizer.js');
        const before = normalizeDump(db);

        await runMigrations(16, 17);
        const first = normalizeDump(db);
        await runMigrations(16, 17);
        const second = normalizeDump(db);

        expect(second).toBe(first);
        expect(columnsOf('node_registry')).toContain('node_id');
        // v16 → v17 adds node_registry without touching existing tables
        expect(first).not.toBe(before);
    });
});
