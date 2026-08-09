using System;
using System.Text;
using NLog;

namespace VRCX
{
    /// <summary>
    /// 浏览模式 (VRCX_NodeMode) 判定 — M1 切片 S2 (docs/architecture/BROWSE_MODE_M1_DESIGN.md §2.5 MEDIUM-5)。
    ///
    /// 与 JS 侧 readOnlyGate.normalizeNodeMode 保持同一归一化契约:
    ///   trim+lower === 'browse' → 'browse'; 其余 (auto/collector/空/非法) → 'collector' (fail-safe)。
    /// 双端同表单测锁定等价 (NodeModeTests.cs ↔ readOnlyGate.test.js)。
    /// </summary>
    internal static class NodeMode
    {
        private static readonly Logger logger = LogManager.GetCurrentClassLogger();

        /// <summary>
        /// 日志回显安全化 (F-3):非法值原样回显可被 \r\n/控制字符伪造本地日志行。
        /// 过滤全部控制字符 + 截断至 64 字符,仅用于 logger.Warn 展示,
        /// 不影响归一化输入 (Normalize 仍按原始 raw 判定)。
        /// </summary>
        private static string SanitizeForLog(string? raw)
        {
            var text = raw ?? string.Empty;
            if (text.Length > 64)
            {
                text = text.Substring(0, 64) + "...";
            }
            var sb = new StringBuilder(text.Length);
            foreach (var c in text)
            {
                if (!char.IsControl(c))
                {
                    sb.Append(c);
                }
            }
            return sb.ToString();
        }

        /// <summary>
        /// 归一化纯函数 (供测试直接调用):大小写/首尾空白不敏感,仅显式 'browse' 生效;
        /// 'auto'/'collector'/空/非法一律归 'collector' — fail-safe:判定错误的最坏
        /// 后果是"collector 照常运行",绝不反向造成 browse 误判。
        /// 非空且不属于三个已知关键字的非法值记 logger.Warn (回显经 SanitizeForLog
        /// 过滤控制字符 + 截断, 防日志行伪造);空/缺失 (null) 为配置默认态,
        /// 静默归 collector 不告警。
        /// </summary>
        public static string Normalize(string? raw)
        {
            var value = (raw ?? string.Empty).Trim().ToLowerInvariant();
            if (value == "browse")
            {
                return "browse";
            }
            if (value.Length > 0 && value != "auto" && value != "collector")
            {
                logger.Warn("VRCX_NodeMode 非法值 '{0}'，按 collector (auto) 处理", SanitizeForLog(raw));
            }
            return "collector";
        }

        /// <summary>
        /// 当前进程是否运行于浏览模式 (只读)。IsReadOnly 语义即 Normalize(...) == "browse"。
        /// </summary>
        public static bool IsBrowseMode()
        {
            return Normalize(VRCXStorage.Instance.Get("VRCX_NodeMode")) == "browse";
        }
    }
}
