# NPU Monitor for VS Code

English | [简体中文](README.zh-CN.md)

Monitor Ascend NPUs and Docker containers across multiple SSH hosts from VS Code.
The extension supports native Windows and WSL OpenSSH, with Chinese and English
interfaces that follow the VS Code language setting.

## Features

- Load hosts automatically from an OpenSSH configuration file.
- Scan all hosts, one host, or multiple selected hosts manually.
- Subscribe to idle notifications and poll only subscribed hosts automatically.
- Prefer NPU-Exporter `/metrics` and quickly fall back to `npu-smi info`.
- Display health, utilization, HBM, temperature, power, and NPU processes.
- Monitor Docker containers with Dev Container and workspace directory filters.
- Open running containers in a new window and copy container information.
- Distinguish connection timeouts, authentication failures, host key errors,
  and collection failures.

Automatic scans access only subscribed hosts. Manual scans never change the
subscription list.

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
code --install-extension release/vscode-npu-monitor-0.1.1.vsix
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
npm version 0.1.1 --no-git-tag-version
git add package.json package-lock.json CHANGELOG.md
git commit -m "[Release] Prepare v0.1.1"
git push origin main
git tag -a v0.1.1 -m "v0.1.1"
git push origin v0.1.1
```

The release asset name is generated from the package version, for example
`release/vscode-npu-monitor-0.1.1.vsix`. GitHub also provides source code
archives in zip and tar.gz formats.

## Usage

1. Open **NPU Monitor** in the Activity Bar.
2. On first use, the extension loads the SSH configuration without scanning
   every host.
3. Select the refresh icon in the view title to scan all hosts.
4. Use the refresh icon on a host to scan it, or select multiple hosts and run
   **Scan Selected Hosts**.
5. Use the terminal icon on a host to open an SSH terminal.
6. Select the bell icon to subscribe to a host. It is scanned immediately and
   included in periodic polling.
7. VS Code displays a notification when a subscribed host becomes idle.
8. Expand a host to view NPU and container status. Use a running container's
   new-window icon to attach in a separate VS Code window.
9. Use a container's copy icon for **Copy Summary**, or the context menu for
   **Copy Full Information**. Both support multiple selected containers.

Scans collect NPU data first, followed by read-only Docker queries. Dev Containers
are shown by default and use the configured project name when available. Failed
scans retain the last successful data with a **Stale** marker.

Remote - SSH must use the same SSH configuration and host aliases as NPU Monitor
when opening a container.

## Configuration

Search for `NPU Monitor` in VS Code settings:

| Setting | Default | Description |
| --- | --- | --- |
| `sshConfigPath` | Remote - SSH config or auto-detected | Explicit NPU Monitor paths have highest priority; when empty, `remote.SSH.configFile` is used before Windows / WSL auto-detection |
| `knownHostsPath` | Next to SSH config | Host key file |
| `sshExecutablePath` | Auto-detected | Windows OpenSSH or `/usr/bin/ssh` |
| `connectTimeoutSeconds` | `8` | SSH connection timeout |
| `exporterProbeTimeoutSeconds` | `2` | Total Exporter probe timeout |
| `npuSmiTimeoutSeconds` | `10` | `npu-smi info` timeout |
| `maxConcurrentHosts` | `6` | Maximum concurrent manual or automatic scans |
| `excludedHosts` | `[]` | Host aliases that are hidden and never scanned |
| `devContainers.enabled` | `true` | Enable container monitoring |
| `devContainers.timeoutSeconds` | `5` | Container query timeout, excluding SSH connection time |
| `containers.filterMode` | `devContainers` | Show `all` Docker containers, `devContainers`, or filter by `workspacePaths` |
| `containers.workspacePaths` | `[]` | Host workspace directories used only in `workspacePaths` mode |
| `pollIntervalSeconds` | `60` | Subscription polling interval, minimum 10 seconds |
| `idleScope` | `allCards` | Require all cards or any card to be idle |
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

### Directory Structure

```text
src/
  extension.ts       # Activation and command registration
  settings.ts        # Settings
  types.ts           # Shared data types
  monitorService.ts  # Subscriptions, scheduling, and cached state
  ssh/               # SSH configuration and execution
  npu/               # NPU collection, parsing, and idle detection
  containers/        # Container collection, metadata, and filtering
  ui/                # Tree view and actions
test/                # Automated tests
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
