# NPU Monitor for VS Code

English | [简体中文](README.zh-CN.md)

Monitor Ascend NPUs and Docker containers across multiple SSH hosts from VS Code.
The extension supports native Windows and WSL OpenSSH, with Chinese and English
interfaces that follow the VS Code language setting.

## Features

- Load hosts automatically from an OpenSSH configuration file.
- Refresh NPU status for all hosts automatically, or scan all, one, or selected hosts manually.
- Track per-NPU idle history and choose hosts by observed continuous idle time.
- Subscribe to idle notifications; containers refresh on startup and manual scans.
- Prefer NPU-Exporter `/metrics` and quickly fall back to `npu-smi info`.
- Display health, utilization, HBM, temperature, power, and processes per physical NPU.
- Monitor Docker containers with Dev Container and workspace directory filters.
- Copy SSH host connection information from the host context menu.
- Open running containers in a new window and copy container information.
- Distinguish connection timeouts, authentication failures, host key errors,
  and collection failures.

The first automatic scan collects NPU and container data from all configured hosts by default.
Periodic scans refresh NPU data only; subscribed hosts receive idle notifications.
Manual scans refresh both data types without changing subscriptions.

![Usage demo](media/demo.gif)

## Requirements

- VS Code 1.100 or later.
- Windows OpenSSH Client or `/usr/bin/ssh` in WSL.
- Passwordless access to the hosts configured in the SSH configuration file.
- `npu-smi` installed on each remote host, or an accessible NPU-Exporter
  process running there.
- For container monitoring: Docker access for the remote SSH user; no local Docker required.
- To open containers: Dev Containers and Remote - SSH installed in local VS Code.

## Build and Install

```bash
npm install
npm run check
npm run vsix
code --install-extension release/vscode-npu-monitor-0.2.3.vsix
```

The same VSIX can be installed in either a local Windows Extension Host or a
WSL Extension Host. For a WSL workspace, select **Install in WSL** in VS Code.

For development, open this directory and press `F5` to start an Extension
Development Host:

```bash
code .
```

## Release

Pushing a `vX.Y.Z` tag that matches the version in `package.json` runs the full
test suite, builds the VSIX, and creates a GitHub Release with automatically
generated release notes. The tag must point to a commit on `main`, and only
stable three-part semantic versions are supported.

To prepare a new version, update `package.json`, `package-lock.json`, and
`CHANGELOG.md`:

```bash
npm version 0.2.3 --no-git-tag-version
git add package.json package-lock.json CHANGELOG.md
git commit -m "[Release] Prepare v0.2.3"
git push origin main
git tag -a v0.2.3 -m "v0.2.3"
git push origin v0.2.3
```

The release asset name is generated from the package version, for example
`release/vscode-npu-monitor-0.2.3.vsix`. GitHub also provides source code
archives in zip and tar.gz formats.

## Usage

1. Open **NPU Monitor** in the Activity Bar.
2. On first use, the extension loads the SSH configuration and scans all hosts
   for NPU and container status.
3. Select the refresh icon in the view title to scan all hosts. Reload the SSH
   configuration from the title bar’s More Actions menu.
4. Use the refresh icon on a host to scan it, or select multiple hosts and run
   **Scan Selected Hosts**.
5. Right-click a host to open an SSH terminal or copy its connection information;
   copying supports multiple selected hosts.
6. Select the bell icon to subscribe to a host. It is scanned immediately; periodic
   NPU scans can send idle notifications.
7. Use the view-title **Choose Idle Host** button to rank fresh candidates by the longest
   observed continuous idle time. Selecting one reveals and expands its tree row. Use
   the history icon beside each host's bell to view its per-NPU timeline, with the newest day first.
8. Host rows show idle NPU count, longest observed idle time, collection time and
   container count. Hover for full status and collection source. Expand a host to view
   NPU and container status. Use a running container's
   new-window icon to attach in a separate VS Code window.
9. Use a container's copy icon for **Copy Summary**, or the context menu for
   **Copy Full Information**. Both support multiple selected containers.

Startup and manual scans collect NPU data first, followed by read-only Docker queries. Dev Containers
are shown by default and use the configured project name when available. Failed
scans retain the last successful data with a **Stale** marker. Idle history starts
with this version and is stored locally in the current extension environment; a failed,
partial, or overdue observation never extends a continuous idle period. Changing the
per-card idle threshold or process rule starts a new history under the new rule.

Remote - SSH must use the same SSH configuration and host aliases as NPU Monitor
when opening a container.

### MCP access

Enable MCP from the status row at the top of NPU Monitor. Codex and Claude Code can
read cached hosts and containers, or explicitly refresh selected hosts. The service
uses an authenticated loopback endpoint (default port `49160`) and stops with the window.
Only one window can listen on a given port; clients should run in the same environment.

Choose **Copy MCP environment variables** to obtain the endpoint and token. Configure
your client to use Streamable HTTP with the URL from `NPU_MONITOR_MCP_URL` and an
`Authorization: Bearer <token>` header using `NPU_MONITOR_MCP_TOKEN`. The copied values
contain credentials. Cached idle status is not a resource reservation. `rank_idle_hosts` and
`get_idle_history` read locally stored observations without SSH queries. MCP reports
NPU `collectedAt`, `ageSeconds`, `maxAgeSeconds`, `validUntil` and `outdated`
for twice the polling interval (360 seconds by default), including in ranked candidates.
Container `collectedAt` and `ageSeconds` are independent; `maxAgeSeconds`, `validUntil`
and `outdated` are `null` because containers have no fixed expiry. Check `stale` after failures.

