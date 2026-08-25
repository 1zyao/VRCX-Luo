// 设计稿 (M2 §2.10 M9 / §5.2 M15, BROWSE_MODE_M2_DESIGN.md)
// 文件名: MySqlBrowseModeTests.cs
// 用途: MySQL 引擎浏览模式 (VRCX_NodeMode=browse) 连接层只读回归测试
//   ① browse Init 成功且连接串保持基线 (只读在会话层 SET SESSION, 不追加连接串片段);
//   ② collector 连接串无只读片段回归 (M1 验收硬线;只读在会话层,串本身无片段);
//   ③ env-gated 真库只读拒绝 [Category=ReadOnlyRejection] (MYSQL_TEST_HOST 未设则 Skip),
//      MySQL 报 error 1792 (ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION)。
// 依赖策略 (同 MySqlBridgeTests.cs): Link MySQL.cs 编译进 VRCX.Tests.dll,
//   同 assembly internal 直接可见; VRCXStorage stub 控制 VRCX_NodeMode / VRCX_Database.*。
//   Init() 只构造连接池 (建连惰性), 无 env 时不会尝试连接。

using System.Reflection;

namespace VRCX.Tests;

[Collection("SQLiteStaticState")]
[Trait("Component", "MySQL.BrowseMode")]
public class MySqlBrowseModeTests : IDisposable
{
    public MySqlBrowseModeTests()
    {
        VRCXStorage.Instance.Clear();
    }

    public void Dispose()
    {
        VRCXStorage.Instance.Clear();
    }

    /// <summary>
    /// 读取 MySQL 实例的池连接串 (私有字段 _dataSource 反射;字段漂移即 Fail)。
    /// MySqlDataSource.ConnectionString 反映 MySqlDataSourceBuilder/构造器传入的原始串。
    /// </summary>
    private static string GetConnectionString(MySQL mysql)
    {
        var field = typeof(MySQL).GetField("_dataSource", BindingFlags.NonPublic | BindingFlags.Instance)
            ?? throw new InvalidOperationException("MySQL._dataSource 字段不存在 — 生产字段漂移");
        var dataSource = (MySqlConnector.MySqlDataSource?)field.GetValue(mysql)
            ?? throw new InvalidOperationException("MySQL._dataSource 为 null — Init() 未执行");
        return dataSource.ConnectionString;
    }

    private static void Configure(string nodeMode)
    {
        VRCXStorage.Instance.Set("VRCX_NodeMode", nodeMode);
        VRCXStorage.Instance.Set("VRCX_Database.host", "127.0.0.1");
        VRCXStorage.Instance.Set("VRCX_Database.port", "3306");
        VRCXStorage.Instance.Set("VRCX_Database.username", "vrcx");
        VRCXStorage.Instance.Set("VRCX_Database.password", "vrcx");
        VRCXStorage.Instance.Set("VRCX_Database.name", "vrcx_test");
    }

    [Fact]
    [Trait("Category", "BrowseMode")]
    public void Init_BrowseMode_ConnectionStringNoReadOnlyFragment()
    {
        Configure("browse");
        var mysql = new MySQL();
        mysql.Init();

        // 只读在会话层 (UseConnectionOpenedCallback → SET SESSION TRANSACTION READ
        // ONLY), 连接串不追加任何片段 — 保持 collector 基线一致。MySQL 与 collector
        // 连接串完全同形 (连接串规范序列化: Password 保留、端口 3306、参数空格化)。
        var cs = GetConnectionString(mysql);
        cs.Should().Contain("Server=127.0.0.1");
        cs.Should().Contain("Port=3306");
        cs.Should().Contain("Database=vrcx_test");
        cs.Should().NotContain("readonly");

        // 回调钩子 (review #15/#19):browse 必须注册连接打开只读回调,
        // 否则会话层 SET SESSION READ ONLY 从未执行,真库拒绝用例依赖的前提失效。
        mysql.IsBrowseReadOnlyConfigured.Should().BeTrue();
    }

    [Fact]
    [Trait("Category", "BrowseMode")]
    public void Init_CollectorMode_ConnectionStringMatchesBaseline()
    {
        Configure("auto");
        var mysql = new MySQL();
        mysql.Init();

        var cs = GetConnectionString(mysql);
        cs.Should().Contain("Server=127.0.0.1");
        cs.Should().Contain("Port=3306");
        cs.Should().Contain("Database=vrcx_test");
        cs.Should().NotContain("readonly");

        // 反向对照:collector 绝不注册只读回调(误删外层 if 恒注册会被此断言拦截)。
        mysql.IsBrowseReadOnlyConfigured.Should().BeFalse();
    }

    [Fact]
    [Trait("Category", "ReadOnlyRejection")]
    public void ExecuteNonQuery_BrowseMode_RealDb_ThrowsReadOnly()
    {
        var host = Environment.GetEnvironmentVariable("MYSQL_TEST_HOST");
        if (string.IsNullOrWhiteSpace(host))
        {
            // 本地/无 env 时跳过,但打印原因避免"静默全绿掩盖真库用例从未执行"(review #18)。
            // 说明:本 runner 组合 (SDK 17.11.1 / xunit.runner.visualstudio 2.8.2) 不解释
            // $XunitDynamicSkip$ 动态跳过标记 (会显示 FAIL),故用 return+显式输出而非
            // SkipException.ForSkip。CI (M26 test_mysql job 自带 MYSQL_TEST_* env) 才真正执行。
            Console.WriteLine("[SKIP] MYSQL_TEST_HOST 未设置,跳过真库只读拒绝验证 (CI 注入后生效)");
            return;
        }
        var port = Environment.GetEnvironmentVariable("MYSQL_TEST_PORT") ?? "3306";
        var user = Environment.GetEnvironmentVariable("MYSQL_TEST_USER") ?? "root";
        var password = Environment.GetEnvironmentVariable("MYSQL_TEST_PASSWORD") ?? "root";
        var name = Environment.GetEnvironmentVariable("MYSQL_TEST_DATABASE") ?? "vrcx_test";

        VRCXStorage.Instance.Set("VRCX_NodeMode", "browse");
        VRCXStorage.Instance.Set("VRCX_Database.host", host);
        VRCXStorage.Instance.Set("VRCX_Database.port", port);
        VRCXStorage.Instance.Set("VRCX_Database.username", user);
        VRCXStorage.Instance.Set("VRCX_Database.password", password);
        VRCXStorage.Instance.Set("VRCX_Database.name", name);

        var mysql = new MySQL();
        mysql.Init();

        // 只读会话下任何写被服务端拒绝 (error 1792 ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION)
        var act = () => mysql.ExecuteNonQuery("CREATE TABLE read_only_probe (id INTEGER)");
        act.Should().Throw<MySqlConnector.MySqlException>()
            .Where(e => e.Number == 1792 || e.Message.Contains("read-only transaction"));
    }
}
