import { beforeEach, describe, expect, it, vi } from 'vitest';

import { containerWorkspaceFolder, isValidWorkspaceFileName } from '../../src/containers/metadata.js';
import { attachedContainerAuthority, openDevContainer, openSshWindow } from '../../src/ui/containerActions.js';
import { ContainerNode, HostNode } from '../../src/ui/nodes.js';
import { NpuTreeProvider } from '../../src/ui/treeProvider.js';
import type { DevContainer, HostRecord } from '../../src/types.js';
import {
  availableCommands, commandCalls, commandFailures, configurationValues, errorMessages, resetVscodeMock,
} from '../mocks/vscode.js';

function fixture(): { record: HostRecord; container: DevContainer; node: ContainerNode } {
  const container: DevContainer = {
    id: 'a'.repeat(64), isDevContainer: true, name: 'random_name', displayName: 'vllm-ascend-dev', image: 'dev', state: 'running',
    createdAt: 'now', workspaceFolder: '/home/user/project', containerWorkspaceFolder: '/workspaces/project',
  };
  const record: HostRecord = {
    host: { alias: 'NPU(A3)+中文', hostname: 'example.test', identityFiles: [], configPath: '/config', useAlias: true },
    state: 'idle', subscribed: false, refreshing: false, idleStreak: 0, idleNotified: false, stale: false,
    devContainers: { state: 'ready', stale: false, refreshing: false,
      snapshot: { containers: [container], collectedAt: Date.now(), durationMs: 1 } },
  };
  return { record, container, node: new ContainerNode(record, container) };
}

describe('container workspace mapping', () => {
  it('uses the most specific source mount and maps workspace subfolders', () => {
    expect(containerWorkspaceFolder('/home/user/project/sub dir', [
      { type: 'bind', source: '/home', destination: '/all-home' },
      { type: 'bind', source: '/home/user/project', destination: '/workspaces/project' },
    ])).toBe('/workspaces/project/sub dir');
    expect(containerWorkspaceFolder('/home/project2', [{ type: 'bind', source: '/home/project', destination: '/wrong' }])).toBeUndefined();
    expect(containerWorkspaceFolder('/project', [{ type: 'bind', source: '/', destination: '/host' }])).toBe('/host/project');
  });
  it('does not guess container paths from absent or invalid mount information', () => {
    expect(containerWorkspaceFolder('/host/project', undefined)).toBeUndefined();
    expect(containerWorkspaceFolder(undefined, [])).toBeUndefined();
    expect(containerWorkspaceFolder('C:\\project', [])).toBeUndefined();
    expect(containerWorkspaceFolder('/project', [null, { type: 'bind', source: '/project', destination: 42 }])).toBeUndefined();
    expect(containerWorkspaceFolder('/project', [{ type: 'volume', source: '/project', destination: '/volume' }])).toBeUndefined();
  });

  it.each([
    ['', true], ['vllm-ascend-dev.code-workspace', true], ['开发 "quoted".code-workspace', true],
    ['/absolute.code-workspace', false], ['nested/project.code-workspace', false],
    ['nested\\project.code-workspace', false], ['project.json', false], ['bad\0.code-workspace', false],
  ])('validates a root-level workspace file name without expansion: %s', (value, valid) => {
    expect(isValidWorkspaceFileName(value)).toBe(valid);
  });
});

