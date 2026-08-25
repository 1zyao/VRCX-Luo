using System;
using System.Collections;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Text.Json;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
using MySqlConnector;
using NLog;

namespace VRCX
{
    /// <summary>
    /// MySQL / MariaDB connection manager and query executor.
    ///
    /// Mirrors the public surface of <see cref="PostgreSQL"/> so that the JS
    /// adapter layer can switch engines without changing its call shape:
    ///   - Init() reads VRCX_Database.* config and builds the connection string.
    ///   - Exit() clears the connection string (pool stays alive until process exit).
    ///   - Execute/ExecuteNonQuery/ExecuteJson run parameterised SQL on a fresh
    ///     pooled connection each call (MySqlConnector pools automatically via the
    ///     connection string; `using` returns the connection to the pool).
    ///
    /// Built on MySqlConnector, which natively supports both MySQL and
    /// MariaDB (protocol-compatible). Both 'mysql' and 'mariadb' modes
    /// route to this class. No engine-specific branching is needed — the
    /// SQL dialect, connection string format, and error codes are
    /// identical across both servers.
    ///
    /// Transaction pinning: BeginTransaction borrows a pooled connection and
    /// holds it in a TxHolder across multiple Execute/ExecuteNonQuery calls so
    /// that BEGIN ... INSERT ... COMMIT run on the SAME physical connection.
    /// A sliding idle timer (TX_IDLE_MS) auto-rolls-back if JS forgets to
    /// commit. See docs/architecture/TRANSACTION_DESIGN.md.
    /// </summary>
    public class MySQL : IAuthStore
    {
        public static MySQL Instance;

        /// <summary>
        /// 数据库变更通知(写漏斗):进程内任何写提交后触发,负载 JSON 字符串
        /// `{ conn, table, count, ts, dv }`(dv 读自服务端 performance_schema
        /// 计数器,任意连接视角一致,无需观察连接)。检测语义:事件只是失效
        /// 提示,不是数据管道——漏事件由计数器兜底轮询补上。详见
        /// docs/architecture/ADAPTER_API.md §9。
        /// </summary>
        public event Action<string>? DatabaseChanged;

        private Action<string>? _changeCallback;

        /// <summary>Electron 反向通道:node-api-dotnet 以 JS 函数作
        /// .NET delegate 注册变更回调;编组失败静默,完备层轮询兜底。</summary>
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

        private MySqlDataSource _dataSource;
        private bool _initialized;
        private bool _browseReadOnlyConfigured;

        /// <summary>
        /// 测试钩子:浏览模式(browse)下是否注册了连接打开只读回调。
        /// 连接串断言无法区分"回调已注册"与"未注册"(只读在会话层,不体现在串上),
        /// 若误删外层 if 变成恒注册,collector 也会被 SET SESSION READ ONLY,
        /// 此标志可被单元测试直接校验(M2 §5.2 / review #15)。
        /// </summary>
        internal bool IsBrowseReadOnlyConfigured => _browseReadOnlyConfigured;

        private static readonly Logger logger = LogManager.GetCurrentClassLogger();

        // ── Pool metrics (三态连接池监控,Issue #14) ───────────────────────
        private int _totalBorrowed;
        private int _activeCount;
        private int _pinnedActive;
        private int _maxPoolSize;
        private DateTime _lastHealthCheck;

        // 反射驱动真值(MySqlConnector 2.6.1 内部结构,懒初始化,失败静默回退估算):
        // _idleSessionsField = ConnectionPool.m_sessions(LinkedList<ServerSession>)
        // _sessionSemaphoreField = ConnectionPool.m_sessionSemaphore(SemaphoreSlim)
        private bool _poolStatsReflected;
        private FieldInfo? _idleSessionsField;
        private FieldInfo? _sessionSemaphoreField;

