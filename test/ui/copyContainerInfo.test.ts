import { readFileSync } from 'node:fs';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { copyContainerInfo, copyContainerSummary, formatContainerInfo, formatContainerSummary } from '../../src/ui/containerActions.js';
import { ContainerNode, HostNode, StatusNode } from '../../src/ui/nodes.js';
import type { DevContainer, HostRecord } from '../../src/types.js';
import { clipboardFailures, clipboardWrites, commandCalls, errorMessages, informationMessages, l10n, resetVscodeMock } from '../mocks/vscode.js';

function fixture(alias = 'host', overrides: Partial<DevContainer> = {}): ContainerNode {
  const container: DevContainer = { id: 'a'.repeat(64), isDevContainer: true, name: 'random_name',
    displayName: 'vllm-ascend-dev', state: 'running', image: 'dev:latest', createdAt: '2026-09-14T00:00:00Z',
    workspaceFolder: '/home/user/中文 "quotes" $(id)', ...overrides };
  const record: HostRecord = {
    host: { alias, hostname: 'example.test', user: 'root', port: 2222,
      identityFiles: ['/private/key'], configPath: '/private/ssh-config', useAlias: true },
    state: 'unknown', subscribed: false, refreshing: false, stale: false, idleStreak: 0, idleNotified: false,
    devContainers: { state: 'ready', stale: false, refreshing: false,
      snapshot: { containers: [container], collectedAt: 0, durationMs: 1 } },
  };
  return new ContainerNode(record, container);
}

