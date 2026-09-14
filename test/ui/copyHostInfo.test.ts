import { readFileSync } from 'node:fs';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { copyHostInfo, formatHostInfo } from '../../src/ui/hostActions.js';
import { ContainerNode, HostNode, StatusNode } from '../../src/ui/nodes.js';
import type { HostRecord, SshHost } from '../../src/types.js';
import {
  clipboardFailures,
  clipboardWrites,
  commandCalls,
  errorMessages,
  informationMessages,
  l10n,
  resetVscodeMock,
} from '../mocks/vscode.js';

function fixture(alias = 'host', overrides: Partial<SshHost> = {}): HostNode {
  const record: HostRecord = {
    host: {
      alias,
      hostname: 'example.test',
      user: 'root',
      port: 2222,
      identityFiles: ['/private/key'],
      proxyJump: 'bastion',
      configPath: '/private/ssh-config',
      useAlias: true,
      ...overrides,
    },
    state: 'unknown',
    subscribed: false,
    refreshing: false,
    stale: false,
    idleStreak: 0,
    idleNotified: false,
  };
  return new HostNode(record);
}

describe('copy host information', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetVscodeMock();
  });

  it('copies exactly the localized connection fields without secrets or extra SSH settings', () => {
    const node = fixture();
    expect(formatHostInfo(node)).toBe([
      'SSH config: /private/ssh-config',
      'SSH host: host',
      'SSH target: root@example.test:2222',
    ].join('\n'));
    expect(formatHostInfo(node)).not.toContain('/private/key');
    expect(formatHostInfo(node)).not.toContain('bastion');

    const translate = l10n.t;
    vi.spyOn(l10n, 't').mockImplementation((template, ...values) =>
      '中文 ' + translate(template, ...values));
    expect(formatHostInfo(node).split('\n')).toEqual([
      '中文 SSH config: /private/ssh-config',
      '中文 SSH host: host',
      '中文 SSH target: root@example.test:2222',
    ]);
  });

  it('uses the default port, brackets IPv6 addresses and provides placeholders', () => {
    expect(formatHostInfo(fixture('ipv6', { hostname: '::1', user: undefined, port: undefined })))
      .toContain('SSH target: [::1]:22');
    expect(formatHostInfo(fixture('', { hostname: '', configPath: '' }))).toBe([
      'SSH config: -',
      'SSH host: -',
      'SSH target: -',
    ].join('\n'));
  });

  it('contributes a host-only context-menu command without an inline button', () => {
    const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(manifest.contributes.commands).toContainEqual({
      command: 'npuMonitor.copyHostInfo',
      title: '%command.copyHostInfo%',
      icon: '$(copy)',
    });
    const menus = manifest.contributes.menus['view/item/context'] as Array<{
      command: string;
      group: string;
      when: string;
    }>;
    expect(menus.filter(item => item.command === 'npuMonitor.copyHostInfo')).toEqual([{
      command: 'npuMonitor.copyHostInfo',
      when: 'view == npuMonitor.hosts && viewItem =~ /^npuHost/',
      group: '3_copy@1',
    }]);
    expect(JSON.parse(readFileSync('package.nls.json', 'utf8'))['command.copyHostInfo'])
      .toBe('Copy Host Information');
    expect(JSON.parse(readFileSync('package.nls.zh-cn.json', 'utf8'))['command.copyHostInfo'])
      .toBe('复制主机信息');
  });

  it('copies multiple hosts, filters other nodes and deduplicates aliases', async () => {
    const first = fixture();
    const second = fixture('other');
    const container = new ContainerNode(first.record, {
      id: 'a'.repeat(64),
      isDevContainer: true,
      name: 'dev',
      image: 'image',
      state: 'running',
      createdAt: 'now',
    });
    await copyHostInfo([
      first,
      new HostNode(first.record),
      container,
      new StatusNode('status'),
      second,
    ], first);
    expect(clipboardWrites).toHaveLength(1);
    expect(clipboardWrites[0]!.match(/SSH host:/g)).toHaveLength(2);
    expect(clipboardWrites[0]).toContain('SSH host: other');
    expect(clipboardWrites[0]).toContain('\n\n---\n\n');
    expect(commandCalls).toEqual([]);
  });

  it('copies only the clicked host when it is outside the current selection', async () => {
    await copyHostInfo([fixture('selected')], fixture('clicked'));
    expect(clipboardWrites[0]).toContain('SSH host: clicked');
    expect(clipboardWrites[0]).not.toContain('SSH host: selected');
  });

  it('does not overwrite the clipboard without a host selection', async () => {
    await copyHostInfo([]);
    await copyHostInfo([new StatusNode('status')]);
    expect(clipboardWrites).toEqual([]);
    expect(informationMessages).toEqual([
      'Select one or more hosts first.',
      'Select one or more hosts first.',
    ]);
  });

  it('reports clipboard failures', async () => {
    clipboardFailures.push(new Error('unavailable'));
    await copyHostInfo([], fixture());
    expect(errorMessages).toEqual(['Unable to copy host information: unavailable']);
    expect(clipboardWrites).toEqual([]);
  });
});
