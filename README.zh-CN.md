# NPU Monitor for VS Code

[English](README.md) | 简体中文

通过 SSH 监控多台机器上的 Ascend NPU 和 Docker 容器，支持 Windows VS Code
和 WSL VS Code。界面语言跟随 VS Code 的中文或英文设置。

## 功能

- 从 OpenSSH config 自动加载机器。
- 手动扫描全部、单台或多选机器。
- 订阅机器空闲提醒，并按可配置周期自动扫描已订阅机器。
- 优先读取 NPU-Exporter `/metrics`，不可用时快速回退到 `npu-smi info`。
- 展示健康状态、利用率、HBM、温度、功耗和 NPU 进程。
- 监控 Docker 容器，支持按 Dev Container 和工作区目录筛选。
- 通过机器右键菜单复制 SSH 连接信息。
- 在新窗口打开运行中的容器，快速复制容器信息。
- 区分连接超时、认证失败、主机密钥异常和采集失败。

自动扫描只访问已订阅机器。手动扫描不会修改订阅列表。

![使用演示](media/demo.gif)

## 环境要求

- VS Code 1.100 或更高版本。
- Windows OpenSSH Client，或 WSL 中的 `/usr/bin/ssh`。
- SSH config 中配置的机器可以免密执行远端只读命令。
- 远端机器安装 `npu-smi`，或运行可访问的 NPU-Exporter。
- 容器监控需要远端 SSH 用户有 Docker 查询权限，本地无需安装 Docker。
- 打开容器需要在本地 VS Code 安装 Dev Containers 和 Remote - SSH。

## 构建和安装

```bash
npm install
npm run check
npm run vsix
code --install-extension release/vscode-npu-monitor-0.2.0.vsix
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
npm version 0.2.0 --no-git-tag-version
git add package.json package-lock.json CHANGELOG.md
git commit -m "[Release] Prepare v0.2.0"
git push origin main
git tag -a v0.2.0 -m "v0.2.0"
git push origin v0.2.0
```

发布附件名根据版本自动生成，例如
`release/vscode-npu-monitor-0.2.0.vsix`。GitHub 同时提供源码 zip 和 tar.gz。

## 使用

1. 打开 Activity Bar 中的 **NPU Monitor**。
2. 首次进入时扩展只加载 SSH config，不自动扫描全部机器。
3. 点击标题栏刷新图标扫描全部机器。
4. 使用机器行的刷新图标扫描单台；多选机器后执行“扫描所选机器”。
5. 使用机器行的终端图标打开 SSH 终端；右键机器可复制连接信息，并支持多选机器。
6. 点击铃铛订阅机器；订阅后立即扫描，并仅对订阅机器定时轮询。
7. 机器达到空闲条件时显示 VS Code 通知。
8. 展开机器查看 NPU 和容器状态；点击运行中容器的新窗口图标，在独立窗口附加容器。
9. 容器行的复制图标用于“复制精简信息”，右键菜单提供“复制完整信息”，均支持多选。

扫描先采集 NPU 数据，再执行只读 Docker 查询。默认展示 Dev Container，并优先使用
配置中的项目名称。采集失败时保留上次成功的数据并标记“数据已过期”。

打开容器时，Remote - SSH 需使用与 NPU Monitor 一致的 SSH 配置和主机别名。

## 配置

在 VS Code 设置中搜索 `NPU Monitor`：

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `sshConfigPath` | Remote - SSH 配置或自动检测 | 显式配置的 NPU Monitor 路径优先级最高；留空时先使用 `remote.SSH.configFile`，再按 Windows / WSL 规则自动检测 |
| `knownHostsPath` | SSH config 同目录 | 主机密钥文件 |
| `sshExecutablePath` | 自动检测 | Windows OpenSSH 或 `/usr/bin/ssh` |
| `connectTimeoutSeconds` | `8` | SSH 连接超时 |
| `exporterProbeTimeoutSeconds` | `2` | Exporter 总探测时间 |
| `npuSmiTimeoutSeconds` | `10` | `npu-smi info` 超时 |
| `maxConcurrentHosts` | `6` | 手动和自动扫描并发数 |
| `excludedHosts` | `[]` | 不显示、不扫描的 Host 别名 |
| `devContainers.enabled` | `true` | 启用容器监控 |
| `devContainers.timeoutSeconds` | `5` | 容器查询超时，不含 SSH 连接时间 |
| `containers.filterMode` | `devContainers` | `all` 全部容器、`devContainers` 或 `workspacePaths` 工作区筛选 |
| `containers.workspacePaths` | `[]` | 宿主机工作区目录，仅在 `workspacePaths` 模式生效 |
| `pollIntervalSeconds` | `60` | 订阅轮询周期，最小 10 秒 |
| `idleScope` | `allCards` | 要求全部卡或任一卡空闲 |
| `idleRequireNoProcesses` | `true` | 空闲时要求没有 NPU 进程 |
| `idleUtilizationThresholdPercent` | `1` | 空闲利用率上限 |
| `idleConsecutiveChecks` | `1` | 空闲提醒前连续满足次数 |

SSH 相关路径支持 `~`、`${env:NAME}` 和 Windows `%NAME%` 环境变量。WSL 读取 Windows
配置时会自动转换 NPU Monitor 和 Remote - SSH 设置中的 `C:\...` 路径。

在 `workspacePaths` 模式下，填写一个或多个**宿主机** Linux 绝对目录，匹配该目录
及其子目录，区分大小写，不展开 `~`、变量或通配符。空列表显示全部 Dev Container，
其他模式忽略已保存的路径。筛选修改立即作用于缓存数据。

```json
{
  "npuMonitor.containers.filterMode": "workspacePaths",
  "npuMonitor.containers.workspacePaths": ["/home/user", "/mnt/work/user"]
}
```

## 安全行为

- 始终启用 OpenSSH 主机密钥校验。
- 不自动接受新密钥，不修改用户的 SSH config、`known_hosts` 或密钥。
- 扫描使用 `BatchMode=yes`，不会弹出密码输入。
- 交互式 SSH 终端可以在终端中提示输入，但仍启用主机密钥校验并禁用主机密钥更新。
- 不采集容器环境变量和无关标签。
- 不把机器地址、用户名、SSH 配置或密钥打包进 VSIX。

## 开发相关

开发和打包使用 Node.js 24 LTS。运行时类型与 VS Code 1.100 / Node.js 20 对齐，
TypeScript 6 和 Vitest 4 保持工具链兼容。

### 目录结构

```text
src/
  extension.ts       # 扩展入口与命令注册
  settings.ts        # 配置读取
  types.ts           # 共享数据类型
  monitorService.ts  # 订阅、扫描调度和缓存
  ssh/               # SSH 配置与执行
  npu/               # NPU 采集、解析和空闲判断
  containers/        # 容器采集、元数据和筛选
  ui/                # 树视图与操作命令
test/                # 自动测试
  ssh/
  npu/
  containers/
  ui/
  extension.test.ts
  monitorService.test.ts
  fixtures/          # 共享样本
  mocks/             # 共享模拟对象
scripts/             # 打包脚本
l10n/                # 界面翻译
media/               # 图标和演示资源
```

### 开发约定

- 同时支持 Windows 原生 OpenSSH 和 WSL `/usr/bin/ssh`，跨平台差异应有测试覆盖。
- 命令、配置和文档保持中英文一致。
- 提交信息使用简短英文，格式为 `[Tag] Brief description`。

### 开发命令

```bash
npm run check-types
npm run lint
npm test
npm run compile
npm run check
npm run vsix
```
