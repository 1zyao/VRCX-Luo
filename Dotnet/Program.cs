using NLog;
using NLog.Targets;
using System;
using System.Data.SQLite;
using System.Diagnostics.CodeAnalysis;
using System.IO;
using System.Text.Json;
using System.Threading;
#if !LINUX
using System.Windows.Forms;
using VRCX.Overlay;
#endif

namespace VRCX
{
    public static class Program
    {
        public const string DefaultDatabaseFile = "VRCX.sqlite3";

        public static string BaseDirectory { get; private set; }
        public static string AppDataDirectory;
        public static string ConfigLocation { get; private set; }
        public static string Version { get; private set; }
        public static bool LaunchDebug;
        private static readonly Logger logger = LogManager.GetCurrentClassLogger();
        public static AppApi AppApiInstance { get; private set; }

        private static void SetProgramDirectories()
        {
            if (string.IsNullOrEmpty(AppDataDirectory))
                AppDataDirectory = Path.Join(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                    "VRCX");

            BaseDirectory = AppDomain.CurrentDomain.BaseDirectory;
            ConfigLocation = Path.Join(AppDataDirectory, DefaultDatabaseFile);

            if (!Directory.Exists(AppDataDirectory))
            {
                Directory.CreateDirectory(AppDataDirectory);

                // Migrate config to AppData
                if (File.Exists(Path.Join(BaseDirectory, "VRCX.json")))
                {
                    File.Move(Path.Join(BaseDirectory, "VRCX.json"), Path.Join(AppDataDirectory, "VRCX.json"));
                    File.Copy(Path.Join(AppDataDirectory, "VRCX.json"),
                        Path.Join(AppDataDirectory, "VRCX-backup.json"));
                }

                if (File.Exists(Path.Join(BaseDirectory, DefaultDatabaseFile)))
                {
                    File.Move(Path.Join(BaseDirectory, DefaultDatabaseFile),
                        Path.Join(AppDataDirectory, DefaultDatabaseFile));
                    File.Copy(Path.Join(AppDataDirectory, DefaultDatabaseFile),
                        Path.Join(AppDataDirectory, "VRCX-backup.sqlite3"));
                }
            }

            // Migrate cache to userdata for Cef 115 update
            var oldCachePath = Path.Join(AppDataDirectory, "cache");
            var newCachePath = Path.Join(AppDataDirectory, "userdata", "cache");
            if (Directory.Exists(oldCachePath) && !Directory.Exists(newCachePath))
            {
                Directory.CreateDirectory(Path.Join(AppDataDirectory, "userdata"));
                Directory.Move(oldCachePath, newCachePath);
            }
        }

        private static void GetVersion()
        {
            try
            {
                var versionFile = File.ReadAllText(Path.Join(BaseDirectory, "Version")).Trim();

                // look for trailing git hash "-22bcd96" to indicate nightly build
                var version = versionFile.Split('-');
                if (version.Length > 0 && version[^1].Length == 7)
                    Version = $"VRCX-K Nightly {versionFile}";
                else
                    Version = $"VRCX-K {versionFile}";
            }
            catch (Exception ex)
            {
                logger.Error(ex, "Failed to read version file");
                Version = "VRCX-K Nightly Build";
            }
        }

