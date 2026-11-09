# NPU Monitor 开发指南

[English](CONTRIBUTING.md) | 简体中文 | [使用说明](README.zh-CN.md)

## 环境与检查

开发和打包使用 Node.js 24 LTS。运行时类型与 VS Code 1.100 / Node.js 20 对齐，
构建产物以 Node.js 20 为目标。

```bash
npm ci
npm run check
npm run compile
code .
```

按 `F5` 启动 Extension Development Host。修改后运行 `npm run compile`，
或开发时使用 `npm run watch` 自动重新构建。

| 命令 | 用途 |
| --- | --- |
| `npm run check-types` | 检查源码和测试类型 |
| `npm run lint` | 检查源码、测试和构建脚本 |
| `npm test` | 运行自动测试 |
| `npm run compile` | 检查类型并构建开发版本 |
| `npm run watch` | 修改时自动重新构建开发版本 |
| `npm run check` | 运行类型检查、lint 和测试 |
| `npm run vsix` | 运行全部检查、构建生产版本并打包 VSIX |
| `npm run docs:capture` | 刷新 `media/` 中的 README 动图和截图 |

`npm run vsix` 根据 `package.json` 版本生成
`release/vscode-npu-monitor-<version>.vsix`。CI 在 Linux 和 Windows 上执行此命令，
同时覆盖打包流程，不重复运行相同检查。

## 项目结构

```text
src/
  extension.ts       # 创建组件、监听配置和管理生命周期
  settings.ts        # 配置读取
  types.ts           # 共享领域类型
  hostPreferences.ts # 本地收藏和备注存储
  monitorService.ts  # 订阅、扫描调度和缓存
  mcp/               # HTTP 服务、缓存查询、指定范围刷新和分页
  ssh/               # SSH 配置与进程执行
  npu/               # 采集、解析、空闲判断、有效期与历史
  containers/        # 只读采集、元数据和缓存筛选
  ui/                # 命令、选择、格式化、树和历史视图
test/
  mcp/ ssh/ npu/ containers/ ui/ # 按职责组织的测试
  extension.test.ts # 激活与命令接线
  manifest.test.ts  # 菜单位置与本地化契约
  monitorService.test.ts # 扫描调度
  helpers/           # 共享测试数据和内存存储
  fixtures/          # 采集输出样本
  mocks/             # VS Code API 模拟对象
scripts/             # 打包与 README 截图脚本
  readme/            # 隔离的演示数据与截图场景
l10n/                # 运行时翻译
media/               # 图标和演示资源
```

## 开发约定

- 支持 Windows 原生 OpenSSH 和 WSL `/usr/bin/ssh`，测试覆盖跨平台差异。
- 内部重构保持命令 ID、配置和 MCP 返回契约。行为变化同步更新相关测试和中英文使用说明。
- NPU 与容器分别处理失败、采集时间和过期数据。查找、筛选、复制只读本地缓存。
  MCP 仅在显式刷新时采集，复用调度且不改变订阅。
- 容器连接编码集中在 `src/ui/containerActions.ts`；Remote - SSH 或 Dev Containers
  升级后复核兼容性。
- manifest 文案保存在 `package.nls.json` 和 `package.nls.zh-cn.json`；
  运行时文案使用 `vscode.l10n.t`，中文翻译保存在 `l10n/`。
- 使用职责明确的模拟对象和共享夹具，测试中明确写出预期行为；清理临时目录、定时器和监听器。
- 交付前运行 `npm run vsix` 和 `git diff --check`，报告区分自动测试、真实 SSH 采集和
  VS Code 界面验证。
- 提交信息使用简短英文，格式为 `[Tag] Brief description`。

