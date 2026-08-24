using System.Reflection;

namespace VRCX.Tests;

[Collection("SQLiteStaticState")]
[Trait("Component", "SQLite.PoolStats")]
public sealed class SQLitePoolStatsTests
{
    private const string InvalidConnectionString = "not a valid SQLite connection string";

    [Fact]
    [Trait("Category", "PoolStats")]
    public void PingFailures_ReturnBorrowCounterToBaseline()
    {
        var sqlite = CreateInitializedSqlite();
        try
        {
            SetConnectionString(sqlite, InvalidConnectionString);
            for (var i = 0; i < 24; i++)
                sqlite.Ping().Should().BeFalse();

            GetStats(sqlite).availableCapacity.Should().Be(16);
        }
        finally
        {
            sqlite.Exit();
        }
    }

    [Fact]
    [Trait("Category", "PoolStats")]
    public void GetHealthFailures_ReturnBorrowCounterToBaseline()
    {
        var sqlite = CreateInitializedSqlite();
        try
        {
            SetConnectionString(sqlite, InvalidConnectionString);
            for (var i = 0; i < 24; i++)
            {
                var health = System.Text.Json.JsonSerializer.Deserialize<HealthSnapshot>(
                    sqlite.GetHealth());
                health.Should().NotBeNull();
                health!.connected.Should().BeFalse();
            }

            GetStats(sqlite).availableCapacity.Should().Be(16);
        }
        finally
        {
            sqlite.Exit();
        }
    }

    [Fact]
    [Trait("Category", "PoolStats")]
    public void ExecuteFailures_ReturnBorrowCounterToBaseline()
    {
        var sqlite = CreateInitializedSqlite();
        try
        {
            SetConnectionString(sqlite, InvalidConnectionString);
            for (var i = 0; i < 24; i++)
            {
                var act = () => sqlite.Execute("SELECT 1");
                act.Should().Throw<Exception>();
            }

            GetStats(sqlite).availableCapacity.Should().Be(16);
        }
        finally
        {
            sqlite.Exit();
        }
    }

    [Fact]
    [Trait("Category", "PoolStats")]
    public void ExecuteNonQueryFailures_ReturnBorrowCounterToBaseline()
    {
        var sqlite = CreateInitializedSqlite();
        try
        {
            SetConnectionString(sqlite, InvalidConnectionString);
            for (var i = 0; i < 24; i++)
            {
                var act = () => sqlite.ExecuteNonQuery("SELECT 1");
                act.Should().Throw<Exception>();
            }

            GetStats(sqlite).availableCapacity.Should().Be(16);
        }
        finally
        {
            sqlite.Exit();
        }
    }

    [Fact]
    [Trait("Category", "PoolStats")]
    public void BeginTransactionFailures_ReturnBorrowCounterToBaseline()
    {
        var sqlite = CreateInitializedSqlite();
        try
        {
            SetConnectionString(sqlite, InvalidConnectionString);
            for (var i = 0; i < 24; i++)
            {
                var act = () => sqlite.BeginTransaction();
                act.Should().Throw<Exception>();
            }

            GetStats(sqlite).availableCapacity.Should().Be(16);
        }
        finally
        {
            sqlite.Exit();
        }
    }

    [Fact]
    [Trait("Category", "PoolStats")]
    public void BeginTransactionOnConnectionFailures_ReturnBorrowCounterToBaseline()
    {
        var sqlite = CreateInitializedSqlite();
        try
        {
            for (var i = 0; i < 24; i++)
            {
                var act = () => sqlite.BeginTransactionOnConnection(InvalidConnectionString);
                act.Should().Throw<Exception>();
            }

            GetStats(sqlite).availableCapacity.Should().Be(16);
        }
        finally
        {
            sqlite.Exit();
        }
    }

    private static SQLite CreateInitializedSqlite()
    {
        var path = Path.Combine(Path.GetTempPath(), $"vrcx-pool-{Guid.NewGuid():N}.db");
        VRCXStorage.Instance.Clear();
        VRCXStorage.Instance.Set("VRCX_Database.name", path);
        VRCXStorage.Instance.Set("VRCX_NodeMode", "collector");
        var sqlite = new SQLite();
        sqlite.Init();
        return sqlite;
    }

    private static void SetConnectionString(SQLite sqlite, string value)
    {
        typeof(SQLite).GetField("_connectionString", BindingFlags.Instance | BindingFlags.NonPublic)!
            .SetValue(sqlite, value);
    }

    private static PoolStats GetStats(SQLite sqlite)
    {
        var json = sqlite.GetPoolStats();
        return System.Text.Json.JsonSerializer.Deserialize<PoolStats>(json)
            ?? throw new InvalidOperationException("SQLite.GetPoolStats returned null.");
    }

    private sealed record HealthSnapshot(bool connected, long latencyMs, string? lastHealthCheck);

    private sealed record PoolStats(
        int active,
        int pinnedIdle,
        int availableCapacity,
        int max,
        int totalOpen,
        int idleInPool);
}
