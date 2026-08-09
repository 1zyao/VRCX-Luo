// 设计稿 (Stage 2 solutions-architect 输出, PR #17 回归测试)
// 文件名: SQLiteBridgeTests.cs
// 用途: SQLite 引擎 connId 桥接回归测试 — NormalizeConnId 补缺 4 条 + 桥接 9 条
// 最终位置: Dotnet/VRCX.Tests/SQLiteBridgeTests.cs
//
// 依赖策略 (同 SQLiteRetryTests.cs): Link SQLite.cs 编译进 VRCX.Tests.dll, 同 assembly
//   internal 直接可见, 不需 [InternalsVisibleTo], 不改生产代码。
//   [Collection("SQLiteStaticState")]: 与 SQLiteSecurityTests/SQLiteRetryTests 串行,
//   共享 Program 静态状态 fixture (本类不触碰静态, 仅为避免与同类静态测试并发)。
//
// 补缺归属 (C7): NormalizeConnId 前 10 条已在 SQLiteRetryTests.cs 覆盖
//   (有效: null/DBNull/Missing/1/999L/3.0d; 无效: 3.14d/NaN/+Infinity/"abc"),
//   本文件只补 SQLite 侧缺失的 4 条无效值: -Infinity / 1e300d / MaxValue / MinValue
//   (1 个 Theory × 4 InlineData; PG/MySQL 侧全量 14 条共享 BridgeTestHelper MemberData)。
//
// 用例计数 (13 条 / 13 执行用例):
//   NormalizeConnId 补缺 4 (Theory × 4 InlineData)
//   桥接 9 (ExecuteJson/Execute/ExecuteNonQuery × 3.14d/NaN/"abc")
//
// 桥接判别: 见 BridgeTestHelper.cs 文件头 — GetMethodOrFail 以精确参数类型数组
//   (string, IDictionary<string,object>, object) 定位; AssertDomainException 只接受
//   域内 inner ArgumentException 且消息含 "connId" (C2), 裸 ArgumentException
//   (绑定层) / 未抛异常均 Fail。
//   C1: 桥接代表值禁用 Missing.Value 与 null — 只用 3.14d / double.NaN / "abc"。
//   SQLite 桥接 args 传 Dictionary<string, object> { { "@x", 1 } }
//   (与生产 Execute* 签名 IDictionary<string, object>? args 一致)。

namespace VRCX.Tests;

using System.Data.SQLite;
using System.Reflection;

[Collection("SQLiteStaticState")]
[Trait("Component", "SQLite.Bridge")]
public class SQLiteBridgeTests : IDisposable
{
    private readonly string _origAppDataDir;
    private readonly string _origConfigLocation;
    private readonly string _tempDir;

    public SQLiteBridgeTests()
    {
        // Setup: 保存 Program 静态字段原值 → 创建唯一临时目录 → 赋值;清空 VRCXStorage
        // (M1 S2 Init() 测试需要可控的 VRCX_NodeMode / VRCX_Database.name 配置)
        _origAppDataDir = Program.AppDataDirectory;
        _origConfigLocation = Program.ConfigLocation;
        _tempDir = Path.Combine(Path.GetTempPath(), "VRCX-Tests-" + Guid.NewGuid().ToString("N")[..8]);
        Directory.CreateDirectory(_tempDir);
        Program.AppDataDirectory = _tempDir;
        Program.ConfigLocation = Path.Combine(_tempDir, "VRCX.sqlite3");
        VRCXStorage.Instance.Clear();
    }

    public void Dispose()
    {
        // Teardown: 清空 VRCXStorage → 还原原值 → 删除临时目录 (try/catch 吞掉删除失败)
        VRCXStorage.Instance.Clear();
        Program.AppDataDirectory = _origAppDataDir;
        Program.ConfigLocation = _origConfigLocation;
        try { Directory.Delete(_tempDir, recursive: true); } catch { }
    }
    // ===========================================================================
    // NormalizeConnId 补缺 (4 条) — [Trait("Category", "NormalizeConnId")]
    // 补缺归属: 见文件头 (C7)。这 4 个 double 值 (-Infinity / 1e300 / MaxValue /
    // MinValue) 不在 SQLiteRetryTests.cs 的 10 条覆盖内: 前两者命中
    // !double.IsInfinity / d >= long.MinValue 守卫, 后两者命中 d <= long.MaxValue 守卫。
    // 实际代码: SQLite.cs L808-823 (internal static long? NormalizeConnId(object? connId))
    // ===========================================================================

