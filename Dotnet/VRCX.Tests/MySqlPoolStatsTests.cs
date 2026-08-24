using System.Net;
using System.Net.Sockets;

namespace VRCX.Tests;

/// <summary>
/// Regression tests for the MySQL pool borrow counter.
/// A connection-refused endpoint exercises the failure path without requiring
/// a MySQL server or network access beyond the local machine.
/// </summary>
[Collection("SQLiteStaticState")]
[Trait("Component", "MySQL.PoolStats")]
public sealed class MySqlPoolStatsTests
{
    [Fact]
    [Trait("Category", "PoolStats")]
    public void PingFailures_ReturnBorrowCounterToBaseline()
    {
        var mysql = CreateUnavailableMySql();
        try
        {
            for (var i = 0; i < 24; i++)
            {
                mysql.Ping().Should().BeFalse();
            }

            GetStats(mysql).availableCapacity.Should().Be(16);
        }
        finally
        {
            mysql.Exit();
        }
    }

    [Fact]
    [Trait("Category", "PoolStats")]
    public void GetHealthFailures_ReturnBorrowCounterToBaseline()
    {
        var mysql = CreateUnavailableMySql();
        try
        {
            for (var i = 0; i < 24; i++)
            {
                var health = System.Text.Json.JsonSerializer.Deserialize<HealthSnapshot>(mysql.GetHealth());
                health.Should().NotBeNull();
                health!.connected.Should().BeFalse();
            }

            GetStats(mysql).availableCapacity.Should().Be(16);
        }
        finally
        {
            mysql.Exit();
        }
    }

    [Fact]
    [Trait("Category", "PoolStats")]
    public void ExecuteFailures_ReturnBorrowCounterToBaseline()
    {
        var mysql = CreateUnavailableMySql();
        try
        {
            for (var i = 0; i < 24; i++)
            {
                var act = () => mysql.Execute("SELECT 1");
                act.Should().Throw<Exception>();
            }

            GetStats(mysql).availableCapacity.Should().Be(16);
        }
        finally
        {
            mysql.Exit();
        }
    }

    [Fact]
    [Trait("Category", "PoolStats")]
    public void ExecuteNonQueryFailures_ReturnBorrowCounterToBaseline()
    {
        var mysql = CreateUnavailableMySql();
        try
        {
            for (var i = 0; i < 24; i++)
            {
                var act = () => mysql.ExecuteNonQuery("SELECT 1");
                act.Should().Throw<Exception>();
            }

            GetStats(mysql).availableCapacity.Should().Be(16);
        }
        finally
        {
            mysql.Exit();
        }
    }

    [Fact]
    [Trait("Category", "PoolStats")]
    public void BeginTransactionFailures_ReturnBorrowCounterToBaseline()
    {
        var mysql = CreateUnavailableMySql();
        try
        {
            for (var i = 0; i < 24; i++)
            {
                var act = () => mysql.BeginTransaction();
                act.Should().Throw<Exception>();
            }

            GetStats(mysql).availableCapacity.Should().Be(16);
        }
        finally
        {
            mysql.Exit();
        }
    }

    [Fact]
    [Trait("Category", "PoolStats")]
    public void BeginTransactionOnConnectionFailures_ReturnBorrowCounterToBaseline()
    {
        var mysql = CreateUnavailableMySql();
        try
        {
            var connectionString = CreateUnavailableConnectionString();
            for (var i = 0; i < 24; i++)
            {
                var act = () => mysql.BeginTransactionOnConnection(connectionString);
                act.Should().Throw<Exception>();
            }

            GetStats(mysql).availableCapacity.Should().Be(16);
        }
        finally
        {
            mysql.Exit();
        }
    }

    private static MySQL CreateUnavailableMySql()
    {
        var connectionString = CreateUnavailableConnectionString();
        VRCXStorage.Instance.Clear();
        VRCXStorage.Instance.Set("VRCX_Database.host", "127.0.0.1");
        VRCXStorage.Instance.Set("VRCX_Database.port", GetPort(connectionString).ToString());
        VRCXStorage.Instance.Set("VRCX_Database.username", "test");
        VRCXStorage.Instance.Set("VRCX_Database.password", "test");
        VRCXStorage.Instance.Set("VRCX_Database.name", "test");
        VRCXStorage.Instance.Set("VRCX_Database.options.connectiontimeout", "1");

        var mysql = new MySQL();
        mysql.Init();
        return mysql;
    }

    private static string CreateUnavailableConnectionString()
    {
        var port = GetUnusedLoopbackPort();
        return $"Server=127.0.0.1;Port={port};User ID=test;Password=test;Database=test;Connection Timeout=1";
    }

    private static int GetPort(string connectionString)
        => int.Parse(connectionString.Split(';')[1].Split('=')[1]);

    private static int GetUnusedLoopbackPort()
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        listener.Stop();
        return port;
    }

    private static PoolStats GetStats(MySQL mysql)
    {
        var json = mysql.GetPoolStats();
        return System.Text.Json.JsonSerializer.Deserialize<PoolStats>(json)
            ?? throw new InvalidOperationException("MySQL.GetPoolStats returned null.");
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
