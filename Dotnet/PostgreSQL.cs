using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Reflection;
using Npgsql;

namespace VRCX
{
    /// <summary>
    /// PostgreSQL backend wrapper for VRCX.
    ///
    /// Mirrors the public surface of <see cref="SQLite"/> so that the JS adapter
    /// layer can call the same patterns (Execute/ExecuteNonQuery/ExecuteJson)
    /// against a PostgreSQL backend. Built on Npgsql 9.0+ and uses
    /// <see cref="NpgsqlDataSource"/> for connection pooling.
    ///
    /// Phase 9.1: add Npgsql package and create this class.
    /// Phase 9.2: field-based config, connection pooling, health checks.
    /// Phase 9.14: JS bridge registration + bootstrap wiring.
    /// </summary>
    public class PostgreSQL : IAuthStore
    {
        public static PostgreSQL Instance;

        /// <summary>
        /// 数据库变更通知(写漏斗):进程内任何写提交后触发,负载 JSON 字符串
        /// `{ conn, table, count, ts, dv }`(dv 读自服务端计数器,任意连接
        /// 视角一致,无需观察连接)。检测语义:事件只是失效提示,不是数据
        /// 管道——漏事件由计数器兜底轮询补上。详见 docs/architecture/ADAPTER_API.md §9。
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
            if (enabled)
            {
                StartChangeListener();
            }
            else
            {
                StopChangeListener();
            }
        }

        // ── 原生变更通知:trigger + LISTEN/NOTIFY(PG 专属) ─────────────
        // 上层 onTableChange 接口统一,检测机制允许引擎异构——PG 用原生
        // trigger+NOTIFY 提供"外部写者表级实时检测",替代计数器轮询的
        // 主路径;计数器轮询保留为安全网。
        // 成本:每张 watched 表一个 FOR EACH STATEMENT 触发器(消费方负责
        // 安装,经 CreateChangeTrigger)+ 一条专用监听连接(随门控启停,
        // 无消费者时不存在)。
        // 去重:漏斗与 NOTIFY 对自写双发——EmitChange(漏斗路径)按表记录
        // 发射时间,监听侧 500ms 窗口内的 NOTIFY 视为自写镜像丢弃;
        // 窗口误杀的外部写由计数器兜底(≤5s)补上。NOTIFY 负载仅表名
        // (statement 级触发器无行数),事件 count=-1 全量失效。
        private const string ChangeChannel = "vrcx_change";
        private const string ChangeTriggerName = "vrcx_change_notify_trg";
        private const string ChangeFunctionName = "vrcx_change_notify";
        private static readonly TimeSpan ChangeDedupeWindow = TimeSpan.FromMilliseconds(500);
        private readonly ConcurrentDictionary<string, long> _lastFunnelEmitTicks = new();
        private CancellationTokenSource? _listenerCts;

        private void StartChangeListener()
        {
            if (_listenerCts != null) return;
            _listenerCts = new CancellationTokenSource();
            _ = Task.Run(() => ChangeListenerLoop(_listenerCts.Token));
        }

        private void StopChangeListener()
        {
            var cts = Interlocked.Exchange(ref _listenerCts, null);
            if (cts == null) return;
            cts.Cancel();
        }

        private async Task ChangeListenerLoop(CancellationToken ct)
        {
            while (!ct.IsCancellationRequested)
            {
                try
                {
                    using var conn = _dataSource.CreateConnection();
                    conn.Open();
                    conn.Notification += OnChangeNotification;
                    using (var listenCmd = conn.CreateCommand())
                    {
                        listenCmd.CommandText = $"LISTEN {ChangeChannel}";
                        listenCmd.ExecuteNonQuery();
                    }
                    try
                    {
                        while (!ct.IsCancellationRequested)
                        {
                            await conn.WaitAsync(ct);
                        }
                    }
                    finally
                    {
                        conn.Notification -= OnChangeNotification;
                    }
                    return; // 仅 Exit/门控关闭时正常退出
                }
                catch (OperationCanceledException)
                {
                    return;
                }
                catch (Exception ex)
                {
                    // PG 暂不可达/监听断开:30s 后重连;期间外部写由计数器兜底。
                    Console.Error.WriteLine(
                        $"[PostgreSQL] change listener unavailable, retry in 30s: {ex.Message}");
                    try { await Task.Delay(TimeSpan.FromSeconds(30), ct); }
                    catch (OperationCanceledException) { return; }
                }
            }
        }

