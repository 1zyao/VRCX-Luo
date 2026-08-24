// 设计稿 (Stage 2 solutions-architect 输出, Link+stub 方案)
// 文件名: VRCXStorageStub.cs
// 用途: Minimal VRCXStorage stub for SQLite.cs compilation
// 最终位置: Dotnet/VRCX.Tests/Stubs/VRCXStorageStub.cs (由 implementer 决定)
//
// 方案变更说明 (2026-07-18):
//   原 ProjectReference 方案通过 Cef 传递依赖拿到真实 VRCXStorage
//   新 Link+stub 方案: 测试工程自带 VRCXStorage stub, 生产代码零改动
//
// 设计要点:
//   - SQLite.cs Init() L97 调用 VRCXStorage.Instance.Get(key)
//   - SQLite.cs CollectOptions() L287 调用 VRCXStorage.Instance.GetWithPrefix(prefix)
//   - 安全测试不调用 Init() 或 CollectOptions(), 故这些 stub 方法永远不会被调用
//   - 若意外调用, 返回 null/空字典 → fail fast, 暴露误用
//   - 命名空间 VRCX 与生产代码一致

using System.Collections.Generic;

namespace VRCX
{
    /// <summary>
    /// Minimal VRCXStorage stub. SQLite.cs Init() (L97) calls VRCXStorage.Instance.Get(key)
    /// and CollectOptions() (L287) calls VRCXStorage.Instance.GetWithPrefix(prefix).
    /// Security tests do NOT call Init() or CollectOptions(), so these stubs are never invoked.
    /// If accidentally invoked, they return null/empty to fail fast and surface the misuse.
    /// </summary>
    public class VRCXStorage
    {
        public static VRCXStorage Instance { get; } = new VRCXStorage();

        private readonly Dictionary<string, string> _values = new();

        public string Get(string key)
            => _values.TryGetValue(key, out var value) ? value : null;

        public Dictionary<string, string> GetWithPrefix(string prefix)
        {
            var values = new Dictionary<string, string>();
            foreach (var pair in _values)
            {
                if (pair.Key.StartsWith(prefix, StringComparison.Ordinal))
                    values[pair.Key[prefix.Length..]] = pair.Value;
            }
            return values;
        }

        public void Clear() => _values.Clear();

        public void Set(string key, string value) => _values[key] = value;
    }
}
