using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Data.SQLite;
using System.Diagnostics;
using System.IO;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Reflection;

namespace VRCX
{
    public class SQLite : IAuthStore
    {
        public static SQLite Instance;
        private string _connectionString;
        private bool _initialized;

        /// <summary>
        /// 数据库变更通知(写漏斗):进程内任何写提交后触发,负载 JSON 字符串
        /// `{ conn, table, count, ts, dv }`(dv 仅主库有值,来自专用观察连接)。
        /// 检测语义:事件只是失效提示(invalidate hint),不是数据管道——
        /// 消费方应自行按需重查;漏事件由 data_version 兜底轮询补上。
        /// 详见 docs/architecture/ADAPTER_API.md §9。
        /// </summary>
        public event Action<string>? DatabaseChanged;

        private Action<string>? _changeCallback;

        /// <summary>
        /// Electron 反向通道:node-api-dotnet 以 JS 函数作 .NET delegate
        /// 注册变更回调。回调经 JSSynchronizationContext 自动
        /// 编组回 JS 主线程;发射路径无 ConfigureAwait(false),编组失败
        /// 静默——完备层计数器轮询兜底。
        /// </summary>
        public void SetChangeCallback(Action<string> callback)
        {
            _changeCallback = callback;
        }

        private volatile bool _changeEnabled;

        /// <summary>
        /// 变更通知门控:JS 侧在首个 onTableChange 订阅时开启、最后一个退订时关闭。
        /// 无消费者时 EmitChange 首行早退,写路径零开销——桥绑定(CefSharp
        /// add_DatabaseChanged / Electron SetChangeCallback)不再等于"恒有消费者"。
        /// volatile:事件回调线程与 JS 调用线程可能不同。旧桥缺此方法 → 事件恒发,
        /// 行为同现状。
        /// </summary>
        public void SetChangeEnabled(bool enabled)
        {
            _changeEnabled = enabled;
        }

        // ── Pool metrics (三态连接池监控,Issue #14) ───────────────────────
        private int _totalBorrowed;
        private int _peakBorrowed;
        private int _activeCount;
        private int _pinnedActive;
        private int _maxPoolSize;
        private DateTime _lastHealthCheck;

        // ── Transaction pinning ────────────────────────────────────────────
        // 与 PostgreSQL.cs / MySQL.cs 对称:_pinned Map 持有借出的连接,
        // sliding Timer 防泄漏。connId 有值时 Execute/ExecuteNonQuery 走
        // pinned 连接 + 重置 Timer;无值时走池自动派发。
        // System.Data.SQLite 通过连接字符串 `Pooling=True` 启用 ADO.NET
        // 池化,每次 `new SQLiteConnection(connStr)` + `Open()` 借池中连接,
        // `Dispose()` 还池。SQLite 文件锁串行化写操作,池化的主要收益
        // 是事务期间其他查询走独立连接(不被事务阻塞)。
        private readonly object _txLock = new();
        private readonly ConcurrentDictionary<long, TxHolder> _pinned = new();
        private long _nextConnId;
        private const int TX_IDLE_MS = 60000;

        // ── SQLITE_BUSY 重试策略 (Issue: database is locked) ─────────────
        // WAL 模式下写写仍串行,并发写竞争时 busy_timeout=5000 先等 5s 后抛
        // BUSY。重试机制作为第二道防线,指数退避消化短时锁争用。
        private const int MaxRetryAttempts = 5;
        private const int RetryBaseDelayMs = 50;
        private const int RetryMaxDelayMs = 2000;
        private static readonly Random _retryRandom = new();

        // ── Ad-hoc connection cache ────────────────────────────────────────
        // ExecuteJsonOnConnection / ExecuteNonQueryOnConnection 用于外部 SQLite
        // 文件操作 (push 源 / pull 目标)。当前每次调用 new SQLiteConnection 再
        // Dispose,导致迁移期间同一文件被开关数千次。此缓存按 connectionString
        // 复用已打开连接,消除重复 Open/Close 开销。连接进程级存活,不回收。
        // System.Data.SQLite 的连接池(Pooling=True)是在同进程同连接串内复用
        // 物理连接;此缓存跳过 `new → Open → Close → Dispose` 的分配开销,
        // 让同一连接串的所有 Execute*OnConnection 调用共享一条物理连接。
        // CEF 消息泵串行化 JS 调用,无需额外加锁。
        private static readonly ConcurrentDictionary<string, SQLiteConnection> ConnectionCache = new();

        private sealed class TxHolder
        {
            public SQLiteConnection Conn = null!;
            public Timer Timer = null!;
            /// <summary>
            /// 正在执行 SQL 的计数。所有读写都在 _txLock 内,锁提供
            /// happens-before,无需 Interlocked/volatile。OnTxTimeout
            /// 检测到 InFlight &gt; 0 时不立即回滚,设 TimedOut 标记让
            /// ExecutePinned 的 finally 自行清理,避免 SQL 执行期间
            /// Dispose 连接。
            /// </summary>
            public int InFlight;
            /// <summary>OnTxTimeout 已来过,等 SQL 执行完由 finally 清理。</summary>
            public bool TimedOut;
            /// <summary>事务内累积的表级写计数,COMMIT 成功后按表发射;回滚/超时丢弃。</summary>
            public Dictionary<string, int>? Changes;
            /// <summary>事务所属连接标识:"default"(主池)或外部 connectionString。</summary>
            public string? ConnLabel;
        }

        private static readonly Dictionary<string, string> DefaultOptions = new()
        {
            { "locking_mode", "NORMAL" },
            { "busy_timeout", "5000" },
            { "journal_mode", "WAL" },
            { "optimize", "0x10002" },
        };

        /// <summary>
        /// PRAGMA keys related to SQLite database encryption.
        /// These MUST NOT be settable via VRCX_Database.options.* to prevent
        /// unauthorized keying/re-keying of the database through config injection.
        /// Covers SEE (SQLite Encryption Extension) pragmas + the System.Data.SQLite
        /// built-in `key`/`rekey` aliases.
        /// </summary>
        private static readonly HashSet<string> ForbiddenPragmaKeys = new(StringComparer.OrdinalIgnoreCase)
        {
            "key", "rekey", "hexkey", "hexrekey",
            "textkey", "textrekey",
            "hexdbkey", "hexrekey_md5", "hexkey_md5",
        };

        /// <summary>
        /// Characters forbidden in PRAGMA values because they can alter the
        /// SQLite connection string structure when concatenated directly.
        /// ';' delimits connection parameters, quotes alter parsing, newlines
        /// can cause line-injection, and '\0' can truncate the native string
        /// at the P/Invoke boundary.
        /// </summary>
        private static readonly char[] ForbiddenPragmaChars = { ';', '\'', '"', '\n', '\r', '\0' };

