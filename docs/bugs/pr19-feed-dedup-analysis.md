# PR #19 相关：跨客户端 Feed 去重逻辑对比分析

> 生成日期：2026-08-24
> 用途：供后续独立对话继续讨论 PR #19 与本地去重逻辑的合并/对齐。
> 相关：PR #19（draft）、PR #26（browse 侧 value 修复）、PR #35（main 侧 value 修复）。

---

## 1. PR #19 元信息

| 项 | 值 |
|---|---|
| 标题 | `fix: dedupe cross-client feed writes and sync feed on external writes` |
| 状态 | **draft**（草稿） |
| base / head | `main` ← `fix/feed-dedup-sync`（`2c477e9`） |
| commits | 2 |
| 改动文件 | 7 |

**PR #19 改动文件清单：**

```
src/services/database/adapter/MySQLAdapter.js    (+23)
src/services/database/adapter/PgSQLAdapter.js    (+14)
src/services/database/adapter/SQLiteAdapter.js   (+12)
src/services/database/feed.js                    (+200/-79)
src/services/database/friendLogHistory.js        (+24/-14)
src/stores/feed.js                               (+38/-3)
src/types/globals.d.ts                           (+2/-2)
```

---

## 2. 本地现状（feat/browse-mode 工作区，含未提交改动）

本地去重逻辑位于（**未提交**，属协作者进行中工作）：

- `src/services/database/feed.js` — `FEED_DEDUP_WINDOW_MS`、`hasRecentDuplicate()`、`dedupInsert()`（均**导出**）
- `src/services/database/friendLogHistory.js` — `import { dedupInsert } from './feed.js'` 复用
- `src/services/database/adapter/MySQLAdapter.js` / `PgSQLAdapter.js` / `SQLiteAdapter.js` — 三个引擎的 feed `user_id` 索引
- `src/services/database/EngineAdapter.js`、`src/stores/feed.js`、`src/coordinators/userEventCoordinator.js` 等（配套改动）

---

## 3. 核心设计（两者相同）

跨客户端双写去重：

1. **预检窗口**：写 feed 前查目标表最近 `FEED_DEDUP_WINDOW_MS`（**120s**）内是否存在"除 `created_at`/`time` 外内容全等"的行。
2. **加锁读**：MySQL 用 `SELECT ... FOR UPDATE` 对同一 `user_id` 的行/间隙加锁 → 两个客户端对同一事件的"查+插"串行化，后到者能查到先到者已写入的行而跳过。
3. **索引支撑**：`FOR UPDATE` 需要 `feed_gps/feed_status/feed_bio/feed_avatar` 的 `user_id` 普通非唯一索引。
4. SQLite 文件锁天然串行写、不支持 `FOR UPDATE`，走普通 `selectWhere` 查询。
5. fail-open：预检/事务异常回退直接 `insert`，不因去重逻辑丢失真实事件（最坏多写一行重复）。

---

## 4. 差异对比（本地 ≠ PR #19）

| 维度 | 本地（feat/browse-mode） | PR #19 |
|---|---|---|
| **去重入口** | 统一导出 `dedupInsert(table, data)`，feed 各 add\* 与 `friendLogHistory.js` 复用 | 各 `add*` 方法内联 `withTransaction` + 预检，无共享 helper |
| **`FEED_DEDUP_WINDOW_MS` / `hasRecentDuplicate`** | **导出**（`export const` / `export async function`） | 模块**私有**（`const` / `async function`，不导出） |
| **PG 加锁读** | `hasRecentDuplicate` 对 `mysql \|\| postgresql` 都走 `FOR UPDATE` | 仅 `mysql` 走 `FOR UPDATE`；PG 走普通 `selectWhere`（**无锁，竞态安全性弱**） |
| **外部写信号** | ❌ **完全没有**（命中只跳过写入；`src` 下无 `onFeedExternalWrite`/`notifyFeedExternalWrite`/`feedExternalWriteHandlers`） | ✅ `onFeedExternalWrite()` / `notifyFeedExternalWrite()` / `feedExternalWriteHandlers` Set——预检命中（判定另一客户端已写入）时**通知 feed store 刷新**，实现"外部写立即可见"（PR19 标题的后半句 sync feed on external writes） |
| **调用方式** | 统一 `dedupInsert`（`withTransaction` + 预检 + `insert 'ignore'`，fail-open catch） | 每个 `add*` 各自 `withTransaction` + 内联预检 + try/catch |

