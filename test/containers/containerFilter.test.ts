import { beforeEach, describe, expect, it } from 'vitest';

import { filterContainers, invalidWorkspacePathCount } from '../../src/containers/filter.js';
import { getSettings } from '../../src/settings.js';
import type { DevContainer, MonitorSettings } from '../../src/types.js';
import { configurationValues, resetVscodeMock } from '../mocks/vscode.js';

const dev: DevContainer = {
  id: 'a'.repeat(64), isDevContainer: true, name: 'dev', image: 'dev', state: 'exited', createdAt: 'now',
  workspaceFolder: '/home/user/project',
};
const other = { ...dev, id: 'b'.repeat(64), workspaceFolder: '/mnt/work/project' };
const missing = { ...dev, id: 'c'.repeat(64), workspaceFolder: undefined, configFile: '/home/user/config.json' };
const ordinary = { ...dev, id: 'd'.repeat(64), isDevContainer: false };
const containers = [dev, other, missing, ordinary];

function settings(mode: MonitorSettings['containerFilterMode'], paths: string[] = []): MonitorSettings {
  return { ...getSettings(), containerFilterMode: mode, containerWorkspacePaths: paths };
}

describe('container view modes and host workspace paths', () => {
  beforeEach(resetVscodeMock);

  it.each([[], ['/home/user'], ['/home/user', '/mnt/work'], ['relative', '']].map(paths => ({ paths })))(
    'all and devContainers modes ignore saved paths %j', ({ paths }) => {
      expect(filterContainers(containers, settings('all', paths))).toEqual(containers);
      expect(filterContainers(containers, settings('devContainers', paths))).toEqual([dev, other, missing]);
      expect(invalidWorkspacePathCount(settings('all', paths))).toBe(0);
    });

  it('shows every Dev Container for empty paths and matches any directory otherwise', () => {
    expect(filterContainers(containers, settings('workspacePaths'))).toEqual([dev, other, missing]);
    expect(filterContainers(containers, settings('workspacePaths', ['/home/user']))).toEqual([dev]);
    expect(filterContainers(containers, settings('workspacePaths', ['/home/user', '/mnt/work']))).toEqual([dev, other]);
    expect(filterContainers(containers, settings('workspacePaths', ['/']))).toEqual([dev, other]);
  });

  it.each([
    ['/home/user', true], ['/home/user/project', true], ['/home//user/./tmp/../', true],
    ['/home/use', false], ['/home/user/project/sub', false], ['/HOME/user', false],
    ['/home/*', false], ['/home/${USER}', false], ['~/user', false], ['file:///home/user', false],
    ['relative', false], ['', false], ['/home/user\0', false],
  ])('uses POSIX directory boundaries without expansion: %s', (root, match) => {
    expect(filterContainers([dev], settings('workspacePaths', [root]))).toEqual(match ? [dev] : []);
  });

  it('normalizes the workspace and preserves valid special characters literally', () => {
    const workspace = '/mnt/中文 [dir] "quotes"\n$(whoami)';
    const special = { ...dev, workspaceFolder: workspace + '/./tmp/../project//' };
    expect(filterContainers([special], settings('workspacePaths', [workspace]))).toEqual([special]);
    expect(filterContainers([{ ...dev, workspaceFolder: '/home/user2/project' }],
      settings('workspacePaths', ['/home/user']))).toEqual([]);
  });

  it('does not infer paths from configuration files or match invalid workspace values', () => {
    const invalid = ['', 'relative', 'C:\\home\\user', '/home/user\0'].map(workspaceFolder => ({ ...dev, workspaceFolder }));
    expect(filterContainers([missing, ...invalid], settings('workspacePaths', ['/']))).toEqual([]);
  });

  it('warns about invalid entries and never interprets invalid settings as an empty path list', () => {
    configurationValues.set('npuMonitor.containers.filterMode', 'workspacePaths');
    for (const invalid of [[''], ['relative'], [null, 5], 'not-an-array', null]) {
      configurationValues.set('npuMonitor.containers.workspacePaths', invalid);
      expect(invalidWorkspacePathCount(getSettings())).toBeGreaterThan(0);
      expect(filterContainers(containers, getSettings())).toEqual([]);
    }
    configurationValues.set('npuMonitor.containers.workspacePaths', ['relative', '/home/user']);
    expect(invalidWorkspacePathCount(getSettings())).toBe(1);
    expect(filterContainers(containers, getSettings())).toEqual([dev]);
  });

  it('defaults safely and retains saved paths when modes change', () => {
    expect(getSettings()).toMatchObject({ containerFilterMode: 'devContainers', containerWorkspacePaths: [] });
    configurationValues.set('npuMonitor.containers.workspacePaths', ['/home/user']);
    for (const mode of ['all', 'workspacePaths', 'devContainers', 'invalid']) {
      configurationValues.set('npuMonitor.containers.filterMode', mode);
      expect(getSettings().containerWorkspacePaths).toEqual(['/home/user']);
    }
    expect(getSettings().containerFilterMode).toBe('devContainers');
  });
});
