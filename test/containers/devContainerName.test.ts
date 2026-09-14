import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { devContainerDisplayName } from '../../src/containers/metadata.js';
import { RESOLVE_DEV_CONTAINER_NAMES } from '../../src/containers/collector.js';

const container = { id: 'a'.repeat(64), isDevContainer: true, name: 'random_docker_name', image: 'image', state: 'running', createdAt: 'now' };

describe('Dev Container display names', () => {
  it('uses the configured name and falls back to a workspace basename, never the Docker name', () => {
    expect(devContainerDisplayName({ ...container, displayName: ' vllm-ascend-dev ', workspaceFolder: '/other' }))
      .toBe('vllm-ascend-dev');
    expect(devContainerDisplayName({ ...container, workspaceFolder: '/home/user/workspace/' })).toBe('workspace');
    expect(devContainerDisplayName({ ...container, workspaceFolder: 'C:\\Users\\user\\workspace\\' })).toBe('workspace');
    expect(devContainerDisplayName({ ...container, displayName: '  ' })).toBe('Dev Container');
    expect(devContainerDisplayName({ ...container, workspaceFolder: '/' })).toBe('Dev Container');
  });

  it.skipIf(process.platform === 'win32')('reads the top-level name from JSONC on the host without returning other properties', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'dev-container-name-'));
    try {
      const filename = path.join(dir, 'config with spaces.json');
      writeFileSync(filename, '\ufeff' + [
        '{', '// "name": "comment name",',
        '"customizations": {"name": "nested name"},',
        '"url": "http://example.com/a/*b*/",',
        '"name": "Ascend \\"Dev\\" 中文", /* a trailing comment */',
        '"containerEnv": {"PRIVATE": "must-not-return-this-value",},',
        '}',
      ].join('\n').replaceAll('\\\\"', '\\"'));
      const input = JSON.stringify({ id: container.id, configFile: filename }) + '\n' +
        JSON.stringify({ id: 'b'.repeat(64), configFile: pathToFileURL(filename).href }) + '\n';
      const output = execFileSync('python3', ['-c', RESOLVE_DEV_CONTAINER_NAMES], { input, encoding: 'utf8' });
      const records = output.trim().split('\n').map(line => JSON.parse(line));
      expect(records.map(x => x.configuredName)).toEqual(['Ascend "Dev" 中文', 'Ascend "Dev" 中文']);
      expect(output).not.toContain('must-not-return-this-value');
      expect(output).not.toContain('containerEnv');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('leaves the Docker result intact for missing, invalid, oversized or nameless configs', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'dev-container-name-errors-'));
    try {
      const contents = ['{invalid', '{"name":123}', '{"other":"value"}', '{"name":"  "}',
        JSON.stringify({ name: 'too large', data: 'x'.repeat(65536) })];
      const records = contents.map((text, index) => {
        const filename = path.join(dir, index + '.json');
        writeFileSync(filename, text);
        return { id: container.id, configFile: filename };
      });
      records.push({ id: container.id, configFile: path.join(dir, 'missing.json') });
      records.push({ id: container.id, configFile: dir });
      const input = records.map(x => JSON.stringify(x)).join('\n') + '\nError: No such container: ' + container.id + '\n';
      const output = execFileSync('python3', ['-c', RESOLVE_DEV_CONTAINER_NAMES], { input, encoding: 'utf8' });
      expect(output.trim().split('\n').slice(0, -1).map(line => JSON.parse(line))).toEqual(records);
      expect(output).toContain('Error: No such container: ' + container.id);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
