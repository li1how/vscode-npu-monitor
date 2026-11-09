import { readFileSync } from 'node:fs';

import type * as vscode from 'vscode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { activate } from '../src/extension.js';
import type { MonitorService } from '../src/monitorService.js';
import { openSshTerminal } from '../src/ui/hostCommands.js';
import { currentSshEnvironment, detectSshExecutablePath } from '../src/ssh/config.js';
import type { HostRecord } from '../src/types.js';
import { HostNode } from '../src/ui/nodes.js';
import { createMemento, makeDevice, makeHost, makeRecord } from './helpers/fixtures.js';
import {
  cancelProgress,
  commands,
  configurationValues,
  createdTerminals,
  errorMessages,
  executedCommands,
  EventEmitter,
  fireConfigurationChange,
  informationMessages,
  outputChannels,
  progressReports,
  progressToken,
  registeredCommands,
  resetVscodeMock,
  terminalFailures,
  treeViews,
} from './mocks/vscode.js';
import { env as mockEnv } from './mocks/vscode.js';

const activation = vi.hoisted(() => ({
  service: undefined as ReturnType<typeof createActivationService> | undefined,
  mcp: undefined as ReturnType<typeof createActivationMcp> | undefined,
}));
vi.mock('../src/monitorService.js', () => ({ MonitorService: vi.fn(function () { return activation.service; }) }));
vi.mock('../src/mcp/controller.js', () => ({ McpController: vi.fn(function () { return activation.mcp; }) }));

function hostNode(alias = 'alpha'): HostNode {
  return new HostNode(makeRecord({ host: makeHost({ alias, user: undefined, port: undefined,
    knownHostsPath: '/tmp/known_hosts', useAlias: true }) }));
}

function createActivationService(records: HostRecord[] = []) {
  const changes = new EventEmitter<void>();
  return {
    changes, onDidChange: changes.event,
    getRecords: () => records,
    getRecord: (alias: string) => records.find(record => record.host.alias === alias),
    getIdleHistory: (alias: string) => ({ alias, retentionDays: 7, cards: [] }),
    initialize: vi.fn(async () => {}),
    reloadConfig: vi.fn(async () => {}),
    restartTimer: vi.fn(),
    scanAll: vi.fn<MonitorService['scanAll']>().mockResolvedValue(),
    scanAliases: vi.fn<MonitorService['scanAliases']>().mockResolvedValue(),
    subscribe: vi.fn(async () => {}), unsubscribe: vi.fn(async () => {}),
    dispose: vi.fn(() => changes.dispose()),
  };
}