    [Theory]
    [InlineData(double.NegativeInfinity)]
    [InlineData(1e300d)]
    [InlineData(double.MaxValue)]
    [InlineData(double.MinValue)]
    [Trait("Category", "NormalizeConnId")]
    public void NormalizeConnId_NonRepresentableDouble_ThrowsArgumentException(double value)
    {
        var act = () => SQLite.NormalizeConnId(value);
        act.Should().Throw<ArgumentException>().WithMessage("*connId*");
    }

    // ===========================================================================
    // 桥接 (9 条) — [Trait("Category", "Bridge")]
    // 验证 ExecuteJson/Execute/ExecuteNonQuery 三方法的 object? connId 参数在收到
    // 无效值时于 NormalizeConnId 域内早抛 (ArgumentException 含 "connId"), 而不是
    // 延迟到 DB 层/绑定层。C1: 桥接代表值禁用 Missing.Value 与 null, 只用
    // 3.14d / double.NaN / "abc" (见 BridgeTestHelper.cs 文件头)。
    // GetMethod 参数类型数组: (string, IDictionary<string,object>, object)。
    // args 传 Dictionary<string, object> { { "@x", 1 } } — 与生产签名一致,
    // 验证对象通过反射绑定 (Execute* 是 public instance, 反射只为精确断言签名,
    // 判别器逻辑见 BridgeTestHelper.AssertDomainException)。
    // ===========================================================================

    [Fact]
    [Trait("Category", "Bridge")]
    public void ExecuteJson_DoubleConnId_ThrowsNormalizeArgumentException()
    {
        var method = BridgeTestHelper.GetMethodOrFail(typeof(SQLite), "ExecuteJson",
            typeof(string), typeof(IDictionary<string, object>), typeof(object));
        var instance = new SQLite();
        var args = new object?[] { "SELECT 1", new Dictionary<string, object> { { "@x", 1 } }, (double)3.14 };
        BridgeTestHelper.AssertDomainException(method, instance, args);
    }

    [Fact]
    [Trait("Category", "Bridge")]
    public void ExecuteJson_NaNDoubleConnId_ThrowsNormalizeArgumentException()
    {
        var method = BridgeTestHelper.GetMethodOrFail(typeof(SQLite), "ExecuteJson",
            typeof(string), typeof(IDictionary<string, object>), typeof(object));
        var instance = new SQLite();
        var args = new object?[] { "SELECT 1", new Dictionary<string, object> { { "@x", 1 } }, double.NaN };
        BridgeTestHelper.AssertDomainException(method, instance, args);
    }

    [Fact]
    [Trait("Category", "Bridge")]
    public void ExecuteJson_StringConnId_ThrowsNormalizeArgumentException()
    {
        var method = BridgeTestHelper.GetMethodOrFail(typeof(SQLite), "ExecuteJson",
            typeof(string), typeof(IDictionary<string, object>), typeof(object));
        var instance = new SQLite();
        var args = new object?[] { "SELECT 1", new Dictionary<string, object> { { "@x", 1 } }, "abc" };
        BridgeTestHelper.AssertDomainException(method, instance, args);
    }

    [Fact]
    [Trait("Category", "Bridge")]
    public void Execute_DoubleConnId_ThrowsNormalizeArgumentException()
    {
        var method = BridgeTestHelper.GetMethodOrFail(typeof(SQLite), "Execute",
            typeof(string), typeof(IDictionary<string, object>), typeof(object));
        var instance = new SQLite();
        var args = new object?[] { "SELECT 1", new Dictionary<string, object> { { "@x", 1 } }, (double)3.14 };
        BridgeTestHelper.AssertDomainException(method, instance, args);
    }

    [Fact]
    [Trait("Category", "Bridge")]
    public void Execute_NaNDoubleConnId_ThrowsNormalizeArgumentException()
    {
        var method = BridgeTestHelper.GetMethodOrFail(typeof(SQLite), "Execute",
            typeof(string), typeof(IDictionary<string, object>), typeof(object));
        var instance = new SQLite();
        var args = new object?[] { "SELECT 1", new Dictionary<string, object> { { "@x", 1 } }, double.NaN };
        BridgeTestHelper.AssertDomainException(method, instance, args);
    }

    [Fact]
    [Trait("Category", "Bridge")]
    public void Execute_StringConnId_ThrowsNormalizeArgumentException()
    {
        var method = BridgeTestHelper.GetMethodOrFail(typeof(SQLite), "Execute",
            typeof(string), typeof(IDictionary<string, object>), typeof(object));
        var instance = new SQLite();
        var args = new object?[] { "SELECT 1", new Dictionary<string, object> { { "@x", 1 } }, "abc" };
        BridgeTestHelper.AssertDomainException(method, instance, args);
    }