        private static void ConfigureLogger()
        {
            var fileName = Path.Join(AppDataDirectory, "logs", "VRCX.log");
            if (StartupArgs.LaunchArguments.IsOverlay)
                fileName = Path.Join(AppDataDirectory, "logs", "VRCX.Overlay.log");

            LogManager.Setup().LoadConfiguration(builder =>
            {
                var fileTarget = new FileTarget("fileTarget")
                {
                    FileName = fileName,
                    //Layout = "${longdate} [${level:uppercase=true}] ${logger} - ${message} ${exception:format=tostring}",
                    // Layout with padding between the level/logger and message so that the message always starts at the same column
                    Layout =
                        "${longdate} [${level:uppercase=true:padding=-5}] ${logger:padding=-20} - ${message} ${exception:format=tostring}",
                    ArchiveSuffixFormat = "{0:000}",
                    ArchiveEvery = FileArchivePeriod.Day,
                    MaxArchiveFiles = 4,
                    MaxArchiveDays = 7,
                    ArchiveAboveSize = 10000000,
                    ArchiveOldFileOnStartup = true,
                    KeepFileOpen = true,
                    AutoFlush = true,
                    Encoding = System.Text.Encoding.UTF8
                };
                builder.ForLogger().FilterMinLevel(LogLevel.Debug).WriteTo(fileTarget);

                var consoleTarget = new ConsoleTarget("consoleTarget")
                {
                    Layout = "${longdate} [${level:uppercase=true:padding=-5}] ${logger:padding=-20} - ${message} ${exception:format=tostring}",
                    DetectConsoleAvailable = true
                };
                builder.ForLogger().FilterMinLevel(LogLevel.Debug).WriteTo(consoleTarget);
            });
        }

#if !LINUX
        [STAThread]
        [SuppressMessage("Interoperability", "CA1416:Validate platform compatibility")]
        private static void Main()
        {
            BrowserSubprocess.Start();
            if (Wine.GetIfWine())
            {
                MessageBox.Show(
                    "VRCX Cef has detected Wine.\nPlease switch to our native Electron build for Linux.",
                    "Wine Detected", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
            try
            {
                Run();
            }

            #region Handle CEF Explosion

            catch (FileNotFoundException e)
            {
                logger.Error(e, "Handled Exception, Missing file found in Handle Cef Explosion.");

                var result = MessageBox.Show(
                    "VRCX has encountered an error with the CefSharp backend,\nthis is typically caused by missing files or dependencies.\nWould you like to try autofix by automatically installing vc_redist?.",
                    "VRCX CefSharp not found.", MessageBoxButtons.YesNo, MessageBoxIcon.Error);
                switch (result)
                {
                    case DialogResult.Yes:
                        logger.Fatal("Handled Exception, user selected auto install of vc_redist.");
                        Update.DownloadInstallRedist().GetAwaiter().GetResult();
                        MessageBox.Show(
                            "vc_redist has finished installing, if the issue persists upon next restart, please reinstall VRCX From GitHub,\nVRCX Will now restart.",
                            "vc_redist installation complete", MessageBoxButtons.OK);
                        Thread.Sleep(5000);
                        AppApiInstance?.RestartApplication(false);
                        break;

                    case DialogResult.No:
                        logger.Fatal("Handled Exception, user chose manual.");
                        MessageBox.Show(
                            "VRCX will now close, try reinstalling VRCX using the setup from Github as a potential fix.",
                            "VRCX CefSharp not found", MessageBoxButtons.OK, MessageBoxIcon.Error);
                        Thread.Sleep(5000);
                        Environment.Exit(0);
                        break;
                }
            }

            #endregion

            #region Handle Database Error

            // MySqlException lives in the MySqlConnector assembly, which is
            // referenced conditionally across the Cef / Electron projects. To
            // avoid a hard assembly dependency here, match by type name so a
            // MySQL/MariaDB Init() failure is routed to the database repair
            // branch (same surface as SQLite) instead of the generic crash
            // handler. PostgresException (Npgsql) is matched the same way and
            // for the same reason. This mirrors the repair-guide UX for all
            // three engines.
            catch (Exception e) when (e is SQLiteException || e.GetType().Name == "MySqlException" || e.GetType().Name == "PostgresException")
            {
                logger.Fatal(e, "Unhandled database exception, closing.");
                var messageBoxResult = MessageBox.Show(
                    "A fatal database error has occured.\n" +
                    "Please try to repair your database by following the steps in the provided repair guide, or alternatively rename your \"%AppData%\\VRCX\" folder to reset VRCX. " +
                    "If the issue still persists after following the repair guide please join the Discord (https://vrcx.app/discord) for further assistance. " +
                    "Would you like to open the webpage for database repair steps?\n" +
                    e, "Database error", MessageBoxButtons.YesNo, MessageBoxIcon.Error);
                if (messageBoxResult == DialogResult.Yes)
                {
                    // AppApiInstance is assigned in Run() AFTER Init() returns;
                    // any Init()-time exception reaches here before it is set,
                    // so guard against the (pre-existing) null-reference.
                    AppApiInstance?.OpenLink("https://github.com/vrcx-team/VRCX/wiki#how-to-repair-vrcx-database");
                }
            }

            // 浏览模式缺文件/只读初始化错误 (M2 §2.9 M10):C# 侧友好对话框。
            catch (InvalidOperationException e) when (e.Message.StartsWith("浏览模式："))
            {
                logger.Fatal(e, "浏览模式初始化失败, closing.");
                MessageBox.Show(
                    e.Message,
                    "浏览模式（只读）",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Warning);
            }

            #endregion

            catch (Exception e)
            {
                var cpuError = WinApi.GetCpuErrorMessage();
                if (cpuError != null)
                {
                    var messageBoxResult = MessageBox.Show(cpuError.Value.Item1, "Potentially Faulty CPU Detected",
                        MessageBoxButtons.YesNo, MessageBoxIcon.Error);
                    if (messageBoxResult == DialogResult.Yes)
                    {
                        AppApiInstance?.OpenLink(cpuError.Value.Item2);
                    }
                }

                logger.Fatal(e, "Unhandled Exception, program dying");
                var result = MessageBox.Show(e.ToString(), $"{Version} crashed, open Discord for support?", MessageBoxButtons.YesNo, MessageBoxIcon.Error);
                if (result == DialogResult.Yes)
                {
                    AppApiInstance?.OpenLink("https://vrcx.app/discord");
                }
                Environment.Exit(0);
            }
        }

        [SuppressMessage("Interoperability", "CA1416:Validate platform compatibility")]
        private static void Run()
        {
            var args = Environment.GetCommandLineArgs();
            StartupArgs.ArgsCheck(args);
            SetProgramDirectories();

            // One-shot memory cleanup helper: run the cleanup logic in this
            // lightweight process, write the result file, then exit. No CEF,
            // database, storage or UI initialization is needed. The parent
            // instance reads the result file after this process exits.
            if (StartupArgs.LaunchArguments.IsMemoryCleanupHelper)
            {
                ConfigureLogger();
                GetVersion();
                Environment.ExitCode = AppApi.RunMemoryCleanupHelper(
                    StartupArgs.LaunchArguments.IsMemoryCleanupDeep);
                Environment.Exit(Environment.ExitCode);
            }

            VRCXStorage.Instance.Load();
            ConfigureLogger();
            GetVersion();
            if (StartupArgs.LaunchArguments.IsOverlay)
                OverlayProgram.OverlayMain();

            Update.Check();

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            logger.Info("{0} Starting...", Version);
            logger.Info("Args: {0}", JsonSerializer.Serialize(StartupArgs.Args));
            if (!string.IsNullOrEmpty(StartupArgs.LaunchArguments.LaunchCommand))
                logger.Info("Launch Command: {0}", StartupArgs.LaunchArguments.LaunchCommand);
            logger.Debug("Wine detection: {0}", Wine.GetIfWine());

            IPCServer.Instance.Init();
            var databaseMode = VRCXStorage.Instance.Get("VRCX_Database.mode");
            if (string.IsNullOrEmpty(databaseMode))
            {
                // 主配置缺失 VRCX_Database.mode,优先从 .bak 恢复(对应 Phase 0.4 Backup 机制)。
                // 决策 #1:.bak 恢复后不在 Init 阶段写回主配置,延迟到主账号登录成功后再回写
                //         (与 .bak 生成/使用的"登录成功才持久化"语义一致)。
                // 决策 #4:仅针对关键配置项 VRCX_Database.mode 检测 .bak 恢复。
                try
                {
                    var bakJson = VRCXStorage.Instance.GetBackup();
                    if (!string.IsNullOrEmpty(bakJson) && bakJson != "{}")
                    {
                        using var bakDoc = JsonDocument.Parse(bakJson);
                        if (bakDoc.RootElement.TryGetProperty("VRCX_Database.mode", out var modeEl))
                        {
                            var bakMode = modeEl.GetString();
                            if (!string.IsNullOrEmpty(bakMode))
                            {
                                databaseMode = bakMode;
                                logger.Warn("VRCX_Database.mode recovered from .bak (deferred write-back until primary login): {0}", bakMode);
                            }
                        }
                    }
                }
                catch (Exception ex)
                {
                    logger.Warn(ex, "Failed to parse .bak for VRCX_Database.mode, will fall back to fresh init");
                }
            }
            if (databaseMode == "sqlite")
            {
                SQLite.Instance.Init();
            }
            else if (databaseMode == "mysql" || databaseMode == "mariadb")
            {
                MySQL.Instance.Init();
            }
            else if (databaseMode == "postgresql")
            {
                PostgreSQL.Instance.Init();
            }
            // 三个远程/本地引擎分支之后:其他未知 mode / .bak 也无 mode / .bak 损坏 → else fallback to SQLite
            else
            {
                // 决策 #2:极端情况 — .bak 无 mode / .bak 损坏 / 真正全新安装,
                //         直接认定为需要 init 初始化(启动新 SQLite 实例)。
                logger.Warn("VRCX_Database.mode not set and .bak has no usable mode, initializing fresh SQLite instance");
                SQLite.Instance.Init();
            }
            // cookies 持久化绑定到当前激活引擎:WebApi 经 IAuthStore 抽象
            // 读写各自的 cookies 表,不直接调用引擎单例,杜绝跨引擎读写。
            WebApi.Instance.SetAuthStoreByMode(databaseMode);
            AppApiInstance = new AppApiCef();

            ProcessMonitor.Instance.Init();
            Discord.Instance.Init();
            WebApi.Instance.Init();
            LogWatcher.Instance.Init();
            AutoAppLaunchManager.Instance.Init();
            CefService.Instance.Init();
            OverlayServer.Instance.Init();

            Application.Run(new MainForm());

            logger.Info("{0} Exiting...", Version);
            WebApi.Instance.SaveCookies();
            OverlayServer.Instance.Exit();
            CefService.Instance.Exit();
            AutoAppLaunchManager.Instance.Exit();
            LogWatcher.Instance.Exit();
            WebApi.Instance.Exit();
            Discord.Instance.Exit();
            VRCXStorage.Instance.Save();
            SQLite.Instance.Exit();
            // 三个引擎 Exit() 均对未初始化单例空安全(可重入 guard),故此处无条件全部清理。
            MySQL.Instance.Exit();
            PostgreSQL.Instance.Exit();
            ProcessMonitor.Instance.Exit();
        }
#else
        public static VRCXVRInterface VRCXVRInstance;
        
        public static void PreInit(string version, string[] args)
        {
            Version = version;
            StartupArgs.ArgsCheck(args);
            SetProgramDirectories();
        }

        public static void Init()
        {
            ConfigureLogger();
            Update.Check();

            logger.Info("{0} Starting...", Version);
            logger.Info("Args: {0}", JsonSerializer.Serialize(StartupArgs.Args));
            if (!string.IsNullOrEmpty(StartupArgs.LaunchArguments.LaunchCommand))
                logger.Info("Launch Command: {0}", StartupArgs.LaunchArguments.LaunchCommand);

            AppApiInstance = new AppApiElectron();
            
            VRCXVRInstance = new VRCXVRElectron();
            VRCXVRInstance.Init();
        }
#endif
    }

#if LINUX
    public class ProgramElectron
    {
        public void PreInit(string version, string[] args)
        {
            Program.PreInit(version, args);
        }

        public void Init()
        {
            Program.Init();
        }
    }
#endif
}