function createActivationMcp() {
  const changes = new EventEmitter<void>();
  return {
    state: 'Disabled', tooltip: '', changes, onDidChange: changes.event,
    configure: vi.fn(async () => {}), showMenu: vi.fn(async () => {}),
    dispose: vi.fn(() => changes.dispose()),
  };
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

describe('activation wiring', () => {
  let context: vscode.ExtensionContext;
  let service: ReturnType<typeof createActivationService>;
  let mcp: ReturnType<typeof createActivationMcp>;

  beforeEach(() => {
    resetVscodeMock();
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 10, 9));
    service = createActivationService([makeRecord({ subscribed: true,
      snapshot: { source: 'npu-smi', partial: false, devices: [makeDevice()],
        collectedAt: Date.now(), durationMs: 1 } })]);
    mcp = createActivationMcp();
    activation.service = service;
    activation.mcp = mcp;
    context = { subscriptions: [], globalState: createMemento() } as unknown as vscode.ExtensionContext;
  });

  afterEach(() => {
    context.subscriptions.splice(0).reverse().forEach(disposable => disposable.dispose());
    vi.useRealTimers();
    resetVscodeMock();
  });

  it('registers manifest commands and updates the real tree and badge from service events', async () => {
    await activate(context);
    const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as {
      contributes: { commands: Array<{ command: string }> };
    };
    expect([...registeredCommands.keys()].sort()).toEqual(manifest.contributes.commands.map(item => item.command).sort());
    expect(service.initialize).toHaveBeenCalledOnce();
    expect(mcp.configure).toHaveBeenCalledOnce();
    const tree = treeViews[0]!;
    expect(tree.badge?.value).toBe(1);
    expect(tree.message).toBe('All hosts · 1 / 1 hosts');
    const changed = vi.fn();
    const listener = tree.provider.onDidChangeTreeData?.(changed);
    service.getRecords()[0]!.subscribed = false;
    service.changes.fire();
    expect(tree.badge).toBeUndefined();
    expect(changed).toHaveBeenCalled();
    changed.mockClear();
    mcp.changes.fire();
    expect(changed).toHaveBeenCalledOnce();
    listener?.dispose();
  });

  it('finishes activation while the initial scan runs and logs an initial scan failure', async () => {
    let rejectInitial!: (error: Error) => void;
    service.initialize.mockReturnValue(new Promise<void>((_resolve, reject) => { rejectInitial = reject; }));
    await activate(context);
    expect(mcp.configure).toHaveBeenCalledOnce();
    rejectInitial(new Error('collection unavailable'));
    await Promise.resolve();
    expect(outputChannels[0]?.lines).toEqual(['Initial scan failed: Error: collection unavailable']);
  });

  it('routes selected and context hosts through progress with the cancellation token', async () => {
    await activate(context);
    const alpha = hostNode('alpha');
    const beta = hostNode('beta');
    treeViews[0]!.selection = [alpha, beta];
    service.scanAliases.mockImplementationOnce(async (aliases, token, report) => {
      expect(aliases).toEqual(['alpha', 'beta']);
      expect(token).toBe(progressToken);
      report?.({ alias: 'alpha', completed: 1, total: 2 });
      cancelProgress();
      expect(token?.isCancellationRequested).toBe(true);
      report?.({ alias: 'beta', completed: 2, total: 2 });
    });
    await commands.executeCommand('npuMonitor.scanSelected', alpha);
    expect(progressReports).toEqual([
      { increment: 50, message: 'alpha (1/2)' }, { increment: 50, message: 'beta (2/2)' },
    ]);
    await commands.executeCommand('npuMonitor.scanHost', hostNode('outside'));
    expect(service.scanAliases).toHaveBeenLastCalledWith(['outside'], progressToken, expect.any(Function));
    treeViews[0]!.selection = [];
    await commands.executeCommand('npuMonitor.scanHost');
    expect(informationMessages).toEqual([]);
    await commands.executeCommand('npuMonitor.scanSelected');
    expect(informationMessages).toEqual(['Select one or more hosts first.']);
  });

  it('routes configuration events and disposes commands, timers and listeners', async () => {
    await activate(context);
    await fireConfigurationChange('editor.fontSize');
    expect(service.reloadConfig).not.toHaveBeenCalled();
    await fireConfigurationChange('remote.SSH.configFile');
    expect(service.reloadConfig).toHaveBeenCalledWith(false);
    expect(service.restartTimer).toHaveBeenCalledOnce();
    await fireConfigurationChange('npuMonitor.mcp.port');
    expect(mcp.configure).toHaveBeenCalledTimes(2);
    expect(service.reloadConfig).toHaveBeenCalledTimes(2);
    expect(service.restartTimer).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);
    context.subscriptions.splice(0).reverse().forEach(disposable => disposable.dispose());
    expect(registeredCommands.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(service.dispose).toHaveBeenCalledOnce();
    expect(mcp.dispose).toHaveBeenCalledOnce();
    expect(treeViews[0]?.disposed).toBe(true);
    expect(outputChannels[0]?.disposed).toBe(true);
    await fireConfigurationChange('npuMonitor.pollIntervalSeconds');
    expect(service.reloadConfig).toHaveBeenCalledTimes(2);
  });
});