**关键差异点（代码级）：**

- PR #19 的 `hasRecentDuplicate` 在命中分支会调用 `notifyFeedExternalWrite()`；本地的 `hasRecentDuplicate` 命中仅返回 `true`。
- PR #19 的 `FEED_DEDUP_WINDOW_MS` 为模块私有 `const`；本地为 `export const`。
- PR #19 的 `hasRecentDuplicate` 引擎判断 `adapter.engineType === 'mysql'`；本地为 `=== 'mysql' || === 'postgresql'`。

---

## 5. 结论

本地是 PR #19 思路的**重构/演进版**：

- ✅ 统一成 `dedupInsert` helper、`FOR UPDATE` 扩展到 PG（更优的竞态安全）。
- ❌ **砍掉了 PR19 的"外部写信号"机制**——如果需求是"另一客户端写入后本端 feed 立即刷新显示"，本地目前缺失，需要从 PR #19 移植 `onFeedExternalWrite` 到本地。

两者**同源但不等价**，不能直接视为同一实现。

---

## 6. 待决策 / 开放问题

1. **是否移植外部写信号**：本地是否需要 PR19 的 `onFeedExternalWrite`（命中→feed store 刷新）？若要，需要连带改 `stores/feed.js`（订阅 + 刷新逻辑）。
2. **PR #19 与本地关系**：PR #19 是 draft、base=main；本地这套在 feat/browse-mode（未提交）。最终应合并哪套？以谁为主？
3. **feed 索引重复**：三引擎 adapter 的 `user_id` 索引在本地与 PR #19 逐字重复（review bot 已指出）。PR #26 曾误提交 MySQLAdapter 部分，已拆出。需确认归属（PR #19 或单独 PR）。
4. **PG FOR UPDATE 语义**：本地对 PG 用 `FOR UPDATE` 走 `withTransaction`，需确认 PgSQLAdapter 事务/间隙锁语义正确、索引足够。
5. **120s 窗口**：实测多客户端轮询偏差 30~120s；窗口是否合适、是否需可配置。
6. **friendLogHistory 去重**：本地复用 `dedupInsert` 覆盖 friendLogHistory，PR #19 对 friendLogHistory 是独立改动（+24/-14），需对比两者对 friendLogHistory 的处理是否一致。
7. **对 main 的对齐**：本地基于 feat/browse-mode，PR #19 基于 main；两边 base 差异大，合并前需明确 rebase 方向。

---

## 7. 相关文件路径速查

```
src/services/database/feed.js              # 去重核心：FEED_DEDUP_WINDOW_MS / hasRecentDuplicate / dedupInsert
src/services/database/friendLogHistory.js   # 复用 dedupInsert
src/services/database/adapter/MySQLAdapter.js   # feed user_id 索引（initUserSchema）
src/services/database/adapter/PgSQLAdapter.js   # feed user_id 索引（initUserSchema）
src/services/database/adapter/SQLiteAdapter.js  # feed user_id 索引（initUserSchema）
src/stores/feed.js                          # PR19 中订阅外部写信号刷新
src/services/database/EngineAdapter.js      # 本地配套（onTableChange 等）
```

> 参考链接：
> - PR #19：https://github.com/VRChatCN-Kipfel/VRCX-K/pull/19
> - PR #26（browse 侧 value 修复）：https://github.com/VRChatCN-Kipfel/VRCX-K/pull/26
> - PR #35（main 侧 value 修复）：https://github.com/VRChatCN-Kipfel/VRCX-K/pull/35
> - issue #33（main 待跟进）：VRChatCN-Kipfel/VRCX-K/issues/33