        /// <summary>
        /// Allowlist pattern for PRAGMA key names. Keys must consist only of
        /// ASCII letters, digits, and underscores — this prevents any
        /// connection-string-injection via the key (e.g. "foo;PRAGMA rekey").
        /// Applied in SanitizePragmaValue BEFORE the ForbiddenPragmaKeys
        /// blacklist so that crafted keys like " key" or "key;x" are rejected
        /// before the blacklist lookup.
        /// </summary>
        private static readonly System.Text.RegularExpressions.Regex AllowedPragmaKeyPattern =
            new System.Text.RegularExpressions.Regex("^[A-Za-z0-9_]+$",
                System.Text.RegularExpressions.RegexOptions.Compiled);

        /// <summary>
        /// File extensions permitted for the SQLite database file.
        /// Case-insensitive. Kept static to avoid per-call allocation.
        /// </summary>
        private static readonly HashSet<string> AllowedDatabaseExtensions = new(StringComparer.OrdinalIgnoreCase)
        {
            ".db", ".db3", ".sqlite3"
        };

        /// <summary>
        /// Windows reserved device names that must never be used as a filename.
        /// Case-insensitive. Kept static to avoid per-call allocation.
        /// </summary>
        private static readonly HashSet<string> ReservedDeviceNames = new(StringComparer.OrdinalIgnoreCase)
        {
            "CON", "PRN", "AUX", "NUL",
            "COM1", "COM2", "COM3", "COM4", "COM5",
            "COM6", "COM7", "COM8", "COM9",
            "LPT1", "LPT2", "LPT3", "LPT4", "LPT5",
            "LPT6", "LPT7", "LPT8", "LPT9"
        };

        static SQLite()
        {
            Instance = new SQLite();
        }

        public SQLite()
        {
        }

        public void Init()
        {
#if LINUX
            Instance = this;
#endif
            var name = VRCXStorage.Instance.Get("VRCX_Database.name");
            var dataSource = ValidateAndCanonicalizeDatabasePath(name);

            var dir = Path.GetDirectoryName(dataSource);
            if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir))
            {
                Directory.CreateDirectory(dir);
            }

