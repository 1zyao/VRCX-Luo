// 设计稿 (M2 §2.10 M8 / §5.2 M14, BROWSE_MODE_M2_DESIGN.md)
// 文件名: PostgreSqlBrowseModeTests.cs
// 用途: PostgreSQL 引擎浏览模式 (VRCX_NodeMode=browse) 连接层只读回归测试
//   ① 连接串断言: browse 追加 ;Options=-c default_transaction_read_only=on;
//   ② collector 连接串无只读片段回归 (M1 验收硬线;Npgsql 再序列化连接串,
//      逐字符基线不可行,按关键标记断言);
//   ③ env-gated 真库只读拒绝 [Category=ReadOnlyRejection] (PG_TEST_HOST 未设则 Skip)。
// 依赖策略 (同 PostgreSqlBridgeTests.cs): Link PostgreSQL.cs 编译进 VRCX.Tests.dll,
//   同 assembly internal 直接可见; VRCXStorage stub 控制 VRCX_NodeMode / VRCX_Database.*。
//   Init() 只构造连接池 (建连惰性, 不触达真实 DB), 无 env 时不会尝试连接。

using System.Reflection;

namespace VRCX.Tests;

[Collection("SQLiteStaticState")]
[Trait("Component", "PostgreSQL.BrowseMode")]
public class PostgreSqlBrowseModeTests : IDisposable
{
    public PostgreSqlBrowseModeTests()
    {
        VRCXStorage.Instance.Clear();
    }

    public void Dispose()
    {
        VRCXStorage.Instance.Clear();
    }

    /// <summary>
    /// 读取 PostgreSQL 实例的池连接串 (私有字段 _dataSource 反射;字段漂移即 Fail)。
    /// NpgsqlDataSource.ConnectionString 反映 NpgsqlDataSourceBuilder 传入的原始串。
    /// </summary>
    private static string GetConnectionString(PostgreSQL pg)
    {
        var field = typeof(PostgreSQL).GetField("_dataSource", BindingFlags.NonPublic | BindingFlags.Instance)
            ?? throw new InvalidOperationException("PostgreSQL._dataSource 字段不存在 — 生产字段漂移");
        var dataSource = (Npgsql.NpgsqlDataSource?)field.GetValue(pg)
            ?? throw new InvalidOperationException("PostgreSQL._dataSource 为 null — Init() 未执行");
        return dataSource.ConnectionString;
    }

    private static void Configure(string nodeMode)
    {
        VRCXStorage.Instance.Set("VRCX_NodeMode", nodeMode);
        VRCXStorage.Instance.Set("VRCX_Database.host", "127.0.0.1");
        VRCXStorage.Instance.Set("VRCX_Database.port", "5432");
        VRCXStorage.Instance.Set("VRCX_Database.username", "vrcx");
        VRCXStorage.Instance.Set("VRCX_Database.password", "vrcx");
        VRCXStorage.Instance.Set("VRCX_Database.name", "vrcx_test");
    }

    [Fact]
    [Trait("Category", "BrowseMode")]
    public void Init_BrowseMode_ConnectionStringContainsReadOnlyOption()
    {
        Configure("browse");
        var pg = new PostgreSQL();
        pg.Init();

        var cs = GetConnectionString(pg);
        // NpgsqlDataSourceBuilder 会对连接串再序列化 (Options 加引号、CommandTimeout 空格化)
        cs.Should().Contain("default_transaction_read_only=on");
        cs.Should().Contain("Options=");
    }

    [Fact]
    [Trait("Category", "BrowseMode")]
    public void Init_CollectorMode_ConnectionStringNoReadOnlyOption()
    {
        Configure("auto");
        var pg = new PostgreSQL();
        pg.Init();

        var cs = GetConnectionString(pg);
        // collector/auto 基线回归:不得混入只读片段。Npgsql 再序列化会规范化
        // 连接串 (Password 从 ConnectionString 移除),故按关键标记断言而非逐字符。
        cs.Should().Contain("Host=127.0.0.1");
        cs.Should().Contain("Port=5432");
        cs.Should().Contain("Database=vrcx_test");
        cs.Should().NotContain("read_only");
    }