    [Fact]
    [Trait("Category", "Bridge")]
    public void ExecuteNonQuery_DoubleConnId_ThrowsNormalizeArgumentException()
    {
        var method = BridgeTestHelper.GetMethodOrFail(typeof(SQLite), "ExecuteNonQuery",
            typeof(string), typeof(IDictionary<string, object>), typeof(object));
        var instance = new SQLite();
        var args = new object?[] { "SELECT 1", new Dictionary<string, object> { { "@x", 1 } }, (double)3.14 };
        BridgeTestHelper.AssertDomainException(method, instance, args);
    }

    [Fact]
    [Trait("Category", "Bridge")]
    public void ExecuteNonQuery_NaNDoubleConnId_ThrowsNormalizeArgumentException()
    {
        var method = BridgeTestHelper.GetMethodOrFail(typeof(SQLite), "ExecuteNonQuery",
            typeof(string), typeof(IDictionary<string, object>), typeof(object));
        var instance = new SQLite();
        var args = new object?[] { "SELECT 1", new Dictionary<string, object> { { "@x", 1 } }, double.NaN };
        BridgeTestHelper.AssertDomainException(method, instance, args);
    }

    [Fact]
    [Trait("Category", "Bridge")]
    public void ExecuteNonQuery_StringConnId_ThrowsNormalizeArgumentException()
    {
        var method = BridgeTestHelper.GetMethodOrFail(typeof(SQLite), "ExecuteNonQuery",
            typeof(string), typeof(IDictionary<string, object>), typeof(object));
        var instance = new SQLite();
        var args = new object?[] { "SELECT 1", new Dictionary<string, object> { { "@x", 1 } }, "abc" };
        BridgeTestHelper.AssertDomainException(method, instance, args);
    }

    // ===========================================================================
    // M1 浏览模式 (S2) — [Trait("Category", "BrowseMode")]
    // 覆盖设计 §6.2: ① 连接串断言 (browse 只读串 + collector 基线逐字符相等);
    // ② 连接层拒绝 (真文件库 INSERT/DDL 抛 readonly, SELECT 正常) — 验收核心自动化证据;
    // ③ 缺文件 fail-fast 可行动报错 (设计 §4.4 MEDIUM-4)。
    //
    // 连接串经反射读取私有字段 _connectionString (不改生产代码, 同 BridgeTestHelper
    // 反射风格;测试 assembly 与 SQLite.cs 同 assembly, 反射仅为读取私有字段)。
    //
    // Init() 依赖: VRCXStorage stub (Set/Clear) + Program 静态路径 (ctor Setup 已处理)。
    // 真库测试依赖 System.Data.SQLite native 运行时 (win-x64 SQLite.Interop.dll)。
    // ===========================================================================

    /// <summary>
    /// 读取 SQLite 实例的连接串 (私有字段 _connectionString 反射;字段漂移即 Fail)。
    /// </summary>
    private static string GetConnectionString(SQLite sqlite)
    {
        var field = typeof(SQLite).GetField("_connectionString", BindingFlags.NonPublic | BindingFlags.Instance)
            ?? throw new InvalidOperationException("SQLite._connectionString 字段不存在 — 生产字段漂移");
        return (string?)field.GetValue(sqlite) ?? string.Empty;
    }