            var mergedOptions = CollectOptions();
            var parts = new List<string>
            {
                $"Data Source=\"{dataSource}\"",
                "Version=3",
                // ADO.NET 池化:System.Data.SQLite 在连接字符串含 Pooling=True
                // 时启用连接池。每次 new SQLiteConnection(connStr) + Open()
                // 借池中连接,Dispose() 还池。与 Npgsql/MySqlConnector 对称。
                //
                // System.Data.SQLite 池没有 idle timeout 参数(不像 MySQL
                // ConnectionIdleTimeout=300),连接一旦创建就常驻到进程退出。
                // 这在桌面单用户场景下可接受:本地文件无网络开销,100 连接
                // 上限实际用不到(< 5 活跃),每连接约 2MB page cache + 2-3
                // 文件句柄,驻留开销远低于服务器场景。若未来改多用户/服务端
                // 部署,应重新评估。
                //
                // ── Min Pool Size 对称性:PG/MySQL 都显式设了 MinimumPoolSize=1
                // 保活,确保挂机数小时后下次查询不必重建连。System.Data.SQLite
                // 的池不支持 Min Pool Size 参数(只有 Max Pool Size),但 SQLite
                // 池没有 idle timeout,首次 Open 后连接天然常驻到 ClearAllPools,
                // 效果等价于 MinPoolSize=1 保活(甚至更强,不会被 idle 回收)。
                // TODO(future):若未来迁移到 Microsoft.Data.Sqlite(支持更完整
                // 的池参数),可显式补上 Min Pool Size=1 对称。
                //
                // ── 并发写安全:池化后多个连接可能同时写同一 .db 文件,
                // SQLite 只支持一个并发写事务,竞争时其他连接阻塞等锁。
                // 通过 DefaultOptions 的三个 PRAGMA 缓解(拼入连接字符串,
                // 每个池化连接 Open 时执行):
                //   busy_timeout=5000  — 锁竞争时等 5s 而非立即抛
                //                        "database is locked",让短写事务
                //                        (ms 级)有机会完成。5s 足够桌面
                //                        场景;若仍超时说明有死锁/长事务,
                //                        应快速失败而非让 UI 卡 60s。
                //   journal_mode=WAL   — Write-Ahead Logging,读写并发,
                //                        写写串行。读不被写阻塞,写事务
                //                        持锁时间 = 单条 SQL 执行时间(几 ms)。
                //   locking_mode=NORMAL — 每条 SQL 执行完释放文件锁,不
                //                        独占。与池化目标一致(让事务外
                //                        读不被事务阻塞)。EXCLUSIVE 会
                //                        独占文件到 Exit,阻塞外部工具
                //                        (DB Browser 等)和其他进程,不采用。
                "Pooling=True",
                "Max Pool Size=16"
            };
            foreach (var (key, val) in mergedOptions)
            {
                var sanitized = SanitizePragmaValue(key, val);
                parts.Add($"PRAGMA {key}={sanitized}");
            }
            _connectionString = string.Join(";", parts);
            _maxPoolSize = 16; // 连接字符串硬编码 Max Pool Size=16
            _initialized = true;
            Debug.Assert(_maxPoolSize == 16, "_maxPoolSize must match connection string Max Pool Size");
        }

        /// <summary>
        /// Resolves the database file path from VRCX_Database.name.
        /// </summary>
        internal static string ResolveDatabasePath(string name)
        {
            if (string.IsNullOrEmpty(name))
                return Program.ConfigLocation;

            // Has path separators → treat as absolute or relative path
            if (name.Contains('/') || name.Contains('\\'))
                return name;

            // Bare drive letter (e.g. "C:") → treat as root of that drive
            if (name.Length == 2 && name[1] == ':' && char.IsLetter(name[0]))
                return name + '\\';

            // Plain filename → resolve against AppDataDirectory
            return Path.Join(Program.AppDataDirectory, name);
        }

        /// <summary>
        /// Centralized path validation + canonicalization for VRCX_Database.name.
        /// This is the SINGLE entry point for path resolution — called by both
        /// Init() (C# backend) and AppApiCommon.ResolveDatabaseName (JS bridge).
        ///
        /// Validation order (deliberate):
        ///   1. Null byte rejection (before any string processing)
        ///   2. Null/whitespace → default ConfigLocation
        ///   3. Path resolution (ResolveDatabasePath)
        ///   4. Canonicalization (Path.GetFullPath)
        ///   5. Boundary check (traversal detection)
        ///   6. Filename-level checks (extension, colon, reserved name, directory)
        ///
        /// Returns the canonicalized absolute path on success.
        /// Throws InvalidOperationException on any validation failure.
        /// </summary>
        public static string ValidateAndCanonicalizeDatabasePath(string name)
        {
            // ── 0. Null-byte rejection (H-1) — MUST happen before ANY processing ──
            if (name != null && name.Contains('\0'))
            {
                throw new InvalidOperationException(
                    "VRCX_Database.name contains null (\\0) bytes — this is not allowed.");
            }

            // ── 1. Null/whitespace → default path ──
            name = name?.Trim() ?? string.Empty;
            if (string.IsNullOrEmpty(name))
                return Path.GetFullPath(Program.ConfigLocation);

            // ── 2. Resolve raw path (delegate to existing private helper) ──
            var resolved = ResolveDatabasePath(name);

            // ── 3. Canonicalize (resolves ../, ./, redundant separators, relative paths) ──
            var canonical = Path.GetFullPath(resolved);

            // ── 4. Boundary check (traversal detection — C-1) ──
            var hasSeparators = name.Contains('/') || name.Contains('\\');
            var isBareDrive = name.Length == 2 && name[1] == ':' && char.IsLetter(name[0]);

            if (!hasSeparators && !isBareDrive)
            {
                // Plain filename resolved against AppDataDirectory: verify it stays within
                var appDataCanonical = Path.GetFullPath(Program.AppDataDirectory);
                var appDataWithSep = appDataCanonical.TrimEnd(Path.DirectorySeparatorChar)
                    + Path.DirectorySeparatorChar;
                if (!canonical.StartsWith(appDataWithSep, StringComparison.OrdinalIgnoreCase))
                {
                    throw new InvalidOperationException(
                        $"VRCX_Database.name resolves to '{canonical}' which is outside " +
                        $"the allowed data directory ('{appDataCanonical}').");
                }
            }
            else
            {
                // Path with separators or bare drive: the ORIGINAL input must already be
                // an absolute path. Checking IsPathRooted on `resolved` (before GetFullPath)
                // is critical — GetFullPath makes ANY relative path absolute relative to CWD,
                // so checking IsPathRooted(canonical) would always be true and provide no
                // security. This rejects relative paths like "../../evil.db".
                if (!Path.IsPathRooted(resolved))
                {
                    throw new InvalidOperationException(
                        $"VRCX_Database.name contains path separators but is not an absolute " +
                        $"path. Relative paths with separators are not allowed. Received: '{name}'");
                }
            }

            // ── 5. Filename-level checks (extension, colon, reserved name, directory) ──
            ValidateDatabaseFile(canonical);

            return canonical;
        }

        /// <summary>
        /// Validates that the resolved database file path is usable.
        /// Throws InvalidOperationException with a clear message on any violation.
        /// </summary>
        internal static void ValidateDatabaseFile(string path)
        {
            // ── 0. Null-byte trap (defense-in-depth; primary gate is ValidateAndCanonicalizeDatabasePath) ──
            if (path.Contains('\0'))
            {
                throw new InvalidOperationException(
                    "Database path contains null (\\0) bytes — this is not allowed.");
            }

            // ── 0b. Reject embedded double-quote (prematurely closes the
            //      "Data Source" quoted value in the connection string on
            //      platforms where " is a valid filename char, e.g. Linux).
            //      On Windows the OS already forbids " in filenames, but this
            //      guard is defense-in-depth and keeps the C# side consistent
            //      with the JS adapter (which escapes " as "").
            if (path.Contains('"'))
            {
                throw new InvalidOperationException(
                    $"VRCX_Database.name resolves to '{path}' which contains " +
                    "the character '\"' — this is not allowed in a database path.");
            }

            // ── 1. Check extension ──
            var ext = Path.GetExtension(path);
            if (string.IsNullOrEmpty(ext) || !AllowedDatabaseExtensions.Contains(ext))
            {
                throw new InvalidOperationException(
                    $"VRCX_Database.name resolves to '{path}' which does not have a valid " +
                    "SQLite database extension. Allowed extensions: .db, .db3, .sqlite3");
            }

            // ── 2. Check colon in filename (Windows ADS risk / obvious misconfiguration) ──
            var fileName = Path.GetFileName(path);
            if (fileName.Contains(':'))
            {
                throw new InvalidOperationException(
                    $"VRCX_Database.name resolves to '{path}' which contains " +
                    "the character ':' in the filename — this is not allowed.");
            }

            // ── 3. Check Windows reserved device names ──
            var nameWithoutExt = Path.GetFileNameWithoutExtension(path);
            if (ReservedDeviceNames.Contains(nameWithoutExt))
            {
                throw new InvalidOperationException(
                    $"VRCX_Database.name resolves to '{path}' which uses the reserved " +
                    $"system name '{nameWithoutExt}' — this is not allowed.");
            }

            // ── 4. Check path is not an existing directory ──
            if (Directory.Exists(path))
            {
                throw new InvalidOperationException(
                    $"VRCX_Database.name resolves to '{path}' which is an existing " +
                    "directory. Please specify a file path.");
            }
        }

        /// <summary>
        /// Collects user options from VRCX_Database.options.* prefix,
        /// merges them over DefaultOptions. Keys starting with '_' are
        /// treated as comments/placeholders and never passed to SQLite.
        /// </summary>
        private static Dictionary<string, string> CollectOptions()
        {
            const string prefix = "VRCX_Database.options.";
            var userOptions = VRCXStorage.Instance.GetWithPrefix(prefix);

            var merged = new Dictionary<string, string>(DefaultOptions);
            foreach (var (key, val) in userOptions)
            {
                if (key.StartsWith("_")) continue;
                merged[key] = val;
            }
            return merged;
        }

        /// <summary>
        /// Validates a single PRAGMA key/value pair for connection string safety.
        /// Layer 1: blacklists encryption-related PRAGMA keys (key, rekey, hexkey, etc.).
        /// Layer 2: rejects values containing connection-string-injection characters
        ///          (;, ", ', or newlines).
        /// Returns the trimmed value on success.
        /// </summary>
        internal static string SanitizePragmaValue(string key, string val)
        {
            // Layer 0: enforce strict key allowlist (prevents connection-string
            // injection via the KEY, e.g. "foo;PRAGMA rekey"). Must run BEFORE
            // the ForbiddenPragmaKeys blacklist so that crafted keys like
            // " key" (leading space) or "key;x" cannot bypass the blacklist
            // lookup (which is a full-string match).
            if (string.IsNullOrEmpty(key) || !AllowedPragmaKeyPattern.IsMatch(key))
            {
                throw new InvalidOperationException(
                    $"VRCX_Database.options key '{key}' is invalid — " +
                    "PRAGMA key names must consist only of ASCII letters, digits, " +
                    "and underscores (no spaces, ';', '=', or other special characters).");
            }

            // Layer 1: blacklist forbidden keys (encryption-related)
            if (ForbiddenPragmaKeys.Contains(key))
            {
                throw new InvalidOperationException(
                    $"PRAGMA '{key}' is forbidden for security reasons. " +
                    "This key cannot be configured via VRCX_Database.options.");
            }

            // Layer 2: reject dangerous characters in values (including null bytes
            // which can truncate the native SQLite connection string).
            if (val != null && val.IndexOfAny(ForbiddenPragmaChars) >= 0)
            {
                throw new InvalidOperationException(
                    $"VRCX_Database.options.{key} contains forbidden characters " +
                    "(;, \", ', newlines, or null bytes) which are not allowed.");
            }

            return (val ?? string.Empty).Trim();
        }

        public void Exit()
        {
            _initialized = false;
            _connectionString = null;
            // 清理任何残留的 pinned 事务连接
            lock (_txLock)
            {
                foreach (var kv in _pinned)
                {
                    try { kv.Value.Timer?.Dispose(); } catch { }
                    try { kv.Value.Conn?.Dispose(); } catch { }
                }
                _pinned.Clear();
            }
            // 清空 ADO.NET 池(System.Data.SQLite 专属 API)
            try { SQLiteConnection.ClearAllPools(); } catch { }
            // 关闭专用观察连接
            lock (_observerLock)
            {
                try { _observerConn?.Dispose(); } catch { }
                _observerConn = null;
            }
        }

        // ── Health checks (与 PostgreSQL.cs / MySQL.cs 对称) ──────────────

        /// <summary>
        /// Return true when the backend has been initialised. Does not probe
        /// the file system — callers needing a real liveness check should
        /// use <see cref="Ping"/> (SELECT 1) or <see cref="GetHealth"/>.
        /// </summary>
        public bool IsConnected()
        {
            return _initialized && !string.IsNullOrEmpty(_connectionString);
        }

        /// <summary>
        /// Probe the database file with <c>SELECT 1</c> and return a JSON
        /// health snapshot: <c>{ connected, latencyMs, lastHealthCheck }</c>.
        /// </summary>
        public string GetHealth()
        {
            bool connected = IsConnected();
            long latencyMs = -1;
            if (connected)
            {
                try
                {
                    var sw = Stopwatch.StartNew();
                    var b = Interlocked.Increment(ref _totalBorrowed);
                    UpdatePeak(b);
                    try
                    {
                        using var conn = new SQLiteConnection(_connectionString);
                        conn.Open();
                        using var cmd = conn.CreateCommand();
                        cmd.CommandText = "SELECT 1";
                        cmd.ExecuteScalar();
                        sw.Stop();
                        latencyMs = sw.ElapsedMilliseconds;
                        _lastHealthCheck = DateTime.Now;
                    }
                    finally
                    {
                        Interlocked.Decrement(ref _totalBorrowed);
                    }
                }
                catch
                {
                    connected = false;
                }
            }

            var health = new
            {
                connected,
                latencyMs,
                lastHealthCheck = _lastHealthCheck == default
                    ? null
                    : _lastHealthCheck.ToString("o")
            };
            return JsonSerializer.Serialize(health);
        }

        /// <summary>
        /// Lightweight liveness probe. Returns true when <c>SELECT 1</c>
        /// succeeds against a fresh pooled connection.
        /// </summary>
        public bool Ping()
        {
            try
            {
                var b = Interlocked.Increment(ref _totalBorrowed);
                UpdatePeak(b);
                try
                {
                    using var conn = new SQLiteConnection(_connectionString);
                    conn.Open();
                    using var cmd = conn.CreateCommand();
                    cmd.CommandText = "SELECT 1";
                    cmd.ExecuteScalar();
                    _lastHealthCheck = DateTime.Now;
                    return true;
                }
                finally
                {
                    Interlocked.Decrement(ref _totalBorrowed);
                }
            }
            catch
            {
                return false;
            }
        }

        // for Electron
        public string ExecuteJson(string sql, IDictionary<string, object>? args = null, object? connId = null)
        {
            var result = Execute(sql, args, connId);
            return JsonSerializer.Serialize(result);
        }

        public object[][] Execute(string sql, IDictionary<string, object>? args = null, object? connId = null)
        {
            var typedConnId = NormalizeConnId(connId);
            if (typedConnId.HasValue)
            {
                return ExecutePinned(typedConnId.Value, sql, args);
            }
            EnsureInitialized();
            var b = Interlocked.Increment(ref _totalBorrowed);
            UpdatePeak(b);
            using var connection = new SQLiteConnection(_connectionString);
            connection.Open();
            try
            {
                Interlocked.Increment(ref _activeCount);
                try
                {
                    int affected = -1;
                    var result = ExecuteWithRetry(() =>
                    {
                        using var command = new SQLiteCommand(sql, connection);
                        if (args != null)
                        {
                            foreach (var arg in args)
                            {
                                command.Parameters.Add(new SQLiteParameter(arg.Key, arg.Value));
                            }
                        }

                        using var reader = command.ExecuteReader();
                        affected = reader.RecordsAffected;
                        var rows = new List<object[]>();
                        while (reader.Read())
                        {
                            var values = new object[reader.FieldCount];
                            for (var i = 0; i < reader.FieldCount; i++)
                            {
                                values[i] = reader.IsDBNull(i) ? null : reader.GetValue(i);
                            }
                            rows.Add(values);
                        }
                        return rows.ToArray();
                    }, "Execute(pool)");
                    var table = ExtractTable(sql);
                    if (table != null && _changeEnabled)
                    {
                        EmitChange(ChangeConnDefault, table, affected, GetDataVersion());
                    }
                    return result;
                }
                finally
                {
                    Interlocked.Decrement(ref _activeCount);
                }
            }
            finally
            {
                Interlocked.Decrement(ref _totalBorrowed);
            }
        }

        public int ExecuteNonQuery(string sql, IDictionary<string, object>? args = null, object? connId = null)
        {
            var typedConnId = NormalizeConnId(connId);
            if (typedConnId.HasValue)
            {
                return ExecuteNonQueryPinned(typedConnId.Value, sql, args);
            }
            EnsureInitialized();
            var b = Interlocked.Increment(ref _totalBorrowed);
            UpdatePeak(b);
            using var connection = new SQLiteConnection(_connectionString);
            connection.Open();
            try
            {
                Interlocked.Increment(ref _activeCount);
                try
                {
                    using var command = new SQLiteCommand(sql, connection);
                    if (args != null)
                    {
                        foreach (var arg in args)
                        {
                            command.Parameters.Add(new SQLiteParameter(arg.Key, arg.Value));
                        }
                    }
                    var affected = ExecuteWithRetry(() => command.ExecuteNonQuery(), "ExecuteNonQuery(pool)");
                    var table = ExtractTable(sql);
                    if (table != null && _changeEnabled)
                    {
                        EmitChange(ChangeConnDefault, table, affected, GetDataVersion());
                    }
                    return affected;
                }
                finally
                {
                    Interlocked.Decrement(ref _activeCount);
                }
            }
            finally
            {
                Interlocked.Decrement(ref _totalBorrowed);
            }
        }

        /// <summary>
        /// Opens a fresh connection to the specified database file (or in-memory DB),
        /// executes the given SQL, and returns the result set serialized as a JSON array.
        /// The connection is closed (and disposed) after the query completes.
        ///
        /// This does NOT touch the pooled connection — it is completely independent,
        /// intended for querying an EXTERNAL database (e.g. during migration).
        /// The caller controls read/write behaviour via the <paramref name="connectionString"/>.
        /// </summary>
        /// <param name="connectionString">Full SQLite connection string (e.g. 'Data Source="...";Version=3;').</param>
        /// <param name="sql">SQL to execute.</param>
        /// <param name="args">Optional named parameters (<c>@key → value</c>).</param>
        /// <returns>JSON array of row arrays, e.g. [["val1", 42], ["val2", 99]].</returns>
        public string ExecuteJsonOnConnection(string connectionString, string sql, IDictionary<string, object>? args = null, object? connId = null)
        {
            var nId = NormalizeConnId(connId);
            if (nId.HasValue)
            {
                var rows = ExecutePinned(nId.Value, sql, args);
                return JsonSerializer.Serialize(rows);
            }

            var connection = ConnectionCache.GetOrAdd(connectionString, cs =>
            {
                var conn = new SQLiteConnection(cs);
                conn.Open();
                return conn;
            });

            using var command = new SQLiteCommand(sql, connection);
            if (args != null)
            {
                foreach (var arg in args)
                {
                    command.Parameters.Add(new SQLiteParameter(arg.Key, arg.Value));
                }
            }

            using var reader = command.ExecuteReader();
            var result = new List<object[]>();
            while (reader.Read())
            {
                var values = new object[reader.FieldCount];
                for (var i = 0; i < reader.FieldCount; i++)
                {
                    values[i] = reader.IsDBNull(i) ? null : reader.GetValue(i);
                }
                result.Add(values);
            }

            var writeTable = ExtractTable(sql);
            if (writeTable != null && _changeEnabled)
            {
                EmitChange(connectionString, writeTable, -1, null);
            }
            return JsonSerializer.Serialize(result);
        }

        /// <summary>
        /// Opens a fresh connection to the specified database file,
        /// executes a non-query SQL (INSERT/UPDATE/DELETE/DDL), and returns the number
        /// of rows affected. The connection is closed after the query completes.
        ///
        /// This does NOT touch the pooled connection — it is completely independent.
        /// </summary>
        /// <param name="connectionString">Full SQLite connection string.</param>
        /// <param name="sql">SQL to execute.</param>
        /// <param name="args">Optional named parameters (<c>@key → value</c>).</param>
        /// <returns>Number of rows affected.</returns>
        public int ExecuteNonQueryOnConnection(string connectionString, string sql, IDictionary<string, object>? args = null, object? connId = null)
        {
            var nId = NormalizeConnId(connId);
            if (nId.HasValue)
            {
                return ExecuteNonQueryPinned(nId.Value, sql, args);
            }

            var connection = ConnectionCache.GetOrAdd(connectionString, cs =>
            {
                var conn = new SQLiteConnection(cs);
                conn.Open();
                return conn;
            });

            using var command = new SQLiteCommand(sql, connection);
            if (args != null)
            {
                foreach (var arg in args)
                {
                    command.Parameters.Add(new SQLiteParameter(arg.Key, arg.Value));
                }
            }
            var affected = ExecuteWithRetry(() => command.ExecuteNonQuery(), "ExecuteNonQuery(fresh)");
            var table = ExtractTable(sql);
            if (table != null && _changeEnabled)
            {
                EmitChange(connectionString, table, affected, null);
            }
            return affected;
        }

        /// <summary>
        /// 将 CefSharp 传入的 object? connId 规范化为 long?。
        /// 处理: null, DBNull, Missing, int, long, 整值 double。
        /// </summary>
        internal static long? NormalizeConnId(object? connId)
        {
            return connId switch
            {
                null => null,
                DBNull => null,
                Missing => null,
                int i => i,
                long l => l,
                double d when !double.IsNaN(d) && !double.IsInfinity(d)
                             && d >= long.MinValue && d <= long.MaxValue
                             && d == Math.Truncate(d) => (long)d,
                _ => throw new ArgumentException(
                    $"connId 参数必须为数值类型或 null，当前类型: {connId.GetType().Name}")
            };
        }

        /// <summary>
        /// 判断异常是否为可重试的 SQLite 错误（BUSY, LOCKED）。
        /// </summary>
        internal static bool IsRetryableSqliteException(Exception ex)
        {
            return ex is SQLiteException sqlEx &&
                   (sqlEx.ResultCode == SQLiteErrorCode.Busy ||
                    sqlEx.ResultCode == SQLiteErrorCode.Locked);
        }

        /// <summary>
        /// 执行操作，在遇到可重试 SQLite 错误时以指数退避重试。
        /// </summary>
        internal static T ExecuteWithRetry<T>(Func<T> operation, string context)
        {
            for (int attempt = 0; attempt <= MaxRetryAttempts; attempt++)
            {
                try
                {
                    return operation();
                }
                catch (Exception ex) when (IsRetryableSqliteException(ex))
                {
                    if (attempt == MaxRetryAttempts) throw;
                    var delayMs = CalculateRetryDelay(attempt + 1);
                    var resultCode = (ex is SQLiteException sqlEx) ? sqlEx.ResultCode.ToString() : "unknown";
                    Console.Error.WriteLine(
                        $"[SQLite] {context} attempt={attempt + 1}/{MaxRetryAttempts} " +
                        $"failed (ResultCode={resultCode}), retrying in {delayMs}ms...");
                    Thread.Sleep(delayMs);
                }
            }
            throw new InvalidOperationException("Unreachable");
        }

        // ── 写漏斗:表名提取与事件发射 ─────────────────────────────────
        // 表名从 SQL 语句形态提取(adapter 生成的 INSERT/UPDATE/DELETE/
        // CREATE 等语句结构固定,足够可靠);提取失败时 table=null → 不发
        // 事件(与 Execute 门控对称),由完备层计数器轮询兜底(版本前进 →
        // 全量失效)。
        private const string ChangeConnDefault = "default";

        private static readonly System.Text.RegularExpressions.Regex TableFromSqlPattern =
            new System.Text.RegularExpressions.Regex(
                @"^\s*(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|REPLACE\s+INTO|UPDATE|DELETE\s+FROM|CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?|DROP\s+TABLE(?:\s+IF\s+EXISTS)?|ALTER\s+TABLE)\s+([`""\[\]\w.-]+)",
                System.Text.RegularExpressions.RegexOptions.IgnoreCase |
                System.Text.RegularExpressions.RegexOptions.Compiled);

        private static string? ExtractTable(string sql)
        {
            if (string.IsNullOrWhiteSpace(sql)) return null;
            var m = TableFromSqlPattern.Match(sql);
            if (!m.Success) return null;
            return m.Groups[1].Value.Trim('`', '"', '[', ']');
        }

        /// <summary>
        /// 主库专用观察连接(永不用于写)——data_version 是"他写者视角"
        /// 计数器,写者连接读不到自己提交的递增,dv 快照必须读自
        /// 非写者连接才能与 JS 轮询视角一致。惰性创建,进程级存活。
        /// </summary>
        private SQLiteConnection? _observerConn;
        private readonly object _observerLock = new();

        /// <summary>
        /// 读主库观察连接的 data_version(与漏斗事件 dv 同源)。
        /// JS 完备层轮询经桥调用;旧桥缺此方法 → JS 回退池连接 PRAGMA。
        /// </summary>
        public long? GetDataVersion()
        {
            if (!_initialized) return null;
            lock (_observerLock)
            {
                try
                {
                    if (_observerConn == null)
                    {
                        _observerConn = new SQLiteConnection(_connectionString);
                        _observerConn.Open();
                    }
                    using var cmd = _observerConn.CreateCommand();
                    cmd.CommandText = "PRAGMA data_version";
                    var v = cmd.ExecuteScalar();
                    return v is null ? null : Convert.ToInt64(v);
                }
                catch
                {
                    return null;
                }
            }
        }

        private void EmitChange(string conn, string? table, int count, long? dv)
        {
            if (!_changeEnabled) return; // 无消费者零成本
            if (DatabaseChanged == null && _changeCallback == null) return; // 无订阅者,零开销
            string payload;
            try
            {
                payload = JsonSerializer.Serialize(new Dictionary<string, object?>
                {
                    ["conn"] = conn,
                    ["table"] = table,
                    ["count"] = count,
                    ["ts"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                    ["dv"] = dv
                });
            }
            catch
            {
                // 序列化失败静默:完备层计数器轮询兜底
                return;
            }
            try
            {
                DatabaseChanged?.Invoke(payload);
            }
            catch
            {
                // 事件处理器异常静默
            }
            try
            {
                _changeCallback?.Invoke(payload);
            }
            catch
            {
                // 编组失败静默:完备层计数器轮询兜底
            }
        }

        /// <summary>事务内累积表级写计数(供 COMMIT 后按表发射)。</summary>
        private static void RecordChange(TxHolder h, string? table, int count)
        {
            if (string.IsNullOrEmpty(table) || count <= 0) return;
            h.Changes ??= new Dictionary<string, int>();
            h.Changes[table] = h.Changes.GetValueOrDefault(table) + count;
        }

        /// <summary>
        /// 计算指数退避延迟（带 ±25% jitter，上限 RetryMaxDelayMs）。
        /// </summary>
        internal static int CalculateRetryDelay(int attempt)
        {
            var baseDelay = RetryBaseDelayMs * (1 << Math.Min(attempt - 1, 10));
            var capped = Math.Min(baseDelay, RetryMaxDelayMs);
            int jitter;
            lock (_retryRandom)
            {
                jitter = (int)(capped * 0.25 * (_retryRandom.NextDouble() - 0.5));
            }
            return capped + jitter;
        }

        // ── IAuthStore implementation ──────────────────────────────────────
        // SQLite 方言:命名参数 (@key/@value)、INSERT OR REPLACE upsert、
        // 反引号引用 `key`/`value`(与原 WebApi 内联 SQL 风格保持一致)。

        /// <inheritdoc />
        public void EnsureCookiesTable()
        {
            ExecuteNonQuery(
                "CREATE TABLE IF NOT EXISTS `cookies` (`key` TEXT PRIMARY KEY, `value` TEXT)");
        }

        /// <inheritdoc />
        public string? LoadCookie(string key)
        {
            var values = Execute(
                "SELECT `value` FROM `cookies` WHERE `key` = @key",
                new Dictionary<string, object> { { "@key", key } });
            return values.Length > 0 ? (string)values[0][0] : null;
        }

        /// <inheritdoc />
        public void SaveCookie(string key, string value)
        {
            ExecuteNonQuery(
                "INSERT OR REPLACE INTO `cookies` (`key`, `value`) VALUES (@key, @value)",
                new Dictionary<string, object> { { "@key", key }, { "@value", value } });
        }

        // ── Transaction pinning implementation ───────────────────────────────
        // 与 PostgreSQL.cs / MySQL.cs 对称。

        private void EnsureInitialized()
        {
            if (!_initialized || string.IsNullOrEmpty(_connectionString))
                throw new InvalidOperationException(
                    "SQLite backend not initialised. Call Init() first.");
        }

        private static SQLiteCommand CreateTxCommand(TxHolder h, string sql, IDictionary<string, object>? args)
        {
            var command = h.Conn.CreateCommand();
            command.CommandText = sql;
            if (args != null)
            {
                foreach (var arg in args)
                {
                    command.Parameters.Add(new SQLiteParameter(arg.Key, arg.Value));
                }
            }
            return command;
        }

        /// <summary>
        /// 回滚并释放一条已超时的事务连接。调用方必须持有 _txLock 且
        /// 已从 _pinned 中 TryRemove 出 holder。Timer 由调用方 Dispose。
        /// </summary>
        private static void CleanupTx(TxHolder h)
        {
            try
            {
                using var cmd = h.Conn.CreateCommand();
                cmd.CommandText = "ROLLBACK";
                cmd.ExecuteNonQuery();
            } catch { /* 可能已超时回滚 */ }
            try { h.Conn.Dispose(); } catch { }
        }

        private object[][] ExecutePinned(long connId, string sql, IDictionary<string, object>? args)
        {
            // 暂停 Timer 防止慢查询(SQL 执行中)触发超时回滚。
            // InFlight 标记让 OnTxTimeout 知道 SQL 正在跑,不立即
            // Dispose 连接,而是设 TimedOut 让本方法的 finally 自行清理。
            // TryGetValue 与 InFlight++/Timer.Change 必须在同一 _txLock 内,
            // 否则 OnTxTimeout 可能在两者之间排队看到 InFlight=0 立即清理,
            // 随后本方法拿到 h.Conn 时已被 Dispose → ObjectDisposedException,
            // 且 _activeCount/_pinnedActive 永久泄漏(finally 不执行)。
            TxHolder h;
            lock (_txLock)
            {
                if (!_pinned.TryGetValue(connId, out h))
                    throw new InvalidOperationException(
                        $"connId={connId} 已超时回滚或不存在,请重试事务");
                h.InFlight++;
                Interlocked.Increment(ref _activeCount);
                Interlocked.Increment(ref _pinnedActive);
                h.Timer.Change(Timeout.Infinite, -1);
            }
            try
            {
                int affected = -1;
                var result = ExecuteWithRetry(() =>
                {
                    using var command = CreateTxCommand(h, sql, args);
                    using var reader = command.ExecuteReader();
                    affected = reader.RecordsAffected;
                    var rows = new List<object[]>();
                    while (reader.Read())
                    {
                        var values = new object[reader.FieldCount];
                        for (var i = 0; i < reader.FieldCount; i++)
                        {
                            values[i] = reader.IsDBNull(i) ? null : reader.GetValue(i);
                        }
                        rows.Add(values);
                    }
                    return rows.ToArray();
                }, "Execute(pinned)");
                RecordChange(h, ExtractTable(sql), affected);
                return result;
            }
            finally
            {
                lock (_txLock)
                {
                    h.InFlight--;
                    Interlocked.Decrement(ref _activeCount);
                    Interlocked.Decrement(ref _pinnedActive);
                    if (h.TimedOut)
                    {
                        _pinned.TryRemove(connId, out _);
                        h.Timer.Dispose();
                        Interlocked.Decrement(ref _totalBorrowed);
                        CleanupTx(h);
                    }
                    else
                    {
                        h.Timer.Change(TX_IDLE_MS, -1);
                    }
                }
            }
        }

        private int ExecuteNonQueryPinned(long connId, string sql, IDictionary<string, object>? args)
        {
            TxHolder h;
            lock (_txLock)
            {
                if (!_pinned.TryGetValue(connId, out h))
                    throw new InvalidOperationException(
                        $"connId={connId} 已超时回滚或不存在,请重试事务");
                h.InFlight++;
                Interlocked.Increment(ref _activeCount);
                Interlocked.Increment(ref _pinnedActive);
                h.Timer.Change(Timeout.Infinite, -1);
            }
            try
            {
                using var command = CreateTxCommand(h, sql, args);
                var affected = ExecuteWithRetry(() => command.ExecuteNonQuery(), "ExecuteNonQuery(pinned)");
                RecordChange(h, ExtractTable(sql), affected);
                return affected;
            }
            finally
            {
                lock (_txLock)
                {
                    h.InFlight--;
                    Interlocked.Decrement(ref _activeCount);
                    Interlocked.Decrement(ref _pinnedActive);
                    if (h.TimedOut)
                    {
                        _pinned.TryRemove(connId, out _);
                        h.Timer.Dispose();
                        Interlocked.Decrement(ref _totalBorrowed);
                        CleanupTx(h);
                    }
                    else
                    {
                        h.Timer.Change(TX_IDLE_MS, -1);
                    }
                }
            }
        }

        /// <summary>
        /// Borrow a pooled connection, BEGIN a transaction on it, and return
        /// a connId for subsequent Execute/ExecuteNonQuery calls. A sliding
        /// idle timer auto-rolls-back after TX_IDLE_MS of inactivity.
        /// JS 侧应在事务内长时间非 DB await 前调 keepAlive() 提前续命,
        /// 而非"卡着 60s 的点回来打卡"——临近超时才发 SQL 会进入
        /// Timer 回调与 SQL 执行的竞态窗口(虽有 InFlight 防御不崩,
        /// 但事务仍会被判定超时回滚)。
        /// </summary>
        public long BeginTransaction()
        {
            EnsureInitialized();
            var connId = Interlocked.Increment(ref _nextConnId);
            var b = Interlocked.Increment(ref _totalBorrowed);
            UpdatePeak(b);
            var conn = new SQLiteConnection(_connectionString);
            conn.Open();
            var holder = new TxHolder { Conn = conn, ConnLabel = ChangeConnDefault };
            using (var beginCmd = conn.CreateCommand())
            {
                beginCmd.CommandText = "BEGIN";
                beginCmd.ExecuteNonQuery();
            }
            holder.Timer = new Timer(_ => OnTxTimeout(connId), null, TX_IDLE_MS, -1);
            _pinned[connId] = holder;
            return connId;
        }

        /// <summary>
        /// Borrow a connection to the specified external database file, BEGIN a
        /// transaction on it, and return a connId. Used by pullEngine's dstAdapter
        /// (constructed with a connectionString) so that withTransaction bodies
        /// route writes to the target file atomically. The connId enters the same
        /// _pinned Map; ExecutePinned/Commit/Rollback route by connId to h.Conn
        /// (the target connection), independent of the singleton _connectionString.
        /// Does NOT call EnsureInitialized — the target DB is independent of the
        /// singleton app DB and need not be open.
        ///
        /// 注意:外部连接串的借用计入主池 _totalBorrowed 并进 _peakBorrowed
        /// (与既有计数哲学一致),迁移完成后 peak 抬高会持续反映在
        /// GetPoolStats 的 idleInPool 上界近似,直到 ClearIdleConnections/重启。
        /// 仅迁移场景(pullEngine)使用,显示级影响,可接受。
        /// </summary>
        public long BeginTransactionOnConnection(string connectionString)
        {
            var connId = Interlocked.Increment(ref _nextConnId);
            var b = Interlocked.Increment(ref _totalBorrowed);
            UpdatePeak(b);
            var conn = new SQLiteConnection(connectionString);
            conn.Open();
            var holder = new TxHolder { Conn = conn, ConnLabel = connectionString };
            using (var beginCmd = conn.CreateCommand())
            {
                beginCmd.CommandText = "BEGIN";
                beginCmd.ExecuteNonQuery();
            }
            holder.Timer = new Timer(_ => OnTxTimeout(connId), null, TX_IDLE_MS, -1);
            _pinned[connId] = holder;
            return connId;
        }

        /// <summary>
        /// COMMIT the transaction + return connection to pool.
        /// </summary>
        public void CommitTransaction(long connId)
        {
            Dictionary<string, int>? changes;
            string connLabel;
            lock (_txLock)
            {
                if (!_pinned.TryRemove(connId, out var h))
                    throw new InvalidOperationException(
                        $"connId={connId} 已超时回滚或不存在,无法 commit");
                h.Timer.Dispose();
                try
                {
                    using var cmd = h.Conn.CreateCommand();
                    cmd.CommandText = "COMMIT";
                    cmd.ExecuteNonQuery();
                }
                finally
                {
                    Interlocked.Decrement(ref _totalBorrowed);
                    h.Conn.Dispose();
                }
                changes = h.Changes;
                connLabel = h.ConnLabel ?? ChangeConnDefault;
            }
            // 锁外发射:事件编组可能回调进本类,避免持锁重入。
            if (changes is { Count: > 0 } && _changeEnabled)
            {
                var dv = connLabel == ChangeConnDefault ? GetDataVersion() : null;
                foreach (var kv in changes)
                {
                    EmitChange(connLabel, kv.Key, kv.Value, dv);
                }
            }
        }

        /// <summary>
        /// ROLLBACK the transaction + return connection to pool. No-op if
        /// connId already timed out.
        /// </summary>
        public void RollbackTransaction(long connId)
        {
            lock (_txLock)
            {
                if (!_pinned.TryRemove(connId, out var h)) return;
                h.Timer.Dispose();
                Interlocked.Decrement(ref _totalBorrowed);
                CleanupTx(h);
            }
        }

        /// <summary>
        /// Reset the sliding idle timer for the transaction pinned to
        /// <paramref name="connId"/> without executing any SQL. Use this
        /// when the JS side needs to await a long-running non-DB operation
        /// (e.g. user confirmation dialog) inside a withTransaction block
        /// to prevent the 60s idle timeout from auto-rolling-back.
        /// </summary>
        /// <returns><c>true</c> if the timer was reset; <c>false</c> if the
        /// connId has already timed out / rolled back (no-op).</returns>
        public bool KeepAliveTransaction(long connId)
        {
            lock (_txLock)
            {
                if (_pinned.TryGetValue(connId, out var h))
                {
                    h.Timer.Change(TX_IDLE_MS, -1);
                    return true;
                }
                return false;
            }
        }

        private void OnTxTimeout(long connId)
        {
            lock (_txLock)
            {
                if (!_pinned.TryGetValue(connId, out var h)) return;
                Console.Error.WriteLine(
                    $"[SQLite] 事务 connId={connId} 空闲 {TX_IDLE_MS}ms,自动回滚");
                if (h.InFlight > 0)
                {
                    // SQL 正在执行(ExecutePinned 的 ExecuteReader 未返回),
                    // 不能现在 Dispose 连接,否则 ObjectDisposedException。
                    // 设标记,让 ExecutePinned 的 finally 检测到后自行清理。
                    h.TimedOut = true;
                    return;
                }
                _pinned.TryRemove(connId, out _);
                h.Timer.Dispose();
                Interlocked.Decrement(ref _totalBorrowed);
                CleanupTx(h);
            }
        }

        // ── Pool stats ──────────────────────────────────────────────────────

        /// <summary>
        /// CAS 循环更新 <c>_peakBorrowed</c>(Interlocked 无 Max 原语),
        /// 每次池路径借出点 Increment 后调用,记录并发借出的历史峰值。
        /// </summary>
        private void UpdatePeak(int value)
        {
            int current;
            while ((current = Volatile.Read(ref _peakBorrowed)) < value &&
                   Interlocked.CompareExchange(ref _peakBorrowed, value, current) != current) { }
        }

        /// <summary>
        /// 返回当前连接池的三态 + 扩展快照,纯内存计数器读取,不涉及网络调用。
        /// JS 侧每秒采样一次,用于底部栏三色波线展示(Issue #14)。
        ///
        /// 基础字段(所有引擎对称,JS 主用):
        ///   active            = 正在执行 SQL 的连接数(pinned + 非 pinned)
        ///   pinnedIdle        = 事务持有但未执行 SQL 的连接数
        ///   availableCapacity = 可用容量(_maxPoolSize - _totalBorrowed)
        ///   max               = 连接池上限
        ///
        /// 扩展字段(冗余校验,UI 不强依赖):
        ///   totalOpen  = 池中物理连接数的上界近似(peak-borrowed)
        ///   idleInPool = 池中空闲物理连接数的近似(peak - 当前借出)
        /// System.Data.SQLite 无任何连接池统计 API,故用连接生命周期近似:
        ///   _peakBorrowed = 自上次 ClearIdleConnections 以来并发借出的峰值
        ///                   (每个池路径借出点 Increment 后 UpdatePeak 累计)
        ///   totalOpen     = Volatile.Read(_peakBorrowed)
        ///   idleInPool    = Math.Max(0, peak - _totalBorrowed)
        /// 语义:池中空闲连接以弱引用保存,被 GC 回收不可见,故数字是"上界近似"
        /// (不小于真实常驻连接数);驱动不主动回收空闲连接(连接常驻到
        /// ClearAllPools 是有意设计),平时数字真实反映常驻连接数。
        /// 上层 JS 主用基础字段自算 idleInPool = totalOpen - active - pinnedIdle。
        /// </summary>
        public string GetPoolStats()
        {
            var active = _activeCount;
            var pinnedIdle = _pinned.Count - _pinnedActive;
            var availableCapacity = _maxPoolSize - _totalBorrowed;
            var peak = Volatile.Read(ref _peakBorrowed);
            var totalOpen = peak;
            var idleInPool = Math.Max(0, peak - _totalBorrowed);
            var stats = new
            {
                active,
                pinnedIdle,
                availableCapacity,
                max = _maxPoolSize,
                totalOpen,
                idleInPool
            };
            return JsonSerializer.Serialize(stats);
        }

        /// <summary>
        /// Clear idle connections from the pool. System.Data.SQLite's
        /// ClearAllPools() only drops idle connections; busy connections
        /// are unaffected and continue to work normally.
        /// </summary>
        public void ClearIdleConnections()
        {
            SQLiteConnection.ClearAllPools();
            // 池已清空,常驻连接数归零,借出峰值同步归零,下次借出重新累计。
            // Interlocked.Exchange 防与并发 UpdatePeak 的 CAS 竞态(普通写可能
            // 覆盖晚到的 CAS 新峰值或残留旧峰值)。
            Interlocked.Exchange(ref _peakBorrowed, 0);
        }
    }
}