        // ── Transaction pinning ────────────────────────────────────────────
        // 与 PostgreSQL.cs 对称:_pinned Map 持有借出的连接,sliding Timer
        // 防泄漏。connId 有值时 Execute/ExecuteNonQuery 走 pinned 连接 +
        // 重置 Timer;无值时走池自动派发。
        private readonly object _txLock = new();
        private readonly ConcurrentDictionary<long, TxHolder> _pinned = new();
        private static readonly ConcurrentDictionary<string, MySqlDataSource> DataSourceCache = new();
        private long _nextConnId;
        private const int TX_IDLE_MS = 60000;

        private sealed class TxHolder
        {
            public MySqlConnection Conn = null!;
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

        // ── 写漏斗:表名提取与事件发射 ─────────────────────────────────
        // 表名从 SQL 语句形态提取(adapter 生成的 INSERT/UPDATE/DELETE/
        // CREATE 等语句结构固定,足够可靠);提取失败时 table=null → 不发
        // 事件(与 Execute 门控对称),由完备层计数器轮询兜底(版本前进 →
        // 全量失效)。
        // dv 读自服务端 performance_schema 计数器,任意连接视角一致——
        // MySQL 无 SQLite 的"写者连接滞后"问题,无需专用观察连接。
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

        /// <summary>读服务端完备层计数器:performance_schema 行级 DML 计数聚合(DB 级信号)。</summary>
        private static long? ReadDataVersion(MySqlConnection connection)
        {
            try
            {
                using var cmd = connection.CreateCommand();
                cmd.CommandText = "SELECT SUM(COUNT_INSERT + COUNT_UPDATE + COUNT_DELETE) FROM performance_schema.table_io_waits_summary_by_table";
                var v = cmd.ExecuteScalar();
                return v is null or DBNull ? null : Convert.ToInt64(v);
            }
            catch
            {
                return null;
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

        /// <summary>事务内累积表级写计数(供 COMMIT 后按表发射);-1 表示未知计数。</summary>
        private static void RecordChange(TxHolder h, string? table, int count)
        {
            if (string.IsNullOrEmpty(table)) return;
            h.Changes ??= new Dictionary<string, int>();
            var prev = h.Changes.GetValueOrDefault(table);
            if (prev == -1 || count == -1)
            {
                h.Changes[table] = -1; // 存在未知计数 → 整体未知
            }
            else if (count > 0)
            {
                h.Changes[table] = prev + count;
            }
        }

        static MySQL()
        {
            Instance = new MySQL();
        }

        public MySQL()
        {
        }

        /// <summary>
        /// Initialises the shared MySQL/MariaDB connection from VRCX_Database.*
        /// configuration keys. Required keys: host, name (database/schema);
        /// defaults are applied for port (3306), username, password and
        /// common connector options.
        /// </summary>
        public void Init()
        {
#if LINUX
            Instance = this;
#endif
            var host = VRCXStorage.Instance.Get("VRCX_Database.host");
            var portStr = VRCXStorage.Instance.Get("VRCX_Database.port");
            var username = VRCXStorage.Instance.Get("VRCX_Database.username");
            var password = VRCXStorage.Instance.Get("VRCX_Database.password");
            var database = VRCXStorage.Instance.Get("VRCX_Database.name");

            if (string.IsNullOrWhiteSpace(host))
            {
                throw new InvalidOperationException(
                    "VRCX_Database.host is required when VRCX_Database.mode is 'mysql'.");
            }

            if (string.IsNullOrWhiteSpace(database))
            {
                throw new InvalidOperationException(
                    "VRCX_Database.name (MySQL database/schema) is required when VRCX_Database.mode is 'mysql'.");
            }

            if (!int.TryParse(portStr, out var port) || port <= 0)
            {
                port = 3306;
            }

            var builder = new MySqlConnectionStringBuilder
            {
                Server = host,
                Port = (uint)port,
                UserID = username,
                Password = password,
                Database = database,
                AllowUserVariables = false,
                UseAffectedRows = true,
                SslMode = MySqlSslMode.Preferred,
                ConnectionTimeout = 15,
                DefaultCommandTimeout = 30,
                // MySqlConnector 默认启用池化;显式设置 Pooling=True 让意图清晰。
                // 池上限 16,下限 1(预热保活),空闲连接保留 300 秒。
                // Min=1 保证挂机数小时后下一次查询不必重建 TCP+认证
                // (异地 MySQL 可达 200ms+);建连是惰性的,CreatePool() 不建连,
                // 首次 Open 才建到 min size,故 MySQL 不可达时 Init() 不会失败,
                // 失败推迟到首次 Open。ConnectionIdleTimeout 只回收超出 min 的
                // idle 连接,min 条常驻不受影响。
                Pooling = true,
                MaximumPoolSize = 16,
                MinimumPoolSize = 1,
                ConnectionIdleTimeout = 300
            };

            ApplyUserOptions(builder);

            // 浏览模式 (VRCX_NodeMode=browse, M2 §2.10 M9):连接层强制会话只读兜底。
            // 通过 UseConnectionOpenedCallback 在每个新建立的连接上执行
            // SET SESSION TRANSACTION READ ONLY。collector 分支构造逐字符不变
            // (验收硬线:连接串仅由 builder 决定,不追加只读片段)。
            var nodeMode = NodeMode.Normalize(VRCXStorage.Instance.Get("VRCX_NodeMode"));
            var isReadOnly = nodeMode == "browse";
            _browseReadOnlyConfigured = isReadOnly;
            if (isReadOnly)
            {
                var dataSourceBuilder = new MySqlDataSourceBuilder(builder.ConnectionString);
                dataSourceBuilder.UseConnectionOpenedCallback(OnBrowseConnectionOpened);
                _dataSource = dataSourceBuilder.Build();
            }
            else
            {
                _dataSource = new MySqlDataSource(builder.ConnectionString);
            }
            _maxPoolSize = (int)builder.MaximumPoolSize;
            _initialized = true;
        }

        /// <summary>
        /// 浏览模式连接打开回调:对每个新建立的连接执行 SET SESSION TRANSACTION
        /// READ ONLY。Conditions 为 None/New/Reset 时均设置,保证池中连接被
        /// 复用/重置后仍保持只读。失败仅降级(连接层只读是 JS 门禁的兜底,
        /// 不是唯一防线),记录 warn 不阻断连接。
        /// </summary>
        internal ValueTask OnBrowseConnectionOpened(
            MySqlConnectionOpenedContext context,
            CancellationToken cancellationToken)
        {
            try
            {
                using var command = context.Connection.CreateCommand();
                command.CommandText = "SET SESSION TRANSACTION READ ONLY";
                command.ExecuteNonQuery();
            }
            catch (Exception ex)
            {
                logger.Warn(ex, "browse 模式设置只读会话失败,降级为应用层只读门禁 (R-9)");
            }
            return ValueTask.CompletedTask;
        }

        /// <summary>
        /// Merges VRCX_Database.options.* entries into the connection string.
        /// Keys starting with '_' are treated as comments/placeholders and
        /// ignored, matching the SQLite option semantics.
        /// </summary>
        private static void ApplyUserOptions(MySqlConnectionStringBuilder builder)
        {
            const string prefix = "VRCX_Database.options.";
            var userOptions = VRCXStorage.Instance.GetWithPrefix(prefix);

            foreach (var (key, val) in userOptions)
            {
                if (key.StartsWith("_"))
                    continue;

                switch (key.ToLowerInvariant())
                {
                    case "sslmode":
                        if (Enum.TryParse<MySqlSslMode>(val, true, out var sslMode))
                            builder.SslMode = sslMode;
                        break;
                    case "allowuservariables":
                        if (bool.TryParse(val, out var allowUserVariables))
                            builder.AllowUserVariables = allowUserVariables;
                        break;
                    case "useaffectedrows":
                        if (bool.TryParse(val, out var useAffectedRows))
                            builder.UseAffectedRows = useAffectedRows;
                        break;
                    case "connectiontimeout":
                        if (int.TryParse(val, out var connectionTimeout) && connectionTimeout > 0)
                            builder.ConnectionTimeout = (uint)connectionTimeout;
                        break;
                    case "defaultcommandtimeout":
                        if (int.TryParse(val, out var commandTimeout) && commandTimeout > 0)
                            builder.DefaultCommandTimeout = (uint)commandTimeout;
                        break;
                }
            }
        }

        /// <summary>
        /// Clears the connection string + initialised flag. The
        /// MySqlConnector pool stays alive until process exit (connections
        /// in the pool are returned lazily); new calls after Exit() will
        /// fail with a "not initialised" error.
        /// </summary>
        public void Exit()
        {
            _initialized = false;
            _dataSource?.Dispose();
            _dataSource = null;
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
        }

        /// <summary>
        /// Reports whether the backend has been initialised. Mirrors
        /// <see cref="PostgreSQL.IsConnected"/> so the renderer-side
        /// <c>testMysqlConnection</c> store action can probe backend health
        /// symmetrically with PostgreSQL. Does not probe the network —
        /// callers use <see cref="Ping"/> for a liveness check.
        /// </summary>
        /// <returns><c>true</c> if initialised with a connection string.</returns>
        public bool IsConnected()
        {
            return _initialized && _dataSource != null;
        }

        /// <summary>
        /// Lightweight liveness probe. Symmetric to <see cref="PostgreSQL.Ping"/>.
        /// Opens a pooled connection and executes <c>SELECT 1</c>; returns
        /// <c>true</c> on success, <c>false</c> on any failure (server down,
        /// auth rejected, network unreachable). Worst-case latency when the
        /// server is unreachable is bounded by <c>ConnectionTimeout</c>
        /// (default 15s).
        /// </summary>
        /// <remarks>
        /// Prefer this over <see cref="IsConnected"/> when the caller needs to
        /// confirm the backend is actually reachable, not just initialised —
        /// e.g. the renderer-side <c>testMysqlConnection</c> store action and
        /// the push/pull engine fail-fast guards.
        /// </remarks>
        /// <returns><c>true</c> when <c>SELECT 1</c> succeeds against the pool.</returns>
        public bool Ping()
        {
            try
            {
                Interlocked.Increment(ref _totalBorrowed);
                using var connection = _dataSource.OpenConnection();
                try
                {
                    using var cmd = connection.CreateCommand();
                    cmd.CommandText = "SELECT 1";
                    cmd.ExecuteScalar();
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

        /// <summary>
        /// Probe the server with <c>SELECT 1</c> and return a JSON health
        /// snapshot: <c>{ connected, latencyMs, lastHealthCheck }</c>.
        /// Symmetric to <see cref="PostgreSQL.GetHealth"/>.
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
                    Interlocked.Increment(ref _totalBorrowed);
                    using var conn = _dataSource.OpenConnection();
                    try
                    {
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
        /// Executes a SELECT/PRAGMA-like statement and returns the result set
        /// serialised as a JSON string. Used by the Linux/Electron JS bridge.
        /// </summary>
        public string ExecuteJson(string sql, IDictionary<string, object>? args = null, object? connId = null)
        {
            var result = Execute(sql, args, connId);
            return JsonSerializer.Serialize(result);
        }

        /// <summary>
        /// Execute a query on a fresh pooled connection and return rows as
        /// positional arrays. When <paramref name="connId"/> is present the
        /// query runs on the pinned transaction connection + resets the
        /// sliding idle timer.
        /// </summary>
        public object[][] Execute(string sql, IDictionary<string, object>? args = null, object? connId = null)
        {
            var nId = NormalizeConnId(connId);
            if (nId.HasValue)
            {
                return ExecutePinned(nId.Value, sql, args);
            }
            EnsureInitialized();
            Interlocked.Increment(ref _totalBorrowed);
            using var connection = _dataSource.OpenConnection();
            try
            {
                Interlocked.Increment(ref _activeCount);
                try
                {
                    using var command = new MySqlCommand(sql, connection);
                    AddParameters(command, args);

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
                    var table = ExtractTable(sql);
                    if (table != null && _changeEnabled)
                    {
                        EmitChange(ChangeConnDefault, table, -1, ReadDataVersion(connection));
                    }
                    return result.ToArray();
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
        /// Execute a non-query on a fresh pooled connection and return rows
        /// affected. When <paramref name="connId"/> is present the statement
        /// runs on the pinned transaction connection + resets the timer.
        /// </summary>
        public int ExecuteNonQuery(string sql, IDictionary<string, object>? args = null, object? connId = null)
        {
            var nId = NormalizeConnId(connId);
            if (nId.HasValue)
            {
                return ExecuteNonQueryPinned(nId.Value, sql, args);
            }
            EnsureInitialized();
            Interlocked.Increment(ref _totalBorrowed);
            using var connection = _dataSource.OpenConnection();
            try
            {
                Interlocked.Increment(ref _activeCount);
                try
                {
                    using var command = new MySqlCommand(sql, connection);
                    AddParameters(command, args);
                    var affected = command.ExecuteNonQuery();
                    var table = ExtractTable(sql);
                    if (table != null && _changeEnabled)
                    {
                        EmitChange(ChangeConnDefault, table, affected, ReadDataVersion(connection));
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
        /// Opens a fresh connection from the given connection string, executes
        /// a query, and returns the result set as JSON. The connection is
        /// closed after the query completes.
        ///
        /// This does NOT touch the pooled connection — it is completely
        /// independent, intended for querying an EXTERNAL database (e.g.
        /// during migration).
        /// </summary>
        public string ExecuteJsonOnConnection(string connectionString, string sql, IDictionary<string, object>? args = null, object? connId = null)
        {
            var nId = NormalizeConnId(connId);
            if (nId.HasValue)
            {
                return JsonSerializer.Serialize(ExecutePinned(nId.Value, sql, args));
            }
            var dataSource = DataSourceCache.GetOrAdd(connectionString, cs => new MySqlDataSource(cs));
            using var connection = dataSource.OpenConnection();

            using var command = new MySqlCommand(sql, connection);
            AddParameters(command, args);

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
                EmitChange(connectionString, writeTable, -1, ReadDataVersion(connection));
            }
            return JsonSerializer.Serialize(result);
        }

        /// <summary>
        /// Opens a fresh connection from the given connection string, executes
        /// a non-query, and returns the number of rows affected. The connection
        /// is closed after the query completes.
        ///
        /// This does NOT touch the pooled connection — it is completely
        /// independent.
        /// </summary>
        public int ExecuteNonQueryOnConnection(string connectionString, string sql, IDictionary<string, object>? args = null, object? connId = null)
        {
            var nId = NormalizeConnId(connId);
            if (nId.HasValue)
            {
                return ExecuteNonQueryPinned(nId.Value, sql, args);
            }
            var dataSource = DataSourceCache.GetOrAdd(connectionString, cs => new MySqlDataSource(cs));
            using var connection = dataSource.OpenConnection();

            using var command = new MySqlCommand(sql, connection);
            AddParameters(command, args);

            var affected = command.ExecuteNonQuery();
            var table = ExtractTable(sql);
            if (table != null && _changeEnabled)
            {
                EmitChange(connectionString, table, affected, ReadDataVersion(connection));
            }
            return affected;
        }

        /// <summary>
        /// Adds named parameters to a command. Keys may already carry a '@' or
        /// '?' marker; if not, '@' is prepended to match MySqlConnector's
        /// named-parameter convention.
        /// </summary>
        private static void AddParameters(MySqlCommand command, IDictionary<string, object>? args)
        {
            if (args == null)
                return;

            foreach (var arg in args)
            {
                var name = arg.Key;
                if (!name.StartsWith("@") && !name.StartsWith("?"))
                    name = "@" + name;

                command.Parameters.AddWithValue(name, arg.Value ?? DBNull.Value);
            }
        }

        // ── Transaction pinning implementation ───────────────────────────────
        // 与 PostgreSQL.cs 对称:BeginTransaction 借一条 pooled 连接,持有在
        // TxHolder 中;ExecutePinned/ExecuteNonQueryPinned 按 connId 查 holder,
        // 在持有的连接上执行 SQL + 重置 sliding timer;Commit/Rollback 终结
        // 事务并还池。sliding timer 自动回滚空闲超时的事务防泄漏。

        private void EnsureInitialized()
        {
            if (!_initialized || _dataSource == null)
                throw new InvalidOperationException(
                    "MySQL backend not initialised. Call Init() first.");
        }

        // ── IAuthStore implementation ──────────────────────────────────────
        // MySQL 方言:命名参数 (@key/@value)、REPLACE INTO upsert、反引号引用
        // `key`(MySQL 保留字)。key 列用 VARCHAR(255) 容纳 acctId 前缀,
        // value 用 LONGTEXT 容纳序列化 CookieCollection。

        /// <inheritdoc />
        public void EnsureCookiesTable()
        {
            ExecuteNonQuery(
                "CREATE TABLE IF NOT EXISTS `cookies` (`key` VARCHAR(255) PRIMARY KEY, `value` LONGTEXT)");
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
                "REPLACE INTO `cookies` (`key`, `value`) VALUES (@key, @value)",
                new Dictionary<string, object> { { "@key", key }, { "@value", value } });
        }

        private static MySqlCommand CreateTxCommand(TxHolder h, string sql, IDictionary<string, object>? args)
        {
            var command = h.Conn.CreateCommand();
            command.CommandText = sql;
            AddParameters(command, args);
            return command;
        }

        /// <summary>
        /// MySqlConnector 2.6.x 在同一个连接上同步连发命令时,偶发抛
        /// "This MySqlConnection is already in use"(前一条命令的异步
        /// 清理尚未完成,连接仍标记为 in-use)。这是驱动的已知行为。
        /// 解决办法:同一 pinned 连接上的 SQL 用 <paramref name="h"/>
        /// 串行化(锁可重入),并对该瞬时错误做短暂重试。
        /// </summary>
        private static object[][] ExecutePinnedWithRetry(TxHolder h, string sql, IDictionary<string, object>? args)
        {
            for (var attempt = 1; ; attempt++)
            {
                try
                {
                    lock (h)
                    {
                        using var command = CreateTxCommand(h, sql, args);
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
                        RecordChange(h, ExtractTable(sql), -1);
                        return result.ToArray();
                    }
                }
                catch (MySqlConnector.MySqlException ex) when (
                    ex.Message.Contains("already in use") && attempt < 3)
                {
                    Thread.Sleep(30);
                }
            }
        }

        private static int ExecuteNonQueryPinnedWithRetry(TxHolder h, string sql, IDictionary<string, object>? args)
        {
            for (var attempt = 1; ; attempt++)
            {
                try
                {
                    lock (h)
                    {
                        using var command = CreateTxCommand(h, sql, args);
                        return command.ExecuteNonQuery();
                    }
                }
                catch (MySqlConnector.MySqlException ex) when (
                    ex.Message.Contains("already in use") && attempt < 3)
                {
                    Thread.Sleep(30);
                }
            }
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
                return ExecutePinnedWithRetry(h, sql, args);
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
                var affected = ExecuteNonQueryPinnedWithRetry(h, sql, args);
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
        /// Borrow a connection from the ad-hoc DataSource cache, BEGIN a
        /// transaction on it, and return a connId. The TxHolder is stored in
        /// <see cref="_pinned"/> alongside singleton-pool transactions so
        /// <see cref="CommitTransaction"/>/<see cref="RollbackTransaction"/>
        /// work for both paths. The DataSource is resolved from
        /// <see cref="DataSourceCache"/> instead of the singleton
        /// <c>_dataSource</c>.
        /// </summary>
        /// <param name="connectionString">Connection string keying into
        /// <see cref="DataSourceCache"/>.</param>
        public long BeginTransactionOnConnection(string connectionString)
        {
            var dataSource = DataSourceCache.GetOrAdd(connectionString,
                cs => new MySqlDataSource(cs));
            var connId = Interlocked.Increment(ref _nextConnId);
            Interlocked.Increment(ref _totalBorrowed);
            var conn = dataSource.OpenConnection();
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
        /// Borrow a pooled connection, BEGIN a transaction on it, and return
        /// a connId that JS passes back on subsequent Execute/ExecuteNonQuery
        /// calls to keep them on the same physical connection. A sliding
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
            Interlocked.Increment(ref _totalBorrowed);
            var conn = _dataSource.OpenConnection();
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
        /// COMMIT the transaction pinned to <paramref name="connId"/> and
        /// return the connection to the pool. Throws if the connId has
        /// already been timed out / rolled back.
        /// </summary>
        public void CommitTransaction(long connId)
        {
            Dictionary<string, int>? changes;
            string connLabel;
            long? dv = null;
            MySqlConnection conn;
            lock (_txLock)
            {
                if (!_pinned.TryRemove(connId, out var h))
                    throw new InvalidOperationException(
                        $"connId={connId} 已超时回滚或不存在,无法 commit");
                h.Timer.Dispose();
                conn = h.Conn;
                changes = h.Changes;
                connLabel = h.ConnLabel ?? ChangeConnDefault;
            }
            // 锁外 COMMIT+dv 读+归还:TryRemove 成功后连接已独占(Timer 已停),
            // 锁外执行不阻塞其他事务;COMMIT 失败时 finally 仍归还连接,
            // 异常传播且事件不发射(与现状锁内路径等价)。
            try
            {
                using var cmd = conn.CreateCommand();
                cmd.CommandText = "COMMIT";
                cmd.ExecuteNonQuery();
                if (connLabel == ChangeConnDefault && _changeEnabled)
                {
                    dv = ReadDataVersion(conn);
                }
            }
            finally
            {
                Interlocked.Decrement(ref _totalBorrowed);
                conn.Dispose();
            }
            // 锁外发射:事件编组可能回调进本类,避免持锁重入。
            if (changes is { Count: > 0 })
            {
                foreach (var kv in changes)
                {
                    EmitChange(connLabel, kv.Key, kv.Value, dv);
                }
            }
        }

        /// <summary>
        /// ROLLBACK the transaction pinned to <paramref name="connId"/> and
        /// return the connection to the pool. No-op if the connId has
        /// already been timed out / rolled back.
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
                    $"[MySQL] 事务 connId={connId} 空闲 {TX_IDLE_MS}ms,自动回滚");
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
        /// 返回当前连接池的三态 + 扩展快照,纯内存计数器读取,不涉及网络调用。
        /// JS 侧每秒采样一次,用于底部栏三色波线展示(Issue #14)。
        ///
        /// 基础字段(所有引擎对称,JS 主用):
        ///   active            = 正在执行 SQL 的连接数(pinned + 非 pinned)
        ///   pinnedIdle        = 事务持有但未执行 SQL 的连接数
        ///   availableCapacity = 可用容量(_maxPoolSize - _totalBorrowed)
        ///   max               = 连接池上限
        ///
        /// 扩展字段(冗余校验,驱动版本变化可能失效,UI 不强依赖):
        ///   totalOpen  = 池中当前存活的物理连接总数(MySQL 反射真值)
        ///   idleInPool = 池中存活且空闲的物理连接数(MySQL 反射真值)
        /// MySqlConnector 公开 API 不暴露 idle/total 计数(仅 IsEmpty 布尔),
        /// 反射 internal 结构(2.6.1,升级驱动需重新验证)拿真值:
        ///   idle   = m_sessions(LinkedList&lt;ServerSession&gt;).Count,空闲物理连接数
        ///   leased = _maxPoolSize - m_sessionSemaphore.CurrentCount,已借出连接数
        ///   totalOpen = idle + leased;idleInPool = idle
        /// 驱动启动 ReaperTask(ConnectionIdleTimeout=300)主动回收超时空闲连接,
        /// 故 idleInPool 随时间真实下降,不再是旧估算恒显 99/100 的配额假象。
        /// 反射失败(字段改名/驱动升级)时静默回退估算:
        ///   totalOpen  = active + pinnedIdle + availableCapacity  (下界)
        ///   idleInPool = availableCapacity
        /// 上层 JS 主用基础字段自算 idleInPool = totalOpen - active - pinnedIdle。
        /// </summary>
        public string GetPoolStats()
        {
            var active = _activeCount;
            var pinnedIdle = _pinned.Count - _pinnedActive;
            var availableCapacity = _maxPoolSize - _totalBorrowed;

            // 默认估算:假设所有可用容量都是空闲物理连接(下界估算,偏高)。
            // 反射成功后用真值覆盖。
            var totalOpen = active + pinnedIdle + availableCapacity;
            var idleInPool = availableCapacity;

            // 反射 MySqlConnector.Core.ConnectionPool 拿真值。懒初始化,
            // 字段解析失败即标记不再重试(PG 同款容错模式),回退估算。
            if (!_poolStatsReflected)
            {
                try
                {
                    var poolType = typeof(MySqlDataSource).Assembly
                        .GetType("MySqlConnector.Core.ConnectionPool");
                    _idleSessionsField = poolType?.GetField(
                        "m_sessions", BindingFlags.NonPublic | BindingFlags.Instance);
                    _sessionSemaphoreField = poolType?.GetField(
                        "m_sessionSemaphore", BindingFlags.NonPublic | BindingFlags.Instance);
                }
                catch
                {
                    _idleSessionsField = null;
                    _sessionSemaphoreField = null;
                }
                _poolStatsReflected = true;
            }

            if (_dataSource != null && _idleSessionsField != null && _sessionSemaphoreField != null)
            {
                try
                {
                    // 2.6.1:MySqlDataSource 经 ConnectionPool.CreatePool 持有专属池实例,
                    // 不注册进静态 s_pools 注册表(静态 GetPool 对 datasource 路径
                    // 恒 miss,见 MySqlConnection 借出用 m_dataSource?.Pool),
                    // 故反射 internal Pool 属性取池实例。
                    var pool = typeof(MySqlDataSource)
                        .GetProperty("Pool", BindingFlags.NonPublic | BindingFlags.Instance)
                        ?.GetValue(_dataSource);
                    if (pool != null)
                    {
                        // 池为 null(池未就绪)时不标记失败,下次调用重试;
                        // 池实例存在即反射成功,数值为驱动真值。
                        var idleSessions = _idleSessionsField.GetValue(pool) as ICollection;
                        var semaphore = _sessionSemaphoreField.GetValue(pool) as SemaphoreSlim;
                        if (idleSessions != null && semaphore != null)
                        {
                            var idle = idleSessions.Count;
                            var leased = _maxPoolSize - semaphore.CurrentCount;
                            idleInPool = idle;
                            totalOpen = idle + leased;
                        }
                    }
                }
                catch
                {
                    // 反射执行失败(驱动版本变化/对象已 Dispose):保持估算值。
                }
            }

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
        /// Clear idle connections from the pool. MySqlConnector's
        /// ClearAllPools() only drops idle connections; busy connections
        /// are unaffected and continue to work normally.
        /// </summary>
        public void ClearIdleConnections()
        {
            MySqlConnection.ClearAllPools();
        }

        /// <summary>
        /// Normalise a JS-provided connId value (<c>object?</c>) to a typed
        /// <c>long?</c> so downstream <c>ExecutePinned</c> / <c>ExecuteNonQueryPinned</c>
        /// can consume it.
        ///
        /// CefSharp marshalling boxes small integers as <c>Int32</c>; the
        /// CLR cannot unbox an <c>int</c> directly to <c>long?</c> via
        /// reflection, hence the <c>object?</c> → <c>long?</c> bridge.
        ///
        /// Handles: null, DBNull, Missing, int, long, 整值 double.
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
    }
}