describe('copy container information', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetVscodeMock();
  });
  it('copies readable selected metadata, timestamps and placeholders without executing commands', async () => {
    const node = fixture();
    await copyContainerInfo([], node);
    expect(clipboardWrites).toHaveLength(1);
    const text = clipboardWrites[0]!;
    for (const field of ['SSH config: /private/ssh-config', 'SSH host: host', 'SSH target: root@example.test:2222', 'Name: vllm-ascend-dev',
      'Docker name: random_name', 'Container ID: ' + 'a'.repeat(64), 'Type: Dev Container',
      'Status: running', 'Image: dev:latest', 'Workspace folder: ' + node.container.workspaceFolder,
      'Container workspace folder: -', 'Configuration file: -', 'Created: 2026-09-14T00:00:00Z',
      'Started: -', 'Updated: 1970-01-01T00:00:00.000Z', 'Stale: No']) expect(text).toContain(field);
    expect(text).not.toContain('/private/key');
    expect(commandCalls).toEqual([]);
  });

  it('copies exactly five summary fields with literal special characters', async () => {
    const node = fixture('NPU(中文) "alias"', { containerWorkspaceFolder: '/workspaces/project' });
    node.record.host.configPath = 'C:\\Users\\user name\\.ssh\\config';
    await copyContainerSummary([], node);
    expect(clipboardWrites).toEqual([[
      'SSH config: C:\\Users\\user name\\.ssh\\config',
      'SSH host: NPU(中文) "alias"',
      'Container ID: ' + 'a'.repeat(64),
      'Host workspace: /home/user/中文 "quotes" $(id)',
      'Container workspace: /workspaces/project',
    ].join('\n')]);
    expect(commandCalls).toEqual([]);
  });

  it.each(['exited', 'paused', 'created', 'restarting', 'removing', 'dead', ''])(
    'only adds runtime state when the container is not running: %s', state => {
      const node = fixture('host', { isDevContainer: false, state });
      expect(formatContainerSummary(node).split('\n').at(-1)).toBe('Status: ' + (state || 'unknown'));
      expect(formatContainerSummary(node).split('\n')).toHaveLength(6);
    },
  );

  it('uses placeholders for missing summary fields and only adds freshness when stale', () => {
    const node = fixture('', { id: '', workspaceFolder: undefined, containerWorkspaceFolder: '' });
    node.record.host.configPath = '';
    expect(formatContainerSummary(node)).toBe([
      'SSH config: -', 'SSH host: -', 'Container ID: -', 'Host workspace: -', 'Container workspace: -',
    ].join('\n'));
    node.record.devContainers!.stale = true;
    expect(formatContainerSummary(node).split('\n').at(-1)).toBe('Stale: yes');
    expect(formatContainerInfo(node)).toContain('SSH config: -');
  });

  it('keeps summary keys in English while full information uses UI translations', () => {
    const node = fixture();
    const summary = formatContainerSummary(node);
    const translate = l10n.t;
    const localized = vi.spyOn(l10n, 't').mockImplementation((template, ...values) =>
      '中文 ' + translate(template, ...values));
    expect(formatContainerSummary(node)).toBe(summary);
    expect(localized).not.toHaveBeenCalled();
    expect(formatContainerInfo(node)).toContain('中文 SSH config: /private/ssh-config');
    expect(localized).toHaveBeenCalled();
  });

  it('binds the inline copy button to summary and the context menu to full information', () => {
    const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
    const menus = manifest.contributes.menus['view/item/context'] as Array<{ command: string; group: string; when: string }>;
    const copies = menus.filter(item => item.command.startsWith('npuMonitor.copyContainer'));
    expect(copies).toEqual([
      { command: 'npuMonitor.copyContainerSummary', group: 'inline@2',
        when: 'view == npuMonitor.hosts && viewItem =~ /^npuDevContainer/' },
      { command: 'npuMonitor.copyContainerInfo', group: '3_copy@1',
        when: 'view == npuMonitor.hosts && viewItem =~ /^npuDevContainer/' },
    ]);
    for (const command of ['copyContainerSummary', 'copyContainerInfo']) {
      expect(manifest.contributes.commands).toContainEqual({ command: 'npuMonitor.' + command,
        title: '%command.' + command + '%', icon: '$(copy)' });
    }
    const chinese = JSON.parse(readFileSync('package.nls.zh-cn.json', 'utf8'));
    expect(chinese['command.copyContainerSummary']).toBe('复制精简信息');
    expect(chinese['command.copyContainerInfo']).toBe('复制完整信息');
  });

  describe.each([
    ['summary', copyContainerSummary], ['full', copyContainerInfo],
  ] as const)('%s selection and clipboard behavior', (_format, copy) => {
    it('copies multiple containers, ignores other nodes and deduplicates by host and full ID', async () => {
      const first = fixture();
      const second = fixture('other');
      await copy([first, new ContainerNode(first.record, first.container),
        new HostNode(first.record), new StatusNode('status'), second], first);
      expect(clipboardWrites).toHaveLength(1);
      expect(clipboardWrites[0]!.match(/Container ID:/g)).toHaveLength(2);
      expect(clipboardWrites[0]).toContain('SSH host: other');
      expect(clipboardWrites[0]).toContain('\n\n---\n\n');
      expect(commandCalls).toEqual([]);
    });

    it('copies only the clicked container when it is outside the current selection', async () => {
      await copy([fixture('selected')], fixture('clicked'));
      expect(clipboardWrites[0]).toContain('SSH host: clicked');
      expect(clipboardWrites[0]).not.toContain('SSH host: selected');
    });

    it('copies the latest snapshot behind an old selection, including stale data and ordinary containers', async () => {
      const node = fixture();
      node.record.devContainers!.snapshot!.containers = [{ ...node.container, isDevContainer: false, state: 'exited' }];
      node.record.devContainers!.stale = true;
      await copy([node]);
      if (copy === copyContainerInfo) {
        expect(clipboardWrites[0]).toContain('Name: random_name');
        expect(clipboardWrites[0]).toContain('Type: Docker container');
      }
      expect(clipboardWrites[0]).toContain('Status: exited');
      expect(clipboardWrites[0]).toContain(copy === copyContainerInfo ? 'Stale: Yes' : 'Stale: yes');
    });

    it('does not overwrite the clipboard for empty, non-container or removed selections', async () => {
      const node = fixture();
      node.record.devContainers!.snapshot!.containers = [];
      for (const selection of [[], [new HostNode(node.record)], [node]]) await copy(selection);
      expect(clipboardWrites).toEqual([]);
      expect(informationMessages).toHaveLength(3);
    });

    it('handles clipboard failures and formats IPv6 connection targets', async () => {
      const node = fixture();
      node.record.host.hostname = '::1';
      expect(formatContainerInfo(node)).toContain('SSH target: root@[::1]:2222');
      clipboardFailures.push(new Error('unavailable'));
      await copy([], node);
      expect(errorMessages).toEqual(['Unable to copy container information: unavailable']);
      expect(clipboardWrites).toEqual([]);
    });
  });
});