        private void OnChangeNotification(object? sender, NpgsqlNotificationEventArgs e)
        {
            if (e.Channel != ChangeChannel || string.IsNullOrEmpty(e.Payload)) return;
            // 负载格式校验:与触发器 DDL 白名单同一正则(单一事实源)。
            // 非表名负载(误配置/意外 pg_notify/伪造)静默丢弃,不进 Map 查找
            // 与事件序列化。风暴不设限速——PG 为单应用独占 DB,同库不可信
            // 会话不在威胁模型内(外部写者为非支持场景)。
            if (!TableIdentifierPattern.IsMatch(e.Payload)) return;
            if (IsSelfMirror(e.Payload)) return; // 自写镜像:漏斗事件已发,丢弃
            // 监听连接处于 Waiting 态不可查询——dv 改走池中独立连接读
            // (外部写为稀有路径,+1 次池借还可忽略)。失败则 dv=null,
            // 由计数器轮询兜底(基线不推进,≤5s 全量失效,安全)。
            long? dv = null;
            try
            {
                using var conn = _dataSource.CreateConnection();
                conn.Open();
                dv = ReadDataVersion(conn);
            }
            catch
            {
                // dv 读取失败静默:计数器轮询兜底
            }
            EmitChange(ChangeConnDefault, e.Payload, -1, dv, recordFunnel: false);
        }

        /// <summary>漏斗是否刚为该表发过事件(500ms 窗口)——自写镜像去重。</summary>
        private bool IsSelfMirror(string table)
        {
            if (!_lastFunnelEmitTicks.TryGetValue(table, out var ticks)) return false;
            return DateTime.UtcNow.Ticks - ticks <= ChangeDedupeWindow.Ticks;
        }

        /// <summary>变更触发器表名标识符(模式限定可选),防 SQL 注入。</summary>
        private static readonly Regex TableIdentifierPattern =
            new("^[A-Za-z0-9_]+(?:\\.[A-Za-z0-9_]+)?$", RegexOptions.Compiled);

        private static string QuoteTableName(string table)
        {
            if (!TableIdentifierPattern.IsMatch(table))
            {
                throw new ArgumentException(
                    $"非法表名(仅字母数字下划线,可含模式限定): {table}");
            }
            var parts = table.Split('.');
            return parts.Length == 1
                ? $"\"{parts[0]}\""
                : $"\"{parts[0]}\".\"{parts[1]}\"";
        }

        /// <summary>
        /// 安装/更新通知函数(幂等)。触发器依赖此函数,消费方在安装
        /// 触发器前调用一次即可。
        /// </summary>
        public int EnsureChangeFunction()
        {
            EnsureInitialized();
            return ExecuteNonQuery(
                $"CREATE OR REPLACE FUNCTION {ChangeFunctionName}() RETURNS trigger AS $$ " +
                "BEGIN PERFORM pg_notify('" + ChangeChannel + "', " +
                "CASE WHEN TG_TABLE_SCHEMA = 'public' THEN TG_TABLE_NAME " +
                "ELSE TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME END); " +
                $"RETURN NULL; END $$ LANGUAGE plpgsql");
        }

        /// <summary>
        /// 在指定表上安装变更触发器(幂等:先 DROP IF EXISTS 再 CREATE)。
        /// FOR EACH STATEMENT:每条语句一次 NOTIFY,批量友好;负载为
        /// 模式限定表名(public 省略前缀,与漏斗 ExtractTable 形态一致)。
        /// 表不存在时抛错。无触发器的表不被 NOTIFY 覆盖,由计数器兜底。
        /// </summary>
        public int CreateChangeTrigger(string table)
        {
            EnsureInitialized();
            var q = QuoteTableName(table);
            ExecuteNonQuery($"DROP TRIGGER IF EXISTS {ChangeTriggerName} ON {q}");
            return ExecuteNonQuery(
                $"CREATE TRIGGER {ChangeTriggerName} AFTER INSERT OR UPDATE OR DELETE ON {q} " +
                $"FOR EACH STATEMENT EXECUTE FUNCTION {ChangeFunctionName}()");
        }

        /// <summary>移除指定表上的变更触发器(表不存在时静默)。</summary>
        public int DropChangeTrigger(string table)
        {
            EnsureInitialized();
            return ExecuteNonQuery(
                $"DROP TRIGGER IF EXISTS {ChangeTriggerName} ON {QuoteTableName(table)}");
        }

