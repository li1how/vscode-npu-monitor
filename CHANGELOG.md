# Changelog

## Unreleased

## 0.2.2

- Expose cached monitoring and explicit refresh through authenticated MCP, with panel status and environment-variable copy for Codex and Claude Code.

## 0.2.1

- Copy SSH host connection information from the host context menu.
- Optionally open a configured `.code-workspace` file when attaching to a container.
- Correct A3 process attribution when each logical NPU contains multiple physical chips.

## 0.2.0

- Add Docker container monitoring with Dev Container and workspace directory filters.
- Open running containers in a new window and copy summary or full information.
- Organize source and test modules by responsibility and improve container tree rendering.
- Refresh dependencies and CI tooling while preserving VS Code 1.100 compatibility.

## 0.1.1

- Support `remote.SSH.configFile` when the NPU Monitor SSH config path is empty.
- Add a host action that opens an interactive SSH terminal.

## 0.1.0

- Add Windows and WSL SSH host discovery.
- Add NPU-Exporter-first collection with fast `npu-smi` fallback.
- Add Tree View scanning, subscriptions, polling, and idle notifications.
- Add English and Simplified Chinese UI text.
