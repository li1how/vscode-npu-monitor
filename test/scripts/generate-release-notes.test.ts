import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const projectRoot = process.cwd();
const scriptPath = path.join(projectRoot, 'scripts/generate-release-notes.mjs');
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const sampleChangelog = `# Changelog

## Unreleased

## 0.2.5

- Read existing \`known_hosts\` files beside the SSH configuration and in the extension user's home together, so WSL can use its trusted host keys with a Windows SSH configuration. Preserve explicit path overrides and strict host key verification.
- Update @modelcontextprotocol/sdk to 1.32.0, vitest to 4.1.12, zod to 4.6.7, vite to 8.3.4, hono to 4.13.13, @hono/node-server to 2.1.6, markdown-it to 14.3.3, fast-uri to 3.1.9, undici to 7.30.1, body-parser to 2.4.0, ip-address to 10.7.5, and @azure/msal-node / @azure/identity.

## 0.2.4

- Add the \`refresh_containers\` MCP tool to update container metadata without an NPU scan.
- Record NPUs with running processes as busy in idle history even when the snapshot is partial.
- Update @modelcontextprotocol/sdk to 1.31.0 and fast-uri to 3.1.8.
`;

describe('generate-release-notes', () => {
  it('builds emoji release notes from a CHANGELOG section', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'npu-release-notes-'));
    directories.push(directory);
    const changelogPath = path.join(directory, 'CHANGELOG.md');
    const outputPath = path.join(directory, 'RELEASE_NOTES.md');
    writeFileSync(changelogPath, sampleChangelog, 'utf8');

    const result = spawnSync(
      process.execPath,
      [
        scriptPath,
        '--changelog',
        changelogPath,
        '--version',
        '0.2.5',
        '--repository',
        'li1how/vscode-npu-monitor',
        '--output',
        outputPath,
      ],
      {
        cwd: projectRoot,
        encoding: 'utf8',
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(outputPath, 'utf8')).toBe(`## What's Changed

* 🔑 Read existing \`known_hosts\` files beside the SSH configuration and in the extension user's home together, so WSL can use its trusted host keys with a Windows SSH configuration. Preserve explicit path overrides and strict host key verification.
* 🛠️ Update @modelcontextprotocol/sdk to 1.32.0, vitest to 4.1.12, zod to 4.6.7, vite to 8.3.4, hono to 4.13.13, @hono/node-server to 2.1.6, markdown-it to 14.3.3, fast-uri to 3.1.9, undici to 7.30.1, body-parser to 2.4.0, ip-address to 10.7.5, and @azure/msal-node / @azure/identity.

**Full Changelog**: https://github.com/li1how/vscode-npu-monitor/compare/v0.2.4...v0.2.5
`);
  });

  it('matches the checked-in CHANGELOG for v0.2.5', () => {
    const result = spawnSync(
      process.execPath,
      [
        scriptPath,
        '--version',
        '0.2.5',
        '--repository',
        'li1how/vscode-npu-monitor',
      ],
      {
        cwd: projectRoot,
        encoding: 'utf8',
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("## What's Changed");
    expect(result.stdout).toContain('* 🔑 Read existing `known_hosts`');
    expect(result.stdout).toContain(
      '* 🛠️ Update @modelcontextprotocol/sdk to 1.32.0',
    );
    expect(result.stdout).toContain(
      '**Full Changelog**: https://github.com/li1how/vscode-npu-monitor/compare/v0.2.4...v0.2.5',
    );
  });

  it('exports helpers for emoji selection', async () => {
    const module = (await import(pathToFileURL(scriptPath).href)) as {
      pickReleaseEmoji: (bullet: string) => string;
      parseChangelogBullets: (changelog: string, version: string) => string[];
      findPreviousChangelogVersion: (
        changelog: string,
        version: string,
      ) => string | undefined;
    };

    expect(module.pickReleaseEmoji('Update vitest to 4.1.12')).toBe('🛠️');
    expect(
      module.pickReleaseEmoji('Add the `refresh_containers` MCP tool'),
    ).toBe('🔌');
    expect(module.findPreviousChangelogVersion(sampleChangelog, '0.2.5')).toBe(
      '0.2.4',
    );
    expect(module.parseChangelogBullets(sampleChangelog, '0.2.5')).toHaveLength(
      2,
    );
  });
});
