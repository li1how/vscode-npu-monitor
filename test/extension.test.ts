import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { openSshTerminal } from '../src/extension.js';
import { currentSshEnvironment, detectSshExecutablePath } from '../src/ssh/config.js';
import type { HostRecord } from '../src/types.js';
import { HostNode } from '../src/ui/nodes.js';
import {
  configurationValues,
  createdTerminals,
  errorMessages,
  executedCommands,
  resetVscodeMock,
  terminalFailures,
} from './mocks/vscode.js';
import { env as mockEnv } from './mocks/vscode.js';

function hostNode(alias = 'alpha'): HostNode {
  const record: HostRecord = {
    host: {
      alias,
      hostname: '10.0.0.1',
      identityFiles: [],
      configPath: '/tmp/config',
      knownHostsPath: '/tmp/known_hosts',
      useAlias: true,
    },
    state: 'unknown',
    refreshing: false,
    subscribed: false,
    idleStreak: 0,
    idleNotified: false,
    stale: false,
  };
  return new HostNode(record);
}

describe('view action placement', () => {
  it('shows history beside subscriptions and makes host selection a title action', () => {
    const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as {
      contributes: { menus: Record<string, Array<{ command: string; group: string }>> };
    };
    const title = manifest.contributes.menus['view/title']!;
    const host = manifest.contributes.menus['view/item/context']!;
    const group = (items: typeof title, command: string) =>
      items.find(item => item.command === command)?.group;
    expect(group(title, 'npuMonitor.scanAll')).toBe('navigation@1');
    expect(group(title, 'npuMonitor.findHost')).toBe('navigation@2');
    expect(group(title, 'npuMonitor.filterHosts')).toBe('navigation@3');
    expect(group(title, 'npuMonitor.clearHostFilter')).toBe('navigation@4');
    expect(group(title, 'npuMonitor.chooseIdleHost')).toBeUndefined();
    expect(group(host, 'npuMonitor.favoriteHost')).not.toMatch(/^inline/);
    expect(group(host, 'npuMonitor.editHostNote')).not.toMatch(/^inline/);
    expect(group(title, 'npuMonitor.reloadConfig')).toBe('2_actions@3');
    expect(group(title, 'npuMonitor.selectSshConfig')).toBe('2_actions@2');
    expect(group(title, 'npuMonitor.openSettings')).not.toMatch(/^navigation/);
    expect(group(host, 'npuMonitor.subscribeHost')).toBe('inline@2');
    expect(group(host, 'npuMonitor.showIdleHistory')).toBe('inline@3');
    expect(group(host, 'npuMonitor.scanHost')).toBe('inline@1');
    expect(group(host, 'npuMonitor.unsubscribeHost')).toBe('inline@2');
    expect(group(host, 'npuMonitor.openSshTerminal')).toBe('2_open@2');
    expect(group(host, 'npuMonitor.openSshWindow')).toBe('2_open@1');
  });

  it('localizes browser commands and preserves subscription menus for favorite hosts', () => {
    const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as {
      contributes: {
        commands: Array<{ command: string; title: string }>;
        menus: Record<string, Array<{ command: string; when: string }>>;
      };
    };
    const english = JSON.parse(readFileSync('package.nls.json', 'utf8')) as Record<string, string>;
    const chinese = JSON.parse(readFileSync('package.nls.zh-cn.json', 'utf8')) as Record<string, string>;
    expect(manifest.contributes.commands.some(item => item.command === 'npuMonitor.chooseIdleHost')).toBe(false);
    for (const name of ['findHost', 'filterHosts', 'clearHostFilter', 'favoriteHost', 'unfavoriteHost', 'editHostNote']) {
      const command = manifest.contributes.commands.find(item => item.command === 'npuMonitor.' + name)!;
      const key = command.title.slice(1, -1);
      expect(english[key]).toBeTruthy();
      expect(chinese[key]).toBeTruthy();
    }
    const context = manifest.contributes.menus['view/item/context']!;
    for (const [command, contextValue] of [
      ['subscribeHost', 'npuHostUnsubscribedFavorite'], ['unsubscribeHost', 'npuHostSubscribedFavorite'],
    ]) {
      const when = context.find(item => item.command === 'npuMonitor.' + command)!.when;
      const expression = when.match(/viewItem =~ \/(.+)\//)![1]!;
      expect(new RegExp(expression).test(contextValue!)).toBe(true);
    }
    expect(manifest.contributes.menus['view/title']!
      .find(item => item.command === 'npuMonitor.clearHostFilter')!.when).toContain('npuMonitor.hostFilterActive');
  });
});

describe('extension commands', () => {
  it('opens an SSH terminal for a host without starting a Remote - SSH connection', () => {
    resetVscodeMock();
    openSshTerminal(hostNode());
    const environment = currentSshEnvironment(mockEnv.remoteName);
    const expectedSshPath = detectSshExecutablePath('', environment);
    expect(executedCommands).toEqual([]);
    expect(executedCommands).not.toContain('vscode.openFolder');
    expect(createdTerminals).toHaveLength(1);
    expect(createdTerminals[0]?.shown).toBe(true);
    expect(createdTerminals[0]?.options).toMatchObject({
      name: 'NPU SSH: alpha',
      shellPath: expectedSshPath,
      shellArgs: [
        '-F',
        '/tmp/config',
        '-o',
        'BatchMode=no',
        '-o',
        'StrictHostKeyChecking=yes',
        '-o',
        'UpdateHostKeys=no',
        '-o',
        'ConnectionAttempts=1',
        '-o',
        'ConnectTimeout=8',
        '-o',
        'UserKnownHostsFile=/tmp/known_hosts',
        'alpha',
      ],
    });
  });

  it('uses the configured SSH executable when opening a terminal', () => {
    resetVscodeMock();
    configurationValues.set('npuMonitor.sshExecutablePath', '/custom/ssh');
    openSshTerminal(hostNode());
    expect(createdTerminals[0]?.options).toMatchObject({
      shellPath: '/custom/ssh',
    });
  });

  it('shows an error when the SSH terminal cannot be opened', () => {
    resetVscodeMock();
    terminalFailures.push(new Error('terminal blocked'));
    openSshTerminal(hostNode('beta'));
    expect(errorMessages).toEqual([
      'Unable to open SSH terminal for beta: terminal blocked',
    ]);
  });
});
