# NPU Monitor for VS Code

English | [简体中文](README.zh-CN.md)

Monitor Ascend NPU status across multiple SSH hosts from VS Code. The extension
supports both native Windows OpenSSH and WSL OpenSSH, and its interface follows
the language configured in VS Code.

## Features

- Load hosts automatically from an OpenSSH configuration file.
- Scan all hosts, one host, or multiple selected hosts manually.
- Subscribe to idle notifications and poll only subscribed hosts automatically.
- Prefer NPU-Exporter `/metrics` and quickly fall back to `npu-smi info`.
- Display health, utilization, HBM, temperature, power, and NPU processes.
- Distinguish connection timeouts, authentication failures, host key errors,
  and collection failures.

Automatic scans access only subscribed hosts. Manual scans never change the
subscription list.

## Requirements

- VS Code 1.100 or later.
- Windows OpenSSH Client or `/usr/bin/ssh` in WSL.
- Passwordless access to the hosts configured in the SSH configuration file.
- `npu-smi` installed on each remote host, or an accessible NPU-Exporter
  process running there.

## Build and Install

```bash
npm install
npm run check
npm run vsix
code --install-extension release/vscode-npu-monitor-0.1.0.vsix
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
5. Select the bell icon to subscribe to a host. It is scanned immediately and
   included in periodic polling.
6. VS Code displays a notification when a subscribed host becomes idle.

Each host scan uses one SSH session to:

1. Check exact `npu-exporter` / `npu_exporter` process names and locate
   `npu-smi` at the same time.
2. Probe at most two Exporter `/metrics` endpoints within a total of two
   seconds.
3. Run `npu-smi info` immediately when Exporter is absent or its metrics are
   unusable.
4. Normalize the result into host and NPU status data.

The scan never runs `systemctl`, filesystem-wide searches, Docker, Kubernetes,
or full port scans.

## Configuration

Search for `NPU Monitor` in VS Code settings:

| Setting | Default | Description |
| --- | --- | --- |
| `sshConfigPath` | Auto-detected | `%USERPROFILE%\.ssh\config` on Windows; `/mnt/c/Users/<user>/.ssh/config` is preferred in WSL |
| `knownHostsPath` | Next to SSH config | Host key file |
| `sshExecutablePath` | Auto-detected | Windows OpenSSH or `/usr/bin/ssh` |
| `connectTimeoutSeconds` | `8` | SSH connection timeout |
| `exporterProbeTimeoutSeconds` | `2` | Total Exporter probe timeout |
| `npuSmiTimeoutSeconds` | `10` | `npu-smi info` timeout |
| `maxConcurrentHosts` | `6` | Maximum concurrent manual or automatic scans |
| `excludedHosts` | `[]` | Host aliases that are hidden and never scanned |
| `pollIntervalSeconds` | `60` | Subscription polling interval, minimum 10 seconds |
| `idleScope` | `allCards` | Require all cards or any card to be idle |
| `idleRequireNoProcesses` | `true` | Require no NPU processes when determining idle state |
| `idleUtilizationThresholdPercent` | `1` | Maximum utilization considered idle |
| `idleConsecutiveChecks` | `1` | Consecutive idle checks required before notification |

Paths support `~`, `${env:NAME}`, and Windows `%NAME%` environment variables.
When WSL reads a Windows configuration, Windows key paths such as `C:\...` are
converted automatically.

## Security

- OpenSSH host key verification is always enabled.
- The extension never accepts new host keys automatically or modifies
  `known_hosts`.
- `BatchMode=yes` prevents password prompts.
- Machine addresses, usernames, SSH configurations, and keys are never bundled
  into the VSIX.

## Development Commands

```bash
npm run check-types
npm run lint
npm test
npm run compile
npm run check
npm run vsix
```
