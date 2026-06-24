# NPU Monitor for VS Code

[English](README.md) | 简体中文

通过 SSH 监控多台机器上的 Ascend NPU 状态，支持 Windows VS Code 和 WSL
VS Code。界面语言跟随 VS Code 的中文或英文设置。

## 功能

- 从 OpenSSH config 自动加载机器。
- 手动扫描全部、单台或多选机器。
- 订阅机器空闲提醒，并按可配置周期自动扫描已订阅机器。
- 优先读取 NPU-Exporter `/metrics`，不可用时快速回退到 `npu-smi info`。
- 展示健康状态、利用率、HBM、温度、功耗和 NPU 进程。
- 区分连接超时、认证失败、主机密钥异常和采集失败。

自动扫描只访问已订阅机器。手动扫描不会修改订阅列表。

## 环境要求

- VS Code 1.100 或更高版本。
- Windows OpenSSH Client，或 WSL 中的 `/usr/bin/ssh`。
- SSH config 中配置的机器可以免密执行远端只读命令。
- 远端机器安装 `npu-smi`，或运行可访问的 NPU-Exporter。

## 构建和安装

```bash
npm install
npm run check
npm run vsix
code --install-extension release/vscode-npu-monitor-0.1.0.vsix
```

同一个 VSIX 可以安装到 Windows 本地 Extension Host 或 WSL Extension Host。
在 WSL 工作区中，应选择 VS Code 的“Install in WSL”。

开发时可以单独打开本目录并按 `F5` 启动 Extension Development Host：

```bash
code .
```

## 发布

推送与 `package.json` 版本一致的 `vX.Y.Z` 标签后，GitHub Actions 会运行完整
检查、生成 VSIX，并创建包含自动 Release Notes 的 GitHub Release。标签必须指向
`main` 上的提交，并且仅支持稳定的三段式语义版本。

准备新版本时更新 `package.json`、`package-lock.json` 和 `CHANGELOG.md`：

```bash
npm version 0.1.1 --no-git-tag-version
git add package.json package-lock.json CHANGELOG.md
git commit -m "[Release] Prepare v0.1.1"
git push origin main
git tag -a v0.1.1 -m "v0.1.1"
git push origin v0.1.1
```

发布附件名根据版本自动生成，例如
`release/vscode-npu-monitor-0.1.1.vsix`。GitHub 同时提供源码 zip 和 tar.gz。

## 使用

1. 打开 Activity Bar 中的 **NPU Monitor**。
2. 首次进入时扩展只加载 SSH config，不自动扫描全部机器。
3. 点击标题栏刷新图标扫描全部机器。
4. 使用机器行的刷新图标扫描单台；多选机器后执行“扫描所选机器”。
5. 点击铃铛订阅机器；订阅后立即扫描，并仅对订阅机器定时轮询。
6. 机器达到空闲条件时显示 VS Code 通知。

每台机器在一次 SSH 会话中完成：

1. 精确检查 `npu-exporter` / `npu_exporter` 进程，同时检查 `npu-smi` 路径。
2. Exporter 存在时在总计 2 秒内探测最多两个 `/metrics` 端点。
3. Exporter 不存在或指标不可用时立即执行 `npu-smi info`。
4. 将结果统一为机器和 NPU 状态。

扫描不会执行 `systemctl`、全盘查找、Docker、Kubernetes 或全端口探测。

## 配置

在 VS Code 设置中搜索 `NPU Monitor`：

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `sshConfigPath` | 自动检测 | Windows 默认 `%USERPROFILE%\.ssh\config`；WSL 优先 `/mnt/c/Users/<用户>/.ssh/config` |
| `knownHostsPath` | SSH config 同目录 | 主机密钥文件 |
| `sshExecutablePath` | 自动检测 | Windows OpenSSH 或 `/usr/bin/ssh` |
| `connectTimeoutSeconds` | `8` | SSH 连接超时 |
| `exporterProbeTimeoutSeconds` | `2` | Exporter 总探测时间 |
| `npuSmiTimeoutSeconds` | `10` | `npu-smi info` 超时 |
| `maxConcurrentHosts` | `6` | 手动和自动扫描并发数 |
| `excludedHosts` | `[]` | 不显示、不扫描的 Host 别名 |
| `pollIntervalSeconds` | `60` | 订阅轮询周期，最小 10 秒 |
| `idleScope` | `allCards` | 要求全部卡或任一卡空闲 |
| `idleRequireNoProcesses` | `true` | 空闲时要求没有 NPU 进程 |
| `idleUtilizationThresholdPercent` | `1` | 空闲利用率上限 |
| `idleConsecutiveChecks` | `1` | 空闲提醒前连续满足次数 |

路径支持 `~`、`${env:NAME}` 和 Windows `%NAME%` 环境变量。WSL 读取 Windows
配置时会转换 `C:\...` 形式的密钥路径。

## 安全行为

- 始终启用 OpenSSH 主机密钥校验。
- 不自动接受新密钥，不修改 `known_hosts`。
- 使用 `BatchMode=yes`，不会弹出密码输入。
- 不把机器地址、用户名、SSH 配置或密钥打包进 VSIX。

## 开发命令

```bash
npm run check-types
npm run lint
npm test
npm run compile
npm run check
npm run vsix
```