    [Fact]
    [Trait("Category", "BrowseMode")]
    public void BrowseAndCollector_ConnectionStrings_Differ_InCacheKey()
    {
        // 只读/可写缓存共存 (M2 §5.2 / review #16):ExecuteJsonOnConnection 的
        // DataSourceCache 以连接串为键 (PostgreSQL.cs GetOrAdd(connectionString,...)),
        // browse 追加 Options 片段 → 与 collector 键不同 → 两条目天然共存,
        // 不会出现"collector 缓存的可写连接被 browse 复用"破坏只读兜底。
        // 静态字段反射:键类型为 string,值类型为 NpgsqlDataSource,证明按串隔离。
        var cacheField = typeof(PostgreSQL).GetField("DataSourceCache",
            BindingFlags.NonPublic | BindingFlags.Static)
            ?? throw new InvalidOperationException("PostgreSQL.DataSourceCache 静态字段不存在 — 生产字段漂移");
        var cacheType = cacheField.FieldType;
        cacheType.IsGenericType.Should().BeTrue();
        cacheType.GetGenericArguments()[0].Should().Be(typeof(string));

        Configure("browse");
        var browsePg = new PostgreSQL();
        browsePg.Init();
        var browseCs = GetConnectionString(browsePg);

        Configure("auto");
        var collectorPg = new PostgreSQL();
        collectorPg.Init();
        var collectorCs = GetConnectionString(collectorPg);

        browseCs.Should().NotBe(collectorCs);
        browseCs.Should().Contain("default_transaction_read_only=on");
        collectorCs.Should().NotContain("read_only");
    }

    [Fact]
    [Trait("Category", "ReadOnlyRejection")]
    public void ExecuteNonQuery_BrowseMode_RealDb_ThrowsReadOnly()
    {
        var host = Environment.GetEnvironmentVariable("PG_TEST_HOST");
        if (string.IsNullOrWhiteSpace(host))
        {
            // 本地/无 env 时跳过,但打印原因避免"静默全绿掩盖真库用例从未执行"(review #18)。
            // 说明:本 runner 组合 (SDK 17.11.1 / xunit.runner.visualstudio 2.8.2) 不解释
            // $XunitDynamicSkip$ 动态跳过标记 (会显示 FAIL),故用 return+显式输出而非
            // SkipException.ForSkip。CI (M26 test_pgsql job 自带 PG_TEST_* env) 才真正执行。
            Console.WriteLine("[SKIP] PG_TEST_HOST 未设置,跳过真库只读拒绝验证 (CI 注入后生效)");
            return;
        }
        var port = Environment.GetEnvironmentVariable("PG_TEST_PORT") ?? "5432";
        var user = Environment.GetEnvironmentVariable("PG_TEST_USER") ?? "vrcx";
        var password = Environment.GetEnvironmentVariable("PG_TEST_PASSWORD") ?? "vrcx";
        var name = Environment.GetEnvironmentVariable("PG_TEST_DB") ?? "vrcx_test";

        VRCXStorage.Instance.Set("VRCX_NodeMode", "browse");
        VRCXStorage.Instance.Set("VRCX_Database.host", host);
        VRCXStorage.Instance.Set("VRCX_Database.port", port);
        VRCXStorage.Instance.Set("VRCX_Database.username", user);
        VRCXStorage.Instance.Set("VRCX_Database.password", password);
        VRCXStorage.Instance.Set("VRCX_Database.name", name);

        var pg = new PostgreSQL();
        pg.Init();

        // 只读事务下任何写被服务端拒绝 (default_transaction_read_only=on)
        var act = () => pg.ExecuteNonQuery("CREATE TABLE read_only_probe (id INTEGER)");
        act.Should().Throw<Npgsql.PostgresException>()
            .Where(e => e.Message.Contains("read-only transaction") || e.SqlState == "25006");
    }
}