        /// <summary>列出所有已安装变更触发器的表(JSON 行数组)。</summary>
        public string ListChangeTriggers()
        {
            EnsureInitialized();
            return ExecuteJson(
                "SELECT event_object_schema || '.' || event_object_table AS table_name " +
                "FROM information_schema.triggers WHERE trigger_name = $1",
                new object[] { ChangeTriggerName });
        }

        private NpgsqlDataSource _dataSource;
        private readonly ReaderWriterLockSlim _connectionLock;
        private bool _initialized;
        private DateTime _lastHealthCheck;
        private readonly TimeSpan _healthCheckInterval = TimeSpan.FromSeconds(30);

        // ── Pool metrics (三态连接池监控,Issue #14) ───────────────────────
        // 纯内存计数器,Interlocked 保证线程安全。GetPoolStats() 读取并
        // 返回 JSON,JS 侧每秒采样一次。不涉及网络调用。
        private int _totalBorrowed;  // 已借出连接总数(含 pinned + 非 pinned)
        private int _activeCount;   // 正在执行 SQL 的连接数(含 pinned + 非 pinned)
        private int _pinnedActive;  // pinned 事务连接中正在执行 SQL 的数量
        private int _maxPoolSize;   // 连接池上限,Init() 时从连接字符串解析

        // ── Driver-internal statistics reflection (Issue #14 扩展) ───────────
        // Npgsql 的 PoolingDataSource(internal sealed)实现了 internal abstract
        // Statistics 属性,返回 (int Total, int Idle, int Busy) 真值三元组。
        // 公开 API 不暴露,只能通过反射读。反射 PropertyInfo 缓存一次,运行
        // 时仅 GetValue + 拆 ValueTuple<int,int,int>。任何反射异常回退到估算
        // (totalOpen=active+pinnedIdle+availableCapacity, idleInPool=availableCapacity),
        // 保证 GetPoolStats 永不抛。上层 JS 主用基础字段自算 idleInPool,
        // 此处提供的真值字段作为冗余校验,驱动版本变化失效时不影响 UI。
        private PropertyInfo _statisticsProp;
        private bool _statisticsReflected;  // true=已尝试反射(成功或失败均置 true)

        // ── Transaction pinning ────────────────────────────────────────────
        // A pinned connection is borrowed from the pool and held across
        // multiple Execute/ExecuteNonQuery calls so that BEGIN ... INSERT
        // ... COMMIT run on the SAME physical connection (otherwise the
        // Npgsql pool returns a fresh connection per call and the
        // transaction silently no-ops — see docs/architecture/TRANSACTION_DESIGN.md).
        //
        // Sliding timeout: each use of a pinned connection resets the
        // timer (TX_IDLE_MS) so long-running transactions stay alive as
        // long as SQL keeps flowing; only a true stall (await hang,
        // network drop) triggers auto-rollback + return-to-pool.
        private readonly object _txLock = new();
        private readonly ConcurrentDictionary<long, TxHolder> _pinned = new();
        private static readonly ConcurrentDictionary<string, NpgsqlDataSource> DataSourceCache = new();
        private long _nextConnId;
        private const int TX_IDLE_MS = 60000;

        private sealed class TxHolder
        {
            public NpgsqlConnection Conn = null!;
            public NpgsqlTransaction Tx = null!;
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
        // dv 读自服务端计数器(pg_stat),任意连接视角一致——PG 无 SQLite
        // 的"写者连接滞后"问题,无需专用观察连接。
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

        /// <summary>读服务端完备层计数器:pg_stat_user_tables 行级 DML 计数
        /// 聚合(仅真实行变更;只读事务不计入,避免兜底网被高频查询打满)。</summary>
        private static long? ReadDataVersion(NpgsqlConnection connection)
        {
            try
            {
                using var cmd = connection.CreateCommand();
                cmd.CommandText = "SELECT COALESCE(SUM(n_tup_ins + n_tup_upd + n_tup_del), 0) FROM pg_stat_user_tables";
                var v = cmd.ExecuteScalar();
                return v is null or DBNull ? null : Convert.ToInt64(v);
            }
            catch
            {
                return null;
            }
        }