## Configuration

Search for `NPU Monitor` in VS Code settings:

| Setting | Default | Description |
| --- | --- | --- |
| `mcp.enabled` | `false` | Enable MCP in this workspace |
| `mcp.port` | `49160` | Loopback MCP port |
| `sshConfigPath` | Remote - SSH config or auto-detected | Explicit NPU Monitor paths have highest priority; when empty, `remote.SSH.configFile` is used before Windows / WSL auto-detection |
| `knownHostsPath` | Next to SSH config | Host key file |
| `sshExecutablePath` | Auto-detected | Windows OpenSSH or `/usr/bin/ssh` |
| `connectTimeoutSeconds` | `8` | SSH connection timeout |
| `exporterProbeTimeoutSeconds` | `2` | Total Exporter probe timeout |
| `npuSmiTimeoutSeconds` | `10` | `npu-smi info` timeout |
| `maxConcurrentHosts` | `8` | Maximum hosts scanned concurrently per VS Code window |
| `excludedHosts` | `[]` | Host aliases that are hidden and never scanned |
| `devContainers.enabled` | `true` | Enable container monitoring |
| `devContainers.timeoutSeconds` | `5` | Container query timeout, excluding SSH connection time |
| `containers.filterMode` | `devContainers` | Show `all` Docker containers, `devContainers`, or filter by `workspacePaths` |
| `containers.workspacePaths` | `[]` | Host workspace directories used only in `workspacePaths` mode |
| `containers.workspaceFile` | Empty | Workspace file name to open instead of the mapped container workspace folder |
| `pollIntervalSeconds` | `180` | Automatic NPU polling interval, minimum 10 seconds |
| `autoRefreshAllHosts` | `true` | Scan NPU and containers on all hosts at startup, then poll NPU only; disabling this limits startup and polling to subscribed hosts |
| `idleHistoryRetentionDays` | `7` | Local per-NPU history retention, 1–30 days |
| `idleScope` | `anyCard` | Require all cards or any card to be idle |
| `idleRequireNoProcesses` | `true` | Require no NPU processes when determining idle state |
| `idleUtilizationThresholdPercent` | `1` | Maximum utilization considered idle |
| `idleConsecutiveChecks` | `1` | Consecutive idle checks required before notification |

SSH-related paths support `~`, `${env:NAME}`, and Windows `%NAME%` environment variables.
When WSL reads a Windows configuration, Windows paths such as `C:\...` are
converted automatically for both NPU Monitor and Remote - SSH settings.

In `workspacePaths` mode, set one or more absolute Linux directories on the
**host**. Paths match the directory and its descendants, are case-sensitive, and
do not expand `~`, variables, or wildcards. An empty list shows all Dev Containers;
the other modes ignore saved paths. Filter changes apply immediately to cached data.

```json
{
  "npuMonitor.containers.filterMode": "workspacePaths",
  "npuMonitor.containers.workspacePaths": ["/home/user", "/mnt/work/user"]
}
```

Set `containers.workspaceFile` to a file name such as
`vllm-ascend-dev.code-workspace` to open that file from the root of every mapped
container workspace. Leave it empty to keep opening the workspace folder. The name
must end in `.code-workspace` and cannot contain path separators; variables and
wildcards are not expanded. Scans only check whether the file is a regular file and
do not read its contents. Opening reports an error if the configured file is missing.

## Security

- OpenSSH host key verification is always enabled.
- The extension never accepts new host keys automatically or modifies
  SSH config, `known_hosts`, or keys.
- Scans use `BatchMode=yes` to prevent password prompts.
- Interactive SSH terminals may prompt inside the terminal, but still keep host
  key verification enabled and disable host key updates.
- Container environment variables and unrelated labels are not collected.
- Machine addresses, usernames, SSH configurations, and keys are never bundled
  into the VSIX.

## Development

Use Node.js 24 LTS for development and packaging. Runtime types remain aligned
with VS Code 1.100 / Node.js 20; TypeScript 6 and Vitest 4 keep the toolchain compatible.

### Directory Structure

```text
src/
  extension.ts       # Activation and command registration
  settings.ts        # Settings
  types.ts           # Shared data types
  monitorService.ts  # Subscriptions, scheduling, and cached state
  mcp/               # MCP server, cached tools and lifecycle
  ssh/               # SSH configuration and execution
  npu/               # NPU collection, parsing, and idle detection
  containers/        # Container collection, metadata, and filtering
  ui/                # Tree view and actions
test/                # Automated tests
  mcp/
  ssh/
  npu/
  containers/
  ui/
  extension.test.ts
  monitorService.test.ts
  fixtures/          # Shared samples
  mocks/             # Shared mocks
scripts/             # Packaging scripts
l10n/                # Interface translations
media/               # Icons and demo assets
```

### Development Guidelines

- Support native Windows OpenSSH and WSL `/usr/bin/ssh`; cover platform differences in tests.
- Keep commands, settings, and documentation consistent in Chinese and English.
- Use short English commit messages in the form `[Tag] Brief description`.

### Development Commands

```bash
npm run check-types
npm run lint
npm test
npm run compile
npm run check
npm run vsix
```
