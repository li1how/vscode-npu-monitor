# Changelog

## Unreleased

- Simplify internal commands, selection, freshness and MCP types; remove unused collectors, expand execution and activation tests, and move development and release instructions into bilingual contributing guides.
- Update development minimatch to 11.0.5 and glob to 14.0.4 to fix the globparts amplification advisory (GHSA-g3hv-75wg-m249).
- Organize MCP tools around resource overview, filtered host discovery, section-specific details, historical evidence and explicit scoped refresh. Replace previous tools with bounded, paginated results and shared read-only resource state.
- Add host search by alias, address and local note, persistent favorites, and cached host filters with visible/total counts. Replace the idle-host picker with the idle filter while retaining duration ranking.
- Share fresh NPU summaries between search and the host tree, show unknown idle counts explicitly, and update filters when cached NPU data expires without additional SSH queries.

## 0.2.5

- Read existing `known_hosts` files beside the SSH configuration and in the extension user's home together, so WSL can use its trusted host keys with a Windows SSH configuration. Preserve explicit path overrides and strict host key verification.
- Update @modelcontextprotocol/sdk to 1.32.0, vitest to 4.1.12, zod to 4.6.7, vite to 8.3.4, hono to 4.13.13, @hono/node-server to 2.1.6, markdown-it to 14.3.3, fast-uri to 3.1.9, undici to 7.30.1, body-parser to 2.4.0, ip-address to 10.7.5, and @azure/msal-node / @azure/identity.

## 0.2.4

- Add the `refresh_containers` MCP tool to update container metadata without an NPU scan, and the read-only `list_host_images` tool to discover up to 20 vLLM-Ascend candidate images with tags, image ID, creation time, architecture and OS. Container details now include the actual image ID.
- Record NPUs with running processes as busy in idle history even when the snapshot is partial or health data is missing, keep busy and mixed bins from collapsing to unknown, and draw mixed history cells as idle/busy stripes.
- Update @modelcontextprotocol/sdk to 1.31.0, js-yaml to 4.3.2, linkify-it to 5.0.2, brace-expansion to 5.0.12, source-map-js to 1.2.2 and fast-uri to 3.1.8.

## 0.2.3

- Update ESLint and typescript-eslint within their existing major versions.
- Scan NPU and containers on startup, then refresh NPU status every 180 seconds by default. Show per-NPU idle history and ranked candidates in the UI and MCP with separate data freshness.
- Simplify host summaries and action placement, show the newest idle-history days first, and raise the per-window scan concurrency default from 6 to 8.

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