    /// <summary>
    /// 在临时目录创建含表 t(id INTEGER PRIMARY KEY, val TEXT) 的真实 SQLite 文件库
    /// (可写连接, Pooling=False 避免 ADO.NET 池驻留文件句柄)。
    /// </summary>
    private string CreateDbWithTable(string fileName)
    {
        var dbPath = Path.Combine(_tempDir, fileName);
        using var conn = new SQLiteConnection($"Data Source=\"{dbPath}\";Version=3;Pooling=False");
        conn.Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT)";
        cmd.ExecuteNonQuery();
        return dbPath;
    }

    [Fact]
    [Trait("Category", "BrowseMode")]
    public void Init_BrowseMode_ConnectionStringContainsReadOnlyAndNoPragma()
    {
        // 缺文件前置检查要求 browse 下文件已存在 → 先创建空库
        var dbPath = Path.Combine(_tempDir, "browse.db");
        SQLiteConnection.CreateFile(dbPath);

        VRCXStorage.Instance.Set("VRCX_NodeMode", "browse");
        VRCXStorage.Instance.Set("VRCX_Database.name", "browse.db");

        var sqlite = new SQLite();
        sqlite.Init();

        // Data Source + Version=3 + Read Only=True + Pooling + Max Pool Size (设计 §5)
        var cs = GetConnectionString(sqlite);
        var expected = $"Data Source=\"{dbPath}\";Version=3;Read Only=True;Pooling=True;Max Pool Size=16";
        cs.Should().Be(expected);
        // 跳过 CollectOptions() 四 PRAGMA (journal_mode/optimize 只读连接为写操作)
        cs.Should().NotContain("PRAGMA");
    }

    [Fact]
    [Trait("Category", "BrowseMode")]
    public void Init_CollectorMode_ConnectionStringMatchesBaselineByteForByte()
    {
        // collector/auto 基线回归线 (M1 验收硬性保证):连接串构造逐字符不变。
        // 期望值由改动前的构造逻辑推演: Data Source;Version=3;Pooling;Max Pool Size
        // + DefaultOptions 四 PRAGMA (insertion order: locking_mode/busy_timeout/
        // journal_mode/optimize)。
        VRCXStorage.Instance.Set("VRCX_NodeMode", "auto");
        VRCXStorage.Instance.Set("VRCX_Database.name", "collector.db");

        var sqlite = new SQLite();
        sqlite.Init();

        var cs = GetConnectionString(sqlite);
        var dbPath = Path.Combine(_tempDir, "collector.db");
        var expected = $"Data Source=\"{dbPath}\";Version=3;Pooling=True;Max Pool Size=16;" +
            "PRAGMA locking_mode=NORMAL;PRAGMA busy_timeout=5000;PRAGMA journal_mode=WAL;PRAGMA optimize=0x10002";
        cs.Should().Be(expected);
        // 反向保护:collector 串不得混入只读标记
        cs.Should().NotContain("Read Only");
    }

    [Fact]
    [Trait("Category", "BrowseMode")]
    public void ExecuteNonQuery_Insert_BrowseMode_ThrowsReadonlyDatabase()
    {
        // 连接层拒绝 (验收核心自动化证据):browse 真库 INSERT → readonly 错误
        CreateDbWithTable("reject-insert.db");
        VRCXStorage.Instance.Set("VRCX_NodeMode", "browse");
        VRCXStorage.Instance.Set("VRCX_Database.name", "reject-insert.db");

        var sqlite = new SQLite();
        sqlite.Init();

        var act = () => sqlite.ExecuteNonQuery("INSERT INTO t (val) VALUES ('y')");
        act.Should().Throw<SQLiteException>().WithMessage("*attempt to write a readonly database*");
    }

    [Fact]
    [Trait("Category", "BrowseMode")]
    public void ExecuteNonQuery_CreateTable_BrowseMode_ThrowsReadonlyDatabase()
    {
        // 连接层拒绝:DDL (CREATE TABLE) 同样被只读连接拒绝
        CreateDbWithTable("reject-ddl.db");
        VRCXStorage.Instance.Set("VRCX_NodeMode", "browse");
        VRCXStorage.Instance.Set("VRCX_Database.name", "reject-ddl.db");

        var sqlite = new SQLite();
        sqlite.Init();

        var act = () => sqlite.ExecuteNonQuery("CREATE TABLE t2 (id INTEGER)");
        act.Should().Throw<SQLiteException>().WithMessage("*attempt to write a readonly database*");
    }

    [Fact]
    [Trait("Category", "BrowseMode")]
    public void ExecuteJson_Select_BrowseMode_Succeeds()
    {
        // browse 读路径不受影响:ExecuteJson("SELECT 1") 正常返回 JSON
        CreateDbWithTable("reject-select.db");
        VRCXStorage.Instance.Set("VRCX_NodeMode", "browse");
        VRCXStorage.Instance.Set("VRCX_Database.name", "reject-select.db");

        var sqlite = new SQLite();
        sqlite.Init();

        var result = sqlite.ExecuteJson("SELECT 1");
        result.Should().Be("[[1]]");
    }

    [Fact]
    [Trait("Category", "BrowseMode")]
    public void Init_BrowseMode_MissingDatabaseFile_ThrowsActionableError()
    {
        // 缺文件 fail-fast (设计 §4.4):browse + 文件不存在 → 抛含可行动文案的
        // InvalidOperationException,而非裸 "unable to open database file"
        VRCXStorage.Instance.Set("VRCX_NodeMode", "browse");
        VRCXStorage.Instance.Set("VRCX_Database.name", "missing.db");

        var sqlite = new SQLite();
        var act = () => sqlite.Init();
        var dbPath = Path.Combine(_tempDir, "missing.db");
        act.Should().Throw<InvalidOperationException>()
            .WithMessage($"*浏览模式：数据库文件不存在：{dbPath}。请先以 collector 模式启动一次完成初始化，或检查 VRCX_Database.name 配置。*");
    }
}
