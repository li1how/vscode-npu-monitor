# Developing NPU Monitor

English | [简体中文](CONTRIBUTING.zh-CN.md) | [User guide](https://github.com/li1how/vscode-npu-monitor/blob/main/README.md)

## Setup and checks

Use Node.js 24 LTS for development and packaging. Runtime types remain aligned
with VS Code 1.100 / Node.js 20; the bundle targets Node.js 20.

```bash
npm ci
npm run check
npm run compile
code .
```

Press `F5` to start an Extension Development Host. Run `npm run compile` after
changes, or use `npm run watch` while developing.

| Command | Purpose |
| --- | --- |
| `npm run check-types` | Check source and test types |
| `npm run lint` | Check source, tests and build scripts |
| `npm test` | Run automated tests |
| `npm run compile` | Check types and build a development bundle |
| `npm run watch` | Rebuild the development bundle on changes |
| `npm run check` | Run type checks, lint and tests |
| `npm run vsix` | Run all checks, build production code and package the VSIX |
| `npm run docs:capture` | Refresh the README animation and screenshots in `media/` |

`npm run vsix` writes `release/vscode-npu-monitor-<version>.vsix` using the version
in `package.json`. CI runs this command on Linux and Windows, so it also checks
the packaging path without running the same checks twice.

## Project structure

```text
src/
  extension.ts       # Component creation, configuration events and lifecycle
  settings.ts        # Settings
  types.ts           # Shared domain types
  hostPreferences.ts # Local favorite and note storage
  monitorService.ts  # Subscriptions, scan scheduling and cached state
  mcp/               # HTTP service, cached queries, scoped refresh and pagination
  ssh/               # SSH configuration and process execution
  npu/               # Collection, parsing, idle detection, freshness and history
  containers/        # Read-only collection, metadata and cached filtering
  ui/                # Commands, selection, formatting, tree and history view
test/
  mcp/ ssh/ npu/ containers/ ui/ # Tests grouped by responsibility
  extension.test.ts # Activation and command wiring
  manifest.test.ts  # Menu placement and localization contracts
  monitorService.test.ts # Scan orchestration
  helpers/           # Shared test data and in-memory storage
  fixtures/          # Collector output samples
  mocks/             # VS Code API test double
scripts/             # Packaging and README capture scripts
  readme/            # Isolated demonstration data and screenshot scenes
l10n/                # Runtime translations
media/               # Icons and demo assets
```

## Development conventions

- Support native Windows OpenSSH and WSL `/usr/bin/ssh`; test platform differences.
- Keep command IDs, settings and MCP response contracts stable during internal
  refactors. Update relevant tests and both user guides when behavior changes.
- Keep NPU and container failures, collection times and stale data independent.
  Search, filtering and copying read local caches. Only explicit MCP refresh starts
  collection; it reuses scheduling without changing subscriptions.
- Keep container connection encoding in `src/ui/containerActions.ts`. Recheck it
  when Remote - SSH or Dev Containers changes.
- Keep manifest strings in `package.nls.json` and `package.nls.zh-cn.json`, and
  runtime strings in `vscode.l10n.t` with Chinese translations in `l10n/`.
- Use focused test doubles and shared fixture builders; keep expected behavior
  explicit in tests. Clean up temporary directories, timers and listeners.
- Run `npm run vsix` and `git diff --check` before delivery. Distinguish automated
  tests, real SSH collection and VS Code UI validation in the report.
- Use short English commit messages in the form `[Tag] Brief description`.

Real SSH validation requires an explicitly selected host scope. Use isolated
configuration and subscription state; leave SSH configuration, `known_hosts`, keys
and existing subscriptions untouched. Remote checks may only read NPU and Docker
metadata and Dev Container configuration names. Do not install software, manage
services or create, start, stop or delete containers for testing. Follow the
[security behavior](https://github.com/li1how/vscode-npu-monitor/blob/main/README.md#security) for all collection paths. MCP credentials
stay in SecretStorage and are only delivered through user-initiated copying;
never log them or modify real MCP client settings during validation.

## Refresh README images

After changing the UI, regenerate the three assets used by both READMEs:

```bash
npm ci
npm run docs:capture
```

The command builds the current extension source, opens an isolated VS Code window,
and updates `media/host-search-and-filter.gif`, `media/monitoring.png` and
`media/idle-history.png`. It captures host expansion, idle filtering, search and
reveal, container actions, and the per-card history view. Review the images before
committing them. Only a complete, successful capture replaces the existing assets.

The first run downloads VS Code 1.100.3 into the ignored `release/readme-capture/`
cache; subsequent runs reuse it. Each run uses a fresh profile, workspace and
extension directory, a fixed English theme/layout, and synthetic data with a fixed
clock. It does not read SSH configuration, collect remote data, change existing
subscriptions or enable MCP. Demonstration code is used only by the capture build
and is excluded from the production bundle and VSIX.

A graphical desktop is required. WSLg works directly; on a headless Linux host use
`xvfb-run -a npm run docs:capture` after installing Xvfb. Minimal Debian/Ubuntu
systems may need `libasound` or `libxkbfile`; the script downloads and extracts those
libraries into its cache without installing system packages. Other missing VS Code
runtime dependencies must be installed separately. The workflow has been verified
on Linux/WSLg; native Windows and macOS capture have not been verified.

Run `npm run docs:capture -- --help` for an existing native VS Code executable
override (`--vscode-path`) or an alternate output directory (`--output-dir`).
Update `scripts/readme/fixtures.ts` when changing sample data and
`scripts/readme/scenes.mjs` when changing the demonstrated flow. The service's
public interface is type-checked against production. Failed runs retain logs and a
failure screenshot, when available, under the cache path printed by the command;
successful runs remove their temporary profile.

## Release

Publishing, tagging and pushing require an explicit task request. These examples
document the process and do not authorize a release.

Pushing a `vX.Y.Z` tag matching `package.json` runs checks, builds the VSIX and
publishes a GitHub Release. The tag must point to a commit on `main`; only stable
three-part versions are supported. Use merge or squash merges and preserve PR
numbers in commit titles.

[github/copilot-release-notes](https://github.com/github/copilot-release-notes)
generates notes from merged PRs using the [release writing guide](https://github.com/li1how/vscode-npu-monitor/blob/main/.github/release-notes-instructions.md).
Actions uses its built-in `GITHUB_TOKEN` and requires available Copilot access and
quota. `RELEASE_NOTES_MODEL` optionally selects a model; otherwise Copilot uses its
default. Publication stops if note generation fails.

Keep changes under `Unreleased` during development. When preparing a release,
create a branch from the latest `main` and update the package version. Replace
`X.Y.Z` with the intended version:

```bash
git switch main
git pull --ff-only origin main
git switch -c release/vX.Y.Z
npm version X.Y.Z --no-git-tag-version
```

Move the changes being released from `Unreleased` into a `X.Y.Z` section in
`CHANGELOG.md`, leaving an empty `Unreleased` section for future work. Commit the
version, lockfile and changelog changes, then open a pull request against `main`:

```bash
git add package.json package-lock.json CHANGELOG.md
git commit -m "[Release] Prepare vX.Y.Z"
git push -u origin release/vX.Y.Z
```

After CI passes and the PR is merged, tag the resulting commit on `main`.
Replace `RELEASE_COMMIT_SHA` with the merged commit SHA from the PR, including
when squash merging; do not use the release branch's original commit SHA:

```bash
git switch main
git pull --ff-only origin main
git tag -a vX.Y.Z RELEASE_COMMIT_SHA -m "vX.Y.Z"
git push origin vX.Y.Z
```

The release asset is `vscode-npu-monitor-<version>.vsix`. GitHub also provides
source archives in zip and tar.gz formats.