        private void EmitChange(string conn, string? table, int count, long? dv, bool recordFunnel = true)
        {
            if (!_changeEnabled) return; // 无消费者零成本
            if (DatabaseChanged == null && _changeCallback == null) return; // 无订阅者,零开销
            if (recordFunnel && !string.IsNullOrEmpty(table))
            {
                // 漏斗发射时间戳:NOTIFY 监听侧据此丢弃自写镜像
                _lastFunnelEmitTicks[table] = DateTime.UtcNow.Ticks;
                if (_lastFunnelEmitTicks.Count > 2048)
                {
                    // 防无界增长:清理窗口外的旧条目
                    var cutoff = DateTime.UtcNow.Ticks - ChangeDedupeWindow.Ticks;
                    foreach (var kv in _lastFunnelEmitTicks)
                    {
                        if (kv.Value < cutoff)
                        {
                            _lastFunnelEmitTicks.TryRemove(kv.Key, out _);
                        }
                    }
                }
            }
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

        static PostgreSQL()
        {
            Instance = new PostgreSQL();
        }

        public PostgreSQL()
        {
            _connectionLock = new ReaderWriterLockSlim();
        }

        /// <summary>
        /// Initialize the pooled PostgreSQL data source from the
        /// <c>VRCX_Database.{host,port,username,password,name}</c> bootstrap fields.
        /// Each field is validated against a strict whitelist to prevent
        /// connection-string injection.
        /// </summary>
        public void Init()
        {
#if LINUX
            Instance = this;
#endif
            var host = ValidateField(
                "host",
                VRCXStorage.Instance.Get("VRCX_Database.host")?.Trim(),
                @"[A-Za-z0-9._-]");
            var port = ValidatePort(
                VRCXStorage.Instance.Get("VRCX_Database.port")?.Trim(),
                5432);
            var username = ValidateField(
                "username",
                VRCXStorage.Instance.Get("VRCX_Database.username")?.Trim(),
                @"[A-Za-z0-9._-]");
            var password = ValidatePassword(
                VRCXStorage.Instance.Get("VRCX_Database.password"));
            var name = ValidateField(
                "name",
                string.IsNullOrWhiteSpace(VRCXStorage.Instance.Get("VRCX_Database.name"))
                    ? "vrcx"
                    : VRCXStorage.Instance.Get("VRCX_Database.name").Trim(),
                @"[A-Za-z0-9_]");

            var connectionString =
                $"Host={host};Port={port};Username={username};Password={password};Database={name}"
                + ";Maximum Pool Size=16"
                + ";Minimum Pool Size=1"        // 预热保活 1 条连接:池在空闲剪枝时不剪到
                                               // 低于 1,确保挂机数小时后下一次查询不必
                                               // 重建 TCP+认证(异地 PG 可达 200ms+)。
                                               // 建连是惰性的:Build() 不建连,首次
                                               // OpenConnectionAsync 才建到 min size,
                                               // 故 PG 不可达时 Init() 不会失败,失败
                                               // 推迟到首次 Open。与 MySQL 对称。
                + ";Connection Idle Lifetime=300" // 空闲 300s 自动回收(与 MySQL ConnectionIdleTimeout=300 对称)
                + ";Timeout=15"                 // 建连超时 15s(对称 MySQL ConnectionTimeout=15)
                + ";CommandTimeout=30";         // SQL 执行超时 30s(对称 MySQL DefaultCommandTimeout=30)

            var builder = new NpgsqlDataSourceBuilder(connectionString);
            _dataSource = builder.Build();
            _maxPoolSize = 16; // 连接字符串硬编码 Maximum Pool Size=16
            _initialized = true;
        }

        /// <summary>
        /// Dispose the pooled data source. Safe to call even if Init() was
        /// never invoked.
        /// </summary>
        public void Exit()
        {
            _initialized = false;
            StopChangeListener();
            _dataSource?.Dispose();
        }

        // ── JSON helpers for the JS boundary ─────────────────────────────────

        /// <summary>
        /// Execute a query on the pooled connection and return the result set as JSON.
        /// </summary>
        /// <param name="connId">optional transaction pin id forwarded to <see cref="Execute"/>.</param>
        public string ExecuteJson(string sql, object? args = null, object? connId = null)
        {
            var nArgs = NormalizeArgs(args);
            var nConnId = NormalizeConnId(connId);
            var result = Execute(sql, nArgs, nConnId);
            return JsonSerializer.Serialize(result);
        }

        /// <summary>
        /// Execute a query on a fresh ad-hoc connection and return the result set as JSON.
        /// Used for external-database operations (e.g. data migration).
        /// </summary>
        public string ExecuteJsonOnConnection(string connectionString, string sql, object? args = null, object? connId = null)
        {
            var nId = NormalizeConnId(connId);
            var nArgs = NormalizeArgs(args);
            if (nId.HasValue)
            {
                var result = ExecutePinned(nId.Value, sql, nArgs);
                return JsonSerializer.Serialize(result);
            }
            var dataSource = DataSourceCache.GetOrAdd(connectionString, cs => NpgsqlDataSource.Create(cs));
            using var connection = dataSource.CreateConnection();
            connection.Open();
            var rows = ExecuteCore(connection, sql, nArgs);
            var table = ExtractTable(sql);
            if (table != null && _changeEnabled)
            {
                EmitChange(connectionString, table, -1, ReadDataVersion(connection));
            }
            return JsonSerializer.Serialize(rows);
        }

        // ── Query execution ──────────────────────────────────────────────────

        /// <summary>
        /// Execute a query on a fresh pooled connection and return rows as
        /// positional arrays. Parameters are positional (<c>$1</c>, <c>$2</c>,
        /// ...) and are bound from <paramref name="args"/> in order.
        ///
        /// Note: <paramref name="args"/>/<paramref name="connId"/> are
        /// <c>object?</c> (not <c>object[]</c>/<c>long?</c>) because CefSharp
        /// marshals JS arrays as <c>List&lt;object&gt;</c> and numbers as
        /// <c>Int32</c>; normalize via <see cref="NormalizeArgs"/> /
        /// <see cref="NormalizeConnId"/> before use.
        /// </summary>
        /// <param name="connId">optional transaction pin id; when present
        /// the query runs on the pinned connection inside its transaction
        /// and resets the sliding idle timer.</param>
        public object[][] Execute(string sql, object? args = null, object? connId = null)
        {
            var nArgs = NormalizeArgs(args);
            var nConnId = NormalizeConnId(connId);
            if (nConnId.HasValue)
            {
                return ExecutePinned(nConnId.Value, sql, nArgs);
            }
            EnsureInitialized();
            Interlocked.Increment(ref _totalBorrowed);
            try
            {
                using var connection = _dataSource.OpenConnection();
                Interlocked.Increment(ref _activeCount);
                try
                {
                    var rows = ExecuteCore(connection, sql, nArgs);
                    var table = ExtractTable(sql);
                    if (table != null && _changeEnabled)
                    {
                        // 先记漏斗时间戳再读 dv:NOTIFY 监听侧据此丢弃自写镜像
                        // (dv 读为 1 次 RTT,若在其后才记录,镜像先到导致去重失效)
                        _lastFunnelEmitTicks[table] = DateTime.UtcNow.Ticks;
                        EmitChange(ChangeConnDefault, table, -1, ReadDataVersion(connection));
                    }
                    return rows;
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
        /// Execute a non-query on a fresh pooled connection and return rows affected.
        /// </summary>
        /// <param name="connId">optional transaction pin id; when present
        /// the statement runs on the pinned connection inside its
        /// transaction and resets the sliding idle timer.</param>
        public int ExecuteNonQuery(string sql, object? args = null, object? connId = null)
        {
            var nArgs = NormalizeArgs(args);
            var nConnId = NormalizeConnId(connId);
            if (nConnId.HasValue)
            {
                return ExecuteNonQueryPinned(nConnId.Value, sql, nArgs);
            }
            EnsureInitialized();
            Interlocked.Increment(ref _totalBorrowed);
            try
            {
                using var connection = _dataSource.OpenConnection();
                Interlocked.Increment(ref _activeCount);
                try
                {
                    using var command = CreateCommand(connection, sql, nArgs);
                    var affected = command.ExecuteNonQuery();
                    var table = ExtractTable(sql);
                    if (table != null && _changeEnabled)
                    {
                        _lastFunnelEmitTicks[table] = DateTime.UtcNow.Ticks;
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
        /// Execute a non-query on a fresh ad-hoc connection and return rows affected.
        /// Used for external-database operations (e.g. data migration).
        /// </summary>
        public int ExecuteNonQueryOnConnection(string connectionString, string sql, object? args = null, object? connId = null)
        {
            var nId = NormalizeConnId(connId);
            var nArgs = NormalizeArgs(args);
            if (nId.HasValue)
            {
                return ExecuteNonQueryPinned(nId.Value, sql, nArgs);
            }
            var dataSource = DataSourceCache.GetOrAdd(connectionString, cs => NpgsqlDataSource.Create(cs));
            using var connection = dataSource.CreateConnection();
            connection.Open();
            using var command = CreateCommand(connection, sql, nArgs);
            var affected = command.ExecuteNonQuery();
            var table = ExtractTable(sql);
            if (table != null && _changeEnabled)
            {
                EmitChange(connectionString, table, affected, ReadDataVersion(connection));
            }
            return affected;
        }

        // ── Health checks ────────────────────────────────────────────────────

        /// <summary>
        /// 返回当前连接池的三态 + 扩展快照,纯内存计数器读取,不涉及网络调用。
        /// JS 侧每秒采样一次,用于底部栏三色波线展示(Issue #14)。
        ///
        /// 基础字段(所有引擎对称,JS 主用):
        ///   active           = 正在执行 SQL 的连接数(pinned + 非 pinned)
        ///   pinnedIdle       = 事务持有但未执行 SQL 的连接数
        ///   availableCapacity = 可用容量(_maxPoolSize - _totalBorrowed)
        ///   max              = 连接池上限
        ///
        /// 扩展字段(冗余校验,驱动版本变化可能失效,UI 不强依赖):
        ///   totalOpen  = 池中当前存活的物理连接总数(PG 反射真值;MySQL/SQLite 估算)
        ///   idleInPool = 池中存活且空闲的物理连接数(PG 反射真值;MySQL/SQLite 估算)
        /// 上层 JS 主用基础字段自算 idleInPool = totalOpen - active - pinnedIdle,
        /// 扩展字段仅供诊断/校验,不参与 UI 主显示链路。
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

            // 反射 PoolingDataSource.Statistics 拿真值。懒初始化,失败回退估算。
            if (!_statisticsReflected)
            {
                try
                {
                    // Statistics 是 NpgsqlDataSource 基类上的 internal abstract 属性,
                    // 运行时由 PoolingDataSource(internal sealed)实现。
                    // NonPublic | Instance 跨 internal 访问修饰符可见。
                    _statisticsProp = typeof(NpgsqlDataSource).GetProperty(
                        "Statistics",
                        BindingFlags.NonPublic | BindingFlags.Instance);
                }
                catch
                {
                    _statisticsProp = null;
                }
                _statisticsReflected = true;
            }

            if (_statisticsProp != null && _dataSource != null)
            {
                try
                {
                    var tuple = (ValueTuple<int, int, int>)_statisticsProp.GetValue(_dataSource);
                    // Item1=Total, Item2=Idle, Item3=Busy
                    totalOpen = tuple.Item1;
                    idleInPool = tuple.Item2;
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
        /// Clear idle connections from the pool. NpgsqlDataSource.Clear()
        /// drops idle connections immediately and marks busy connections to
        /// be closed when returned to the pool (rather than reused). In the
        /// VRCX desktop scenario busy connections are typically 0-3, so the
        /// cost of rebuilding them is acceptable — and the side effect is
        /// beneficial when the user suspects a connection leak.
        /// </summary>
        public void ClearIdleConnections()
        {
            _dataSource?.Clear();
        }

        /// <summary>
        /// Return true when the data source has been initialized.
        /// Does not probe the network — callers needing a real liveness
        /// check should use <see cref="Ping"/> (SELECT 1) or
        /// <see cref="GetHealth"/> (SELECT 1 + JSON latency snapshot).
        /// </summary>
        public bool IsConnected()
        {
            return _initialized && _dataSource != null;
        }

        /// <summary>
        /// Probe the server with <c>SELECT 1</c> and return a JSON health
        /// snapshot: <c>{ connected, latencyMs, lastHealthCheck }</c>.
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
                    try
                    {
                        using var conn = _dataSource.OpenConnection();
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
        /// succeeds against the pooled data source.
        /// </summary>
        public bool Ping()
        {
            try
            {
                Interlocked.Increment(ref _totalBorrowed);
                try
                {
                    using var conn = _dataSource.OpenConnection();
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

        // ── Core implementation ──────────────────────────────────────────────

        private static object[][] ExecuteCore(NpgsqlConnection connection, string sql, object[]? args)
        {
            using var command = CreateCommand(connection, sql, args);
            using var reader = command.ExecuteReader();

            var result = new List<object[]>();
            while (reader.Read())
            {
                var values = new object[reader.FieldCount];
                for (var i = 0; i < reader.FieldCount; i++)
                {
                    var value = reader.GetValue(i);
                    values[i] = value is DBNull ? null : value;
                }
                result.Add(values);
            }

            return result.ToArray();
        }

        private static NpgsqlCommand CreateCommand(NpgsqlConnection connection, string sql, object[]? args)
        {
            var command = connection.CreateCommand();
            command.CommandText = sql;
            if (args != null)
            {
                foreach (var arg in args)
                {
                    // Npgsql infers the parameter name from position when the
                    // command text uses $1, $2, ... placeholders.
                    command.Parameters.AddWithValue(null, arg ?? DBNull.Value);
                }
            }
            return command;
        }

        // ── Transaction pinning implementation ───────────────────────────────
        // See the field declarations at the top of this class for the design
        // rationale. BeginTransaction borrows a connection from the pool and
        // holds it in a TxHolder; ExecutePinned/ExecuteNonQueryPinned look up
        // the holder by connId and run SQL on the held connection, resetting
        // the sliding idle timer on each use. CommitTransaction/
        // RollbackTransaction finalise the transaction and return the
        // connection to the pool. The sliding timer auto-rolls-back any
        // transaction idle for longer than TX_IDLE_MS to prevent connection
        // leaks if JS forgets to commit (crash, unhandled rejection, etc.).

        private static NpgsqlCommand CreateTxCommand(TxHolder h, string sql, object[]? args)
        {
            var command = h.Conn.CreateCommand();
            command.Transaction = h.Tx;
            command.CommandText = sql;
            if (args != null)
            {
                foreach (var arg in args)
                {
                    command.Parameters.AddWithValue(null, arg ?? DBNull.Value);
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
            try { h.Tx.Rollback(); } catch { /* 可能已超时回滚 */ }
            try { h.Conn.Dispose(); } catch { }
        }

        private object[][] ExecutePinned(long connId, string sql, object[]? args)
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
                using var command = CreateTxCommand(h, sql, args);
                using var reader = command.ExecuteReader();
                var result = new List<object[]>();
                while (reader.Read())
                {
                    var values = new object[reader.FieldCount];
                    for (var i = 0; i < reader.FieldCount; i++)
                    {
                        var value = reader.GetValue(i);
                        values[i] = value is DBNull ? null : value;
                    }
                    result.Add(values);
                }
                RecordChange(h, ExtractTable(sql), -1);
                return result.ToArray();
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
                        // OnTxTimeout 在 SQL 执行期间来过,当时没清理
                        // (InFlight > 0),现在由 finally 收尾。
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

        private int ExecuteNonQueryPinned(long connId, string sql, object[]? args)
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
                var affected = command.ExecuteNonQuery();
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
                cs => NpgsqlDataSource.Create(cs));
            var connId = Interlocked.Increment(ref _nextConnId);
            Interlocked.Increment(ref _totalBorrowed);
            try
            {
                var conn = dataSource.OpenConnection();
                try
                {
                    var tx = conn.BeginTransaction();
                    var holder = new TxHolder { Conn = conn, Tx = tx, ConnLabel = connectionString };
                    holder.Timer = new Timer(
                        _ => OnTxTimeout(connId), null, TX_IDLE_MS, -1);
                    _pinned[connId] = holder;
                    return connId;
                }
                catch
                {
                    conn.Dispose();
                    throw;
                }
            }
            finally
            {
                if (!_pinned.ContainsKey(connId))
                    Interlocked.Decrement(ref _totalBorrowed);
            }
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
            try
            {
                var conn = _dataSource.OpenConnection();
                try
                {
                    var tx = conn.BeginTransaction();
                    var holder = new TxHolder { Conn = conn, Tx = tx, ConnLabel = ChangeConnDefault };
                    holder.Timer = new Timer(
                        _ => OnTxTimeout(connId), null, TX_IDLE_MS, -1);
                    _pinned[connId] = holder;
                    return connId;
                }
                catch
                {
                    conn.Dispose();
                    throw;
                }
            }
            finally
            {
                if (!_pinned.ContainsKey(connId))
                    Interlocked.Decrement(ref _totalBorrowed);
            }
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
            NpgsqlConnection conn;
            NpgsqlTransaction tx;
            lock (_txLock)
            {
                if (!_pinned.TryRemove(connId, out var h))
                    throw new InvalidOperationException(
                        $"connId={connId} 已超时回滚或不存在,无法 commit");
                h.Timer.Dispose();
                conn = h.Conn;
                tx = h.Tx;
                changes = h.Changes;
                connLabel = h.ConnLabel ?? ChangeConnDefault;
            }
            // 锁外 COMMIT+dv 读+归还:TryRemove 成功后连接已独占(Timer 已停),
            // 锁外执行不阻塞其他事务;COMMIT 失败时 finally 仍归还连接,
            // 异常传播且事件不发射(与现状锁内路径等价)。
            try
            {
                // 时间戳在 COMMIT 之前落账:NOTIFY 随 COMMIT 发送,监听线程
                // 处理镜像时时间戳必已存在(零竞态)
                if (connLabel == ChangeConnDefault && _changeEnabled && changes is { Count: > 0 })
                {
                    foreach (var kv in changes)
                    {
                        _lastFunnelEmitTicks[kv.Key] = DateTime.UtcNow.Ticks;
                    }
                }
                tx.Commit();
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
        /// return the connection to the pool. No-op (does not throw) if the
        /// connId has already been timed out / rolled back, so the JS-side
        /// withTransaction catch block can call it unconditionally.
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
                    $"[PG] 事务 connId={connId} 空闲 {TX_IDLE_MS}ms,自动回滚");
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

        // ── Bootstrap field validation ───────────────────────────────────────

        private static string ValidateField(string name, string value, string allowCharsPattern)
        {
            if (string.IsNullOrEmpty(value))
                throw new InvalidOperationException($"VRCX_Database.{name} is not set");
            if (value.IndexOfAny(new[] { ';', '\'', '"', '\0', '\n', '\r' }) >= 0)
                throw new InvalidOperationException($"VRCX_Database.{name} contains invalid characters");
            if (!Regex.IsMatch(value, "^" + allowCharsPattern + "+$"))
                throw new InvalidOperationException(
                    $"VRCX_Database.{name} has invalid characters (allowed: {allowCharsPattern})");
            return value;
        }

        private static string ValidatePassword(string password)
        {
            if (string.IsNullOrEmpty(password))
                throw new InvalidOperationException("VRCX_Database.password is not set");
            if (password.IndexOfAny(new[] { ';', '\'', '"', '\0' }) >= 0)
                throw new InvalidOperationException("VRCX_Database.password contains invalid characters");
            return password;
        }

        private static int ValidatePort(string portStr, int @default)
        {
            if (string.IsNullOrEmpty(portStr))
                return @default;
            if (!int.TryParse(portStr, out int port) || port < 1 || port > 65535)
                throw new InvalidOperationException($"VRCX_Database.port is invalid: {portStr}");
            return port;
        }

        private void EnsureInitialized()
        {
            if (_initialized)
                return;
            _connectionLock.EnterWriteLock();
            try
            {
                if (!_initialized)
                    Init();
            }
            finally
            {
                _connectionLock.ExitWriteLock();
            }
        }

        // ── IAuthStore implementation ──────────────────────────────────────
        // PostgreSQL 方言:位置参数 ($1/$2),INSERT ... ON CONFLICT DO
        // UPDATE upsert,cookies 表落在 public schema(与 PgSQLAdapter 全局
        // 表的 public.<tbl> 命名约定一致)。key/value 用 TEXT。

        /// <inheritdoc />
        public void EnsureCookiesTable()
        {
            ExecuteNonQuery(
                "CREATE TABLE IF NOT EXISTS public.cookies (key TEXT PRIMARY KEY, value TEXT)");
        }

        /// <inheritdoc />
        public string? LoadCookie(string key)
        {
            var values = Execute(
                "SELECT value FROM public.cookies WHERE key = $1",
                new object[] { key });
            return values.Length > 0 ? (string)values[0][0] : null;
        }

        /// <inheritdoc />
        public void SaveCookie(string key, string value)
        {
            ExecuteNonQuery(
                "INSERT INTO public.cookies (key, value) VALUES ($1, $2) " +
                "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
                new object[] { key, value });
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

        /// <summary>
        /// Normalize the ad-hoc args parameter. CefSharp marshals JS arrays
        /// as <c>List&lt;object&gt;</c>, which reflection cannot convert to
        /// <c>object[]</c> — so the <c>*OnConnection</c> methods accept
        /// <c>object?</c> and call this helper to produce an
        /// <c>object[]</c> suitable for <c>ExecutePinned</c>/<c>CreateCommand</c>.
        /// </summary>
        private static object[]? NormalizeArgs(object? args)
        {
            if (args == null || args is DBNull || args is Missing) return null;
            if (args is object[] arr) return arr;
            if (args is System.Collections.IList list)
            {
                var result = new object[list.Count];
                for (var i = 0; i < list.Count; i++)
                    result[i] = list[i];
                return result;
            }
            return null;
        }
    }
}