describe('open Dev Container in a new window', () => {
  beforeEach(resetVscodeMock);

  it('encodes the exact container ID and preserves the SSH alias for Windows/WSL routing', () => {
    const alias = 'NPU(A3)+中文 Space@host';
    const authority = attachedContainerAuthority(alias, 'a'.repeat(64));
    const [attached, parent] = authority.split('@');
    expect(JSON.parse(Buffer.from(attached!.slice('attached-container+'.length), 'hex').toString('utf8')))
      .toEqual({ containerId: 'a'.repeat(64) });
    expect(JSON.parse(Buffer.from(parent!.slice('ssh-remote+'.length), 'hex').toString('utf8')))
      .toEqual({ hostName: alias });
    expect(() => attachedContainerAuthority(alias, 'short-id')).toThrow();
  });

  it('refreshes state and opens the mapped folder in a new window without replacing the local window', async () => {
    const { record, node } = fixture();
    const refresh = vi.fn().mockResolvedValue(record);
    await openDevContainer(node, refresh);
    expect(refresh).toHaveBeenCalledWith(record.host.alias);
    expect(commandCalls).toEqual([{ command: 'vscode.openFolder', args: [{
      scheme: 'vscode-remote', authority: attachedContainerAuthority(record.host.alias, node.container.id),
      path: '/workspaces/project',
    }, { forceNewWindow: true }] }]);
    expect(errorMessages).toEqual([]);
  });

  it('opens the configured workspace file from the mapped container workspace', async () => {
    const { record, container, node } = fixture();
    container.containerWorkspaceFile = '/workspaces/project/vllm-ascend-dev.code-workspace';
    configurationValues.set('npuMonitor.containers.workspaceFile', '  vllm-ascend-dev.code-workspace  ');
    await openDevContainer(node, async () => record);
    expect(commandCalls).toEqual([{ command: 'vscode.openFolder', args: [{
      scheme: 'vscode-remote', authority: attachedContainerAuthority(record.host.alias, container.id),
      path: container.containerWorkspaceFile,
    }, { forceNewWindow: true }] }]);
    expect(errorMessages).toEqual([]);
  });

  it('reports a missing or invalid configured workspace file without opening a fallback folder', async () => {
    for (const workspaceFile of ['missing.code-workspace', '/absolute.code-workspace',
      'nested/project.code-workspace', 'project.json']) {
      resetVscodeMock();
      const { record, node } = fixture();
      configurationValues.set('npuMonitor.containers.workspaceFile', workspaceFile);
      await openDevContainer(node, async () => record);
      expect(commandCalls).toEqual([]);
      expect(errorMessages).toHaveLength(1);
      expect(errorMessages[0]).toContain(workspaceFile);
    }
  });

  it('uses an attached empty window when the container workspace path cannot be resolved', async () => {
    const { record, container, node } = fixture();
    container.containerWorkspaceFolder = undefined;
    configurationValues.set('npuMonitor.containers.workspaceFile', 'vllm-ascend-dev.code-workspace');
    await openDevContainer(node, async () => record);
    expect(commandCalls).toEqual([{ command: 'vscode.newWindow', args: [{
      remoteAuthority: attachedContainerAuthority(record.host.alias, container.id), reuseWindow: false,
    }] }]);
  });

  it('attaches an ordinary running container by full ID without a workspace', async () => {
    const { record, container, node } = fixture();
    container.isDevContainer = false;
    container.workspaceFolder = undefined;
    container.containerWorkspaceFolder = undefined;
    configurationValues.set('npuMonitor.containers.workspaceFile', 'vllm-ascend-dev.code-workspace');
    await openDevContainer(node, async () => record);
    expect(commandCalls).toEqual([{ command: 'vscode.newWindow', args: [{
      remoteAuthority: attachedContainerAuthority(record.host.alias, container.id), reuseWindow: false,
    }] }]);
  });

  it.each(['stopped', 'missing', 'stale', 'failed', 'hostMissing'])('does not attach or start a container when refreshed state is %s', async scenario => {
    const { record, container, node } = fixture();
    if (scenario === 'stopped') container.state = 'exited';
    if (scenario === 'missing') record.devContainers!.snapshot!.containers = [];
    if (scenario === 'stale') record.devContainers!.stale = true;
    if (scenario === 'failed') record.devContainers!.state = 'timeout';
    await openDevContainer(node, async () => scenario === 'hostMissing' ? undefined : record);
    expect(commandCalls).toEqual([]);
    expect(errorMessages).toHaveLength(1);
  });

  it.each(['remote-containers.attachToRunningContainer', 'opensshremotes.openEmptyWindow', 'both'])(
    'opens before %s is registered, allowing VS Code to activate its remote resolvers', async missing => {
      const { record, node } = fixture();
      availableCommands.splice(0, availableCommands.length,
        ...availableCommands.filter(command => missing !== 'both' && command !== missing));
      const refresh = vi.fn().mockResolvedValue(record);
      await openDevContainer(node, refresh);
      expect(refresh).toHaveBeenCalledWith(record.host.alias);
      expect(commandCalls[0]?.command).toBe('vscode.openFolder');
      expect(commandCalls).toHaveLength(1);
      expect(errorMessages).toEqual([]);
    },
  );

  it('preserves actual open-window errors', async () => {
    const { record, node } = fixture();
    commandFailures.set('vscode.openFolder', new Error('open failed'));
    await openDevContainer(node, async () => record);
    expect(errorMessages[0]).toContain('open failed');
  });

  it('provides an SSH window fallback on both host and container rows without requiring Dev Containers', async () => {
    const { record, node } = fixture();
    availableCommands.splice(0, 1);
    await openSshWindow(node);
    await openSshWindow(new HostNode(record));
    expect(commandCalls).toEqual(Array.from({ length: 2 }, () => ({
      command: 'opensshremotes.openEmptyWindow', args: [{ host: record.host.alias }],
    })));
    expect(errorMessages).toEqual([]);
    commandFailures.set('opensshremotes.openEmptyWindow', new Error('ssh failed'));
    await openSshWindow(node);
    expect(errorMessages[0]).toContain('ssh failed');
  });

  it('invokes the SSH fallback even before Remote - SSH registers its command', async () => {
    availableCommands.length = 0;
    const { record, node } = fixture();
    await openSshWindow(node);
    expect(commandCalls).toEqual([{
      command: 'opensshremotes.openEmptyWindow', args: [{ host: record.host.alias }],
    }]);
    expect(errorMessages).toEqual([]);
  });

  it('only exposes the open button for running containers with a successful fresh snapshot', () => {
    const { record, container, node } = fixture();
    const provider = new NpuTreeProvider({ onDidChange: () => ({ dispose() {} }) } as never);
    expect(provider.getTreeItem(node).contextValue).toBe('npuDevContainerRunning');
    container.state = 'exited';
    expect(provider.getTreeItem(node).contextValue).toBe('npuDevContainer');
    container.state = 'running';
    record.devContainers!.stale = true;
    expect(provider.getTreeItem(node).contextValue).toBe('npuDevContainer');
    provider.dispose();
  });
});