真实 SSH 验证必须明确主机范围，使用隔离配置和订阅状态，不修改用户的 SSH config、
`known_hosts`、密钥或已有订阅。远端只查询 NPU、Docker 元数据和 Dev Container 配置名称；
不为测试安装软件、管理服务或创建、启停、删除容器。所有采集路径遵循
[安全行为](README.zh-CN.md#安全行为)。MCP 凭据仅存 SecretStorage，
通过用户主动复制交付，不记录到日志；验证不修改真实 MCP 客户端设置。

## 刷新 README 图片

界面更新后，重新生成中英文 README 共用的三份图片：

```bash
npm ci
npm run docs:capture
```

命令从当前源码构建扩展，启动隔离的 VS Code 窗口，更新
`media/host-search-and-filter.gif`、`media/monitoring.png` 和
`media/idle-history.png`。展示内容包括展开节点、筛选空闲卡、查找并定位节点、
容器操作入口和逐卡历史。提交前检查图片效果；只有全部场景成功后才覆盖现有图片。

首次运行会下载 VS Code 1.100.3 到 Git 忽略的 `release/readme-capture/`，之后复用缓存。
每次使用新的配置、工作区和扩展目录，固定英文界面、主题、布局及模拟数据的时间。
不会读取 SSH 配置、采集远端数据、修改已有订阅或启用 MCP。演示代码仅参与截图构建，
不进入生产构建或 VSIX。

运行需要图形桌面，WSLg 可直接执行；无桌面的 Linux 主机安装 Xvfb 后，使用
`xvfb-run -a npm run docs:capture`。精简 Debian/Ubuntu 环境缺少 `libasound` 或
`libxkbfile` 时，脚本会下载并解压到自身缓存，不安装系统软件包。
其他缺失的 VS Code 运行依赖需另行安装。本流程已在 Linux/WSLg 验证，
尚未验证 Windows 原生和 macOS 截图。

执行 `npm run docs:capture -- --help` 查看已有原生 VS Code 可执行文件参数
`--vscode-path` 和其他输出目录参数 `--output-dir`。
修改示例数据时编辑 `scripts/readme/fixtures.ts`，修改演示流程时编辑
`scripts/readme/scenes.mjs`；演示采集服务的公开接口会与生产服务一起进行类型检查。
失败时保留日志及可用的失败截图，目录由命令输出；成功时清理临时配置。

## 发布

发布、打标签或推送必须由任务明确要求。以下示例仅说明流程，不代表执行授权。

推送与 `package.json` 版本一致的 `vX.Y.Z` 标签后，会运行检查、打包 VSIX 并发布
GitHub Release。标签必须指向 `main` 上的提交，仅支持稳定的三段式版本。
PR 使用 merge 或 squash 合入，并在提交标题中保留 PR 编号。

[github/copilot-release-notes](https://github.com/github/copilot-release-notes)
根据已合入 PR 和[发布写作规范](https://github.com/li1how/vscode-npu-monitor/blob/main/.github/release-notes-instructions.md)生成说明。
工作流使用 Actions 自带的 `GITHUB_TOKEN`，需要可用的 Copilot 权限和额度。
`RELEASE_NOTES_MODEL` 可选，未设置时使用 Copilot 默认模型；说明生成失败时停止发布。

开发期间，新改动写入 `Unreleased`。准备发布时，从最新的 `main` 创建分支，
更新包版本。将 `X.Y.Z` 替换为目标版本：

```bash
git switch main
git pull --ff-only origin main
git switch -c release/vX.Y.Z
npm version X.Y.Z --no-git-tag-version
```

将 `CHANGELOG.md` 中本次发布的改动从 `Unreleased` 移到 `X.Y.Z` 章节，
保留空的 `Unreleased` 章节用于后续开发。提交版本、锁文件和变更记录，
推送分支并向 `main` 提交 PR：

```bash
git add package.json package-lock.json CHANGELOG.md
git commit -m "[Release] Prepare vX.Y.Z"
git push -u origin release/vX.Y.Z
```

CI 通过且 PR 合入后，给 `main` 上对应的合入提交打标签。
将 `RELEASE_COMMIT_SHA` 替换为 PR 的实际合入提交 SHA；squash 合入时也使用
合入后的 SHA，不使用发布分支原来的提交 SHA：

```bash
git switch main
git pull --ff-only origin main
git tag -a vX.Y.Z RELEASE_COMMIT_SHA -m "vX.Y.Z"
git push origin vX.Y.Z
```

发布附件为 `vscode-npu-monitor-<version>.vsix`。GitHub 同时提供源码 zip 和 tar.gz。
