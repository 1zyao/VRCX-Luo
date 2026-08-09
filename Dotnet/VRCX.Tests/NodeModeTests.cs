// 设计稿 (Stage 2 solutions-architect 输出, M1 S2 — 浏览模式归一化契约)
// 文件名: NodeModeTests.cs
// 用途: NodeMode.Normalize / IsBrowseMode 单测 (MEDIUM-5 双端一致契约的 C# 端)
// 最终位置: Dotnet/VRCX.Tests/NodeModeTests.cs
//
// 依赖策略 (同 SQLiteBridgeTests.cs): Link NodeMode.cs 编译进 VRCX.Tests.dll,
//   同 assembly internal 直接可见, 不需 [InternalsVisibleTo], 不改生产代码。
//   [Collection("SQLiteStaticState")]: 与 SQLiteSecurityTests/SQLiteBridgeTests 串行,
//   共享 Program / VRCXStorage.Instance 静态状态 (本类经 Set/Clear 写 VRCXStorage)。
//
// 契约 (设计 §2.5 决策 7 补充, 与 JS readOnlyGate.normalizeNodeMode 等价):
//   trim+lower === 'browse' → 'browse'; 其余 (auto/collector/空/null/非法) → 'collector'
//   (fail-safe — 判定错误的最坏后果是"collector 照常运行", 绝不反向造成 browse 误判)。
//   双端同表: 本文件 ↔ readOnlyGate.test.js。
//
// 用例计数:
//   Normalize 契约表 15 (Theory × 15 InlineData, 含大小写/空白/空/null/非法/换行注入)
//   IsBrowseMode 生效 2 (browse 及大小写空白变体)
//   IsBrowseMode 不生效 5 (auto/collector/空/未设置/非法)
//   F-3 日志安全化 2 (换行注入回显已净化 / 超长截断)

namespace VRCX.Tests;

[Collection("SQLiteStaticState")]
[Trait("Component", "NodeMode")]
public class NodeModeTests : IDisposable
{
    private readonly string _origAppDataDir;
    private readonly string _origConfigLocation;
    private readonly string _tempDir;

    public NodeModeTests()
    {
        // Setup: 保存 Program 静态字段原值 → 创建唯一临时目录 → 赋值;清空 VRCXStorage
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
    // Normalize 契约表 — [Trait("Category", "Normalize")]
    // 与 JS normalizeNodeMode 同表用例。'BROWSE' 为 browse 关键字的大小写变体
    // (契约 trim+lower, 大小写不敏感) → browse;其余非 browse/auto/collector → collector。
    // ===========================================================================

    [Theory]
    [InlineData("browse", "browse")]
    [InlineData("Browse", "browse")]
    [InlineData(" Browse ", "browse")]
    [InlineData("BROWSE", "browse")]
    [InlineData(" bRoWsE ", "browse")]
    [InlineData("auto", "collector")]
    [InlineData("AUTO", "collector")]
    [InlineData("collector", "collector")]
    [InlineData("", "collector")]
    [InlineData("  ", "collector")]
    [InlineData(null, "collector")]
    [InlineData("garbage", "collector")]
    [InlineData("auto-mode", "collector")]
    // F-3: 含控制字符的非法值 — 归一化结果不受影响 (trim 只去首尾空白,
    // 内部 \r\n 使值 ≠ 'browse' → collector), 日志回显净化在单独用例断言。
    [InlineData("browse\r\nFAKE LOG LINE", "collector")]
    [InlineData("collector\u0007garbage\u0000", "collector")]
    [Trait("Category", "Normalize")]
    public void Normalize_ContractTable_MatchesJsNormalizeNodeMode(string? raw, string expected)
    {
        NodeMode.Normalize(raw).Should().Be(expected);
    }

    // ===========================================================================
    // F-3 日志安全化 — 非法值经 SanitizeForLog 回显 (过滤控制字符 + 截断 64 字符)
    // 后再进 logger.Warn, 防 \r\n/控制字符伪造本地日志行。用 NLog MemoryTarget
    // 捕获实际日志行断言;LogManager.Configuration 全局静态, try/finally 还原。
    // ===========================================================================

    [Fact]
    [Trait("Category", "Normalize")]
    public void Normalize_IllegalValueWithNewline_LogsSanitizedLine()
    {
        var target = new NLog.Targets.MemoryTarget { Layout = "${message}" };
        var config = new NLog.Config.LoggingConfiguration();
        config.AddRule(NLog.LogLevel.Warn, NLog.LogLevel.Fatal, target);
        var original = NLog.LogManager.Configuration;
        NLog.LogManager.Configuration = config;
        try
        {
            // \r\n 在值中部 → trim 不去除 → 非法 → collector; 回显必须净化
            var result = NodeMode.Normalize("browse\r\nFAKE LOG LINE");
            result.Should().Be("collector");

            target.Logs.Should().ContainSingle();
            target.Logs[0].Should().NotContain("\r");
            target.Logs[0].Should().NotContain("\n");
            // 控制字符被滤除后, 可读内容仍保留 (便于定位非法值)
            target.Logs[0].Should().Contain("FAKE LOG LINE");
        }
        finally
        {
            NLog.LogManager.Configuration = original;
        }
    }

    [Fact]
    [Trait("Category", "Normalize")]
    public void Normalize_IllegalValueLongerThan64_LogsTruncated()
    {
        var target = new NLog.Targets.MemoryTarget { Layout = "${message}" };
        var config = new NLog.Config.LoggingConfiguration();
        config.AddRule(NLog.LogLevel.Warn, NLog.LogLevel.Fatal, target);
        var original = NLog.LogManager.Configuration;
        NLog.LogManager.Configuration = config;
        try
        {
            var raw = new string('x', 100);
            NodeMode.Normalize(raw).Should().Be("collector");

            target.Logs.Should().ContainSingle();
            // 截断点之后的内容不得出现 (64 字符截断 + "..." 后缀)
            target.Logs[0].Should().NotContain(new string('x', 65));
        }
        finally
        {
            NLog.LogManager.Configuration = original;
        }
    }

    // ===========================================================================
    // IsBrowseMode — [Trait("Category", "IsBrowseMode")]
    // 经 VRCXStorage 可控配置验证 VRCX_NodeMode 判定 (browse 生效, 其余不生效)。
    // ===========================================================================

    [Theory]
    [InlineData("browse")]
    [InlineData(" BROWSE ")]
    [Trait("Category", "IsBrowseMode")]
    public void IsBrowseMode_WhenConfigBrowse_ReturnsTrue(string value)
    {
        VRCXStorage.Instance.Set("VRCX_NodeMode", value);
        NodeMode.IsBrowseMode().Should().BeTrue();
    }

    [Theory]
    [InlineData("auto")]
    [InlineData("collector")]
    [InlineData("")]
    [InlineData("bogus")]
    [Trait("Category", "IsBrowseMode")]
    public void IsBrowseMode_WhenConfigNotBrowse_ReturnsFalse(string value)
    {
        VRCXStorage.Instance.Set("VRCX_NodeMode", value);
        NodeMode.IsBrowseMode().Should().BeFalse();
    }

    [Fact]
    [Trait("Category", "IsBrowseMode")]
    public void IsBrowseMode_WhenConfigMissing_ReturnsFalse()
    {
        // 键未设置 (stub Get 返回 null) → 默认 collector
        NodeMode.IsBrowseMode().Should().BeFalse();
    }
}
