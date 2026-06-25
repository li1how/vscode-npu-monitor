import { describe, expect, it } from 'vitest';

import { openSshTerminal } from '../src/extension.js';
import { currentSshEnvironment, detectSshExecutablePath } from '../src/sshConfig.js';
import type { HostRecord } from '../src/types.js';
import { HostNode } from '../src/treeProvider.js';
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
