# VS Code NPU Monitor

开发前先阅读 [README.md](README.md)，了解使用方式、目录结构和开发约定。以下为 Agent 执行任务时的约束。

## 执行约束

- 修改前检查 Git 状态，保留用户已有的暂存和未提交改动，只处理当前任务范围内的内容。
- 遵循 README 中的开发约定和安全行为；行为变更同步维护相关测试和中英文说明。
- 采集保持只读，NPU 与容器独立处理失败和过期数据；容器筛选和复制使用本地缓存，复制使用 VS Code 剪贴板 API。
- 通过 Remote - SSH / Dev Containers 附加运行中的容器；连接协议集中在 `src/ui/containerActions.ts`，相关扩展升级后需复核兼容性。
- 真实 SSH 验证按任务指定的主机范围执行，使用隔离配置和订阅状态，不修改用户的 SSH config、`known_hosts`、密钥或已有订阅。
- 远端验证仅执行只读 NPU、Docker 元数据及 Dev Container 配置名称查询，不为测试安装软件、管理服务或创建、启停、删除容器。
- 修改采集逻辑后运行 `npm run check`；交付前运行 `npm run vsix`，并检查 `git diff --check`。
- 交付时说明实际改动和检查结果，区分自动测试、真实 SSH 采集与 VS Code 界面验证；未执行的验证明确注明。
- 发布、打标签或推送仅在任务明确要求时执行；README 中的发布示例本身不代表执行授权。

- MCP 查询只读现有缓存；显式刷新复用调度，不改变订阅。token 仅存 SecretStorage，通过用户主动复制交付，不记录到日志。验证使用隔离配置，不修改真实客户端设置。
