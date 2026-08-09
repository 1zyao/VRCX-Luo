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
//   - SQLite.cs Init() 调用 VRCXStorage.Instance.Get(key)
//   - SQLite.cs CollectOptions() 调用 VRCXStorage.Instance.GetWithPrefix(prefix)
//   - 安全测试不调用 Init() 或 CollectOptions(), 故这些 stub 方法永远不会被调用
//   - 若意外调用, 返回 null/空字典 → fail fast, 暴露误用
//   - 命名空间 VRCX 与生产代码一致
//
// M1 S2 扩展 (2026-08-09):
//   - 浏览模式测试 (SQLiteBridgeTests.Init_* / NodeModeTests.IsBrowseMode_*) 需要
//     可控配置值: 新增 Set(key, value) / Clear(), Get 改为读内部字典 (键缺失返回
//     null, 保持原 fail-fast 哨兵语义), GetWithPrefix 按前缀过滤真实返回。
//   - 生产代码零改动; stub 属测试工程内部, 不构成生产行为。

using System.Collections.Generic;

namespace VRCX
{
    /// <summary>
    /// Minimal VRCXStorage stub. SQLite.cs Init() calls VRCXStorage.Instance.Get(key)
    /// and CollectOptions() calls VRCXStorage.Instance.GetWithPrefix(prefix).
    /// M1 S2 起 Init() 被浏览模式测试真实调用, 因此 stub 提供可控内存字典。
    /// </summary>
    public class VRCXStorage
    {
        public static VRCXStorage Instance { get; } = new VRCXStorage();

        private readonly Dictionary<string, string> _values = new Dictionary<string, string>();

        /// <summary>
        /// 读取配置;键不存在时返回 null (fail-fast 哨兵,语义同原 stub)。
        /// </summary>
        public string Get(string key)
            => _values.TryGetValue(key, out var value) ? value : null;

        /// <summary>
        /// 写入配置 (M1 S2 测试控制 VRCX_NodeMode / VRCX_Database.name 等键)。
        /// </summary>
        public void Set(string key, string value) => _values[key] = value;

        /// <summary>
        /// 清空配置 (每个测试用例间隔离)。
        /// </summary>
        public void Clear() => _values.Clear();

        /// <summary>
        /// 返回键以 prefix 开头的子集,结果键去掉 prefix (与生产实现语义一致)。
        /// </summary>
        public Dictionary<string, string> GetWithPrefix(string prefix)
        {
            var result = new Dictionary<string, string>();
            foreach (var kvp in _values)
            {
                if (kvp.Key.StartsWith(prefix))
                {
                    result[kvp.Key[prefix.Length..]] = kvp.Value;
                }
            }
            return result;
        }
    }
}
