using System.Net;
using System.Net.Sockets;

namespace VRCX.Tests;

/// <summary>
/// Regression tests for PostgreSQL pool borrow-counter cleanup.
/// A refused local endpoint exercises connection-open failures without a server.
/// </summary>
[Collection("SQLiteStaticState")]
[Trait("Component", "PostgreSQL.PoolStats")]
public sealed class PostgreSqlPoolStatsTests
{
    [Fact]
    [Trait("Category", "PoolStats")]
    public void PingFailures_ReturnBorrowCounterToBaseline()
    {
        var postgres = CreateUnavailablePostgreSql();
        try
        {
            for (var i = 0; i < 24; i++)
                postgres.Ping().Should().BeFalse();

            GetStats(postgres).availableCapacity.Should().Be(16);
        }
        finally
        {
            postgres.Exit();
        }
    }

    [Fact]
    [Trait("Category", "PoolStats")]
    public void GetHealthFailures_ReturnBorrowCounterToBaseline()
    {
        var postgres = CreateUnavailablePostgreSql();
        try
        {
            for (var i = 0; i < 24; i++)
            {
                var health = System.Text.Json.JsonSerializer.Deserialize<HealthSnapshot>(
                    postgres.GetHealth());
                health.Should().NotBeNull();
                health!.connected.Should().BeFalse();
            }

            GetStats(postgres).availableCapacity.Should().Be(16);
        }
        finally
        {
            postgres.Exit();
        }
    }

    [Fact]
    [Trait("Category", "PoolStats")]
    public void ExecuteFailures_ReturnBorrowCounterToBaseline()
    {
        var postgres = CreateUnavailablePostgreSql();
        try
        {
            for (var i = 0; i < 24; i++)
            {
                var act = () => postgres.Execute("SELECT 1");
                act.Should().Throw<Exception>();
            }

            GetStats(postgres).availableCapacity.Should().Be(16);
        }
        finally
        {
            postgres.Exit();
        }
    }

    [Fact]
    [Trait("Category", "PoolStats")]
    public void ExecuteNonQueryFailures_ReturnBorrowCounterToBaseline()
    {
        var postgres = CreateUnavailablePostgreSql();
        try
        {
            for (var i = 0; i < 24; i++)
            {
                var act = () => postgres.ExecuteNonQuery("SELECT 1");
                act.Should().Throw<Exception>();
            }

            GetStats(postgres).availableCapacity.Should().Be(16);
        }
        finally
        {
            postgres.Exit();
        }
    }

    [Fact]
    [Trait("Category", "PoolStats")]
    public void BeginTransactionFailures_ReturnBorrowCounterToBaseline()
    {
        var postgres = CreateUnavailablePostgreSql();
        try
        {
            for (var i = 0; i < 24; i++)
            {
                var act = () => postgres.BeginTransaction();
                act.Should().Throw<Exception>();
            }

            GetStats(postgres).availableCapacity.Should().Be(16);
        }
        finally
        {
            postgres.Exit();
        }
    }

    [Fact]
    [Trait("Category", "PoolStats")]
    public void BeginTransactionOnConnectionFailures_ReturnBorrowCounterToBaseline()
    {
        var postgres = CreateUnavailablePostgreSql();
        try
        {
            var connectionString = CreateUnavailableConnectionString();
            for (var i = 0; i < 24; i++)
            {
                var act = () => postgres.BeginTransactionOnConnection(connectionString);
                act.Should().Throw<Exception>();
            }

            GetStats(postgres).availableCapacity.Should().Be(16);
        }
        finally
        {
            postgres.Exit();
        }
    }

    private static PostgreSQL CreateUnavailablePostgreSql()
    {
        var port = GetUnusedLoopbackPort();
        VRCXStorage.Instance.Clear();
        VRCXStorage.Instance.Set("VRCX_Database.host", "127.0.0.1");
        VRCXStorage.Instance.Set("VRCX_Database.port", port.ToString());
        VRCXStorage.Instance.Set("VRCX_Database.username", "test");
        VRCXStorage.Instance.Set("VRCX_Database.password", "test");
        VRCXStorage.Instance.Set("VRCX_Database.name", "test");

        var postgres = new PostgreSQL();
        postgres.Init();
        return postgres;
    }

    private static string CreateUnavailableConnectionString()
    {
        var port = GetUnusedLoopbackPort();
        return $"Host=127.0.0.1;Port={port};Username=test;Password=test;Database=test;Timeout=1";
    }

    private static int GetUnusedLoopbackPort()
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        listener.Stop();
        return port;
    }

    private static PoolStats GetStats(PostgreSQL postgres)
    {
        var json = postgres.GetPoolStats();
        return System.Text.Json.JsonSerializer.Deserialize<PoolStats>(json)
            ?? throw new InvalidOperationException("PostgreSQL.GetPoolStats returned null.");
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
