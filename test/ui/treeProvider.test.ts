import { beforeEach, describe, expect, it } from 'vitest';

import { ContainerNode, DeviceNode, HostNode } from '../../src/ui/nodes.js';
import { NpuTreeProvider } from '../../src/ui/treeProvider.js';
import type { DevContainer, HostRecord, NpuDevice } from '../../src/types.js';
import { configurationValues, resetVscodeMock } from '../mocks/vscode.js';

function makeRecord(overrides: Partial<HostRecord> = {}): HostRecord {
  return {
    host: {
      alias: 'alpha',
      hostname: '10.0.0.1',
      user: 'root',
      port: 22,
      identityFiles: [],
      configPath: '/tmp/config',
      useAlias: false,
    },
    state: 'unknown',
    refreshing: false,
    subscribed: false,
    idleStreak: 0,
    idleNotified: false,
    stale: false,
    ...overrides,
  };
}

function makeDevice(overrides: Partial<NpuDevice> = {}): NpuDevice {
  return {
    id: '0',
    model: 'Ascend910',
    health: 'OK',
    utilizationPercent: 0,
    hbmUsedMb: 4096,
    hbmTotalMb: 65536,
    temperatureC: 30,
    processCount: 0,
    processes: [],
    ...overrides,
  };
}

function makeService(records: HostRecord[]): {
  getRecords: () => HostRecord[];
  getIdleHistory: (alias: string) => { alias: string; retentionDays: number; cards: [] };
  onDidChange: (listener: () => void) => { dispose: () => void };
} {
  return {
    getRecords: () => records,
    getIdleHistory: alias => ({ alias, retentionDays: 7, cards: [] }),
    onDidChange: () => ({ dispose: () => { /* noop */ } }),
  };
}

describe('NpuTreeProvider', () => {
  beforeEach(() => {
    resetVscodeMock();
    configurationValues.set('npuMonitor.devContainers.enabled', false);
  });
  it('returns HostNode items for all records at the root level', () => {

    const records = [makeRecord({ host: { ...makeRecord().host, alias: 'alpha' } }),
      makeRecord({ host: { ...makeRecord().host, alias: 'beta' } })];
    const provider = new NpuTreeProvider(makeService(records) as never);
    const children = provider.getChildren();
    expect(children).toHaveLength(2);
    expect(children[0]).toBeInstanceOf(HostNode);
    expect(children[1]).toBeInstanceOf(HostNode);
    provider.dispose();
  });

  it('returns DeviceNode items when expanding a HostNode with a snapshot', () => {

    const device = makeDevice();
    const record = makeRecord({
      state: 'idle',
      snapshot: {
        source: 'npu-smi',
        devices: [device],
        partial: false,
        collectedAt: Date.now(),
        durationMs: 1,
      },
    });
    const provider = new NpuTreeProvider(makeService([record]) as never);
    const hostNode = new HostNode(record);
    const children = provider.getChildren(hostNode);
    expect(children).toHaveLength(1);
    expect(children[0]).toBeInstanceOf(DeviceNode);
    provider.dispose();
  });

  it('returns no children when a HostNode has no snapshot', () => {

    const record = makeRecord();
    const provider = new NpuTreeProvider(makeService([record]) as never);
    const hostNode = new HostNode(record);
    const children = provider.getChildren(hostNode);
    expect(children).toHaveLength(0);
    provider.dispose();
  });

  it('provides root parents so the idle picker can reveal host nodes', () => {
    const record = makeRecord();
    const provider = new NpuTreeProvider(makeService([record]) as never);
    expect(provider.getParent(new HostNode(record))).toBeUndefined();
    expect(provider.getParent(new DeviceNode(record, makeDevice()))).toBeInstanceOf(HostNode);
    provider.dispose();
  });

  it('returns no children for a DeviceNode (leaf node)', () => {

    const record = makeRecord();
    const provider = new NpuTreeProvider(makeService([record]) as never);
    const deviceNode = new DeviceNode(record, makeDevice());
    expect(provider.getChildren(deviceNode)).toHaveLength(0);
    provider.dispose();
  });

  it('produces correct context value for subscribed vs unsubscribed host items', () => {

    const subscribedRecord = makeRecord({ subscribed: true });
    const unsubscribedRecord = makeRecord({ subscribed: false });
    const provider = new NpuTreeProvider(makeService([]) as never);
    const subscribedItem = provider.getTreeItem(new HostNode(subscribedRecord));
    const unsubscribedItem = provider.getTreeItem(new HostNode(unsubscribedRecord));
    expect(subscribedItem.contextValue).toBe('npuHostSubscribed');
    expect(unsubscribedItem.contextValue).toBe('npuHostUnsubscribed');
    provider.dispose();
  });

  it('includes device count and source in host description when snapshot is available', () => {

    const record = makeRecord({
      state: 'idle',
      snapshot: {
        source: 'npu-smi',
        devices: [makeDevice(), makeDevice({ id: '1' })],
        partial: false,
        collectedAt: Date.now(),
        durationMs: 1,
      },
    });
    const provider = new NpuTreeProvider(makeService([record]) as never);
    const item = provider.getTreeItem(new HostNode(record));
    expect(typeof item.description).toBe('string');
    expect(item.description as string).toContain('2 NPU');
    expect(item.description as string).toContain('npu-smi');
    provider.dispose();
  });

  it('shows refreshing text when record is refreshing', () => {

    const record = makeRecord({ refreshing: true });
    const provider = new NpuTreeProvider(makeService([record]) as never);
    const item = provider.getTreeItem(new HostNode(record));
    expect(item.description as string).toContain('Refreshing');
    provider.dispose();
  });

  it('produces device tree items with utilization and memory in description', () => {

    const record = makeRecord();
    const device = makeDevice({
      utilizationPercent: 75,
      hbmUsedMb: 16000,
      hbmTotalMb: 65536,
      processCount: 2,
    });
    const provider = new NpuTreeProvider(makeService([record]) as never);
    const item = provider.getTreeItem(new DeviceNode(record, device));
    expect(item.description as string).toContain('75%');
    expect(item.description as string).toContain('16000/65536 MB');
    expect(item.description as string).toContain('2 processes');
    provider.dispose();
  });

  it('sets npuDevice context value on device tree items', () => {

    const record = makeRecord();
    const provider = new NpuTreeProvider(makeService([record]) as never);
    const item = provider.getTreeItem(new DeviceNode(record, makeDevice()));
    expect(item.contextValue).toBe('npuDevice');
    provider.dispose();
  });
});

describe('Dev Container tree', () => {
  it('groups NPU and containers, including hosts without NPU data', () => {
    resetVscodeMock();
    const record = makeRecord();
    const provider = new NpuTreeProvider(makeService([record]) as never);
    const groups = provider.getChildren(new HostNode(record));
    expect(groups.map(x => provider.getTreeItem(x).label)).toEqual(['NPU', 'Dev Containers']);
    expect(provider.getChildren(groups[1]).map(x => provider.getTreeItem(x).label)).toEqual(['Not scanned']);
    provider.dispose();
  });

  it('shows container metadata, stale state and distinct identities across hosts', () => {
    resetVscodeMock();
    const container = { id: 'a'.repeat(64), isDevContainer: true, name: 'random_docker_name', displayName: 'vllm-ascend-dev', image: 'test:dev', state: 'running',
      createdAt: '2026-09-13', workspaceFolder: '/space dir/[link](command:bad)' };
    const record = makeRecord({ devContainers: { state: 'timeout', error: 'Timed out', stale: true,
      refreshing: false, snapshot: { containers: [container], collectedAt: Date.now(), durationMs: 1 } } });
    const second = { ...record, host: { ...record.host, alias: 'beta' } };
    const provider = new NpuTreeProvider(makeService([record, second]) as never);
    const groups = provider.getChildren(new HostNode(record));
    const children = provider.getChildren(groups[1]);
    expect(provider.getTreeItem(children[0]!).label).toBe('Timed out');
    const item = provider.getTreeItem(children[1]!);
    expect(item.label).toBe('vllm-ascend-dev');
    expect((item.tooltip as { value: string }).value).toContain('Docker name: random');
    expect(item.description).toBe('Running · Stale');
    expect(item.contextValue).toBe('npuDevContainer');
    expect((item.tooltip as { value: string }).value).toContain('test:dev');
    expect((item.tooltip as { value: string }).value).not.toContain('[link](command:bad)');
    const otherGroups = provider.getChildren(new HostNode(second));
    const otherItem = provider.getTreeItem(provider.getChildren(otherGroups[1])[1]!);
    expect(otherItem.id).not.toBe(item.id);
    expect(provider.getTreeItem(new HostNode(record)).description).toContain('1 Dev Containers');
    provider.dispose();
  });

  it('distinguishes an empty successful scan from a Docker error', () => {
    resetVscodeMock();
    const record = makeRecord({ devContainers: { state: 'ready', stale: false, refreshing: false,
      snapshot: { containers: [], collectedAt: Date.now(), durationMs: 1 } } });
    const provider = new NpuTreeProvider(makeService([record]) as never);
    const group = provider.getChildren(new HostNode(record))[1];
    expect(provider.getTreeItem(provider.getChildren(group)[0]!).label).toBe('No Dev Containers found');
    record.devContainers = { state: 'missingDocker', stale: false, refreshing: false };
    expect(provider.getTreeItem(provider.getChildren(group)[0]!).label).toBe('Docker is not installed');
    provider.dispose();
  });

  it('updates groups, counts and empty messages from the same snapshot across view modes', () => {
    resetVscodeMock();
    const dev = { id: 'a'.repeat(64), isDevContainer: true, name: 'random', image: 'image', state: 'exited',
      workspaceFolder: '/home/user/project', createdAt: 'now' };
    const ordinary = { ...dev, id: 'b'.repeat(64), isDevContainer: false, name: 'service' };
    const record = makeRecord({ devContainers: { state: 'ready', stale: false, refreshing: false,
      snapshot: { containers: [dev, ordinary], collectedAt: 0, durationMs: 1 } } });
    const provider = new NpuTreeProvider(makeService([record]) as never);
    const group = provider.getChildren(new HostNode(record))[1]!;
    const identity = provider.getTreeItem(new ContainerNode(record, dev)).id;
    expect(provider.getTreeItem(group).description).toBe('1');
    configurationValues.set('npuMonitor.containers.workspacePaths', ['/missing']);
    configurationValues.set('npuMonitor.containers.filterMode', 'all');
    expect(provider.getTreeItem(group).label).toBe('Containers');
    expect(provider.getTreeItem(group).description).toBe('2');
    expect(provider.getTreeItem(new HostNode(record)).description).toContain('2 Containers');
    expect(provider.getChildren(group).map(node => provider.getTreeItem(node).label)).toEqual(['project', 'service']);
    configurationValues.set('npuMonitor.containers.filterMode', 'workspacePaths');
    expect(provider.getTreeItem(group).description).toBe('0');
    expect(provider.getTreeItem(provider.getChildren(group)[0]!).label).toBe('No containers match the current filter');
    configurationValues.set('npuMonitor.containers.workspacePaths', ['/home/user', 'relative']);
    expect(provider.getTreeItem(group).description).toBe('1');
    expect(provider.getTreeItem(provider.getChildren(group)[0]!).label).toContain('Invalid workspace paths: 1');
    expect(provider.getTreeItem(new ContainerNode(record, dev)).id).toBe(identity);
    record.devContainers!.stale = true;
    record.devContainers!.state = 'timeout';
    expect(provider.getChildren(group).filter(node => node instanceof ContainerNode)).toHaveLength(1);
    expect(provider.getTreeItem(new HostNode(record)).description).toContain('1 Dev Containers · Stale');
    configurationValues.set('npuMonitor.containers.filterMode', 'all');
    record.devContainers = { state: 'ready', stale: false, refreshing: false,
      snapshot: { containers: [], collectedAt: 1, durationMs: 1 } };
    expect(provider.getTreeItem(provider.getChildren(group)[0]!).label).toBe('No containers found');
    provider.dispose();
  });
});

describe('visible container name disambiguation', () => {
  const first: DevContainer = {
    id: 'a'.repeat(64), isDevContainer: true, name: 'docker-a', displayName: 'project',
    image: 'dev', state: 'running', workspaceFolder: '/home/alice/project', createdAt: 'now',
  };
  const second: DevContainer = {
    ...first, id: 'b'.repeat(64), name: 'docker-b', state: 'exited', workspaceFolder: '/home/bob/project',
  };

  function recordFor(containers: DevContainer[], alias = 'alpha'): HostRecord {
    return makeRecord({
      host: { ...makeRecord().host, alias },
      devContainers: { state: 'ready', stale: false, refreshing: false,
        snapshot: { containers, collectedAt: 0, durationMs: 1 } },
    });
  }

  beforeEach(() => resetVscodeMock());

  it('adds short IDs only to duplicate visible names, including ordinary and stopped containers', () => {
    configurationValues.set('npuMonitor.containers.filterMode', 'all');
    const ordinary = { ...first, id: 'c'.repeat(64), isDevContainer: false, name: 'project' };
    const unique = { ...first, id: 'd'.repeat(64), displayName: 'other' };
    const record = recordFor([first, second, ordinary, unique]);
    const provider = new NpuTreeProvider(makeService([record]) as never);
    const group = provider.getChildren(new HostNode(record))[1]!;
    const items = provider.getChildren(group).map(node => provider.getTreeItem(node));
    expect(items.map(item => item.label)).toEqual(['project', 'project', 'project', 'other']);
    expect(items.map(item => item.description)).toEqual([
      'Running · ' + first.id.slice(0, 12), 'Exited · ' + second.id.slice(0, 12),
      'Running · ' + ordinary.id.slice(0, 12), 'Running',
    ]);
    expect(provider.getTreeItem(group).description).toBe('4');
    provider.dispose();
  });

  it('recalculates duplicate names when workspace filters change, preserving snapshot and IDs', () => {
    const record = recordFor([first, second]);
    const snapshot = record.devContainers!.snapshot;
    const provider = new NpuTreeProvider(makeService([record]) as never);
    const group = provider.getChildren(new HostNode(record))[1]!;
    const items = () => provider.getChildren(group).map(node => provider.getTreeItem(node));
    const initial = items();
    expect(initial[0]?.description).toBe('Running · ' + first.id.slice(0, 12));
    configurationValues.set('npuMonitor.containers.filterMode', 'workspacePaths');
    configurationValues.set('npuMonitor.containers.workspacePaths', ['/home/alice']);
    expect(items().map(item => item.description)).toEqual(['Running']);
    expect(items()[0]?.id).toBe(initial[0]?.id);
    expect(provider.getTreeItem(group).description).toBe('1');
    expect(provider.getTreeItem(new HostNode(record)).description).toContain('1 Dev Containers');
    configurationValues.set('npuMonitor.containers.filterMode', 'devContainers');
    expect(items().map(item => item.description)).toEqual(initial.map(item => item.description));
    expect(record.devContainers!.snapshot).toBe(snapshot);
    provider.dispose();
  });

  it('recalculates names after snapshot replacement, stale recovery and container removal', () => {
    const record = recordFor([first, second]);
    const provider = new NpuTreeProvider(makeService([record]) as never);
    const group = provider.getChildren(new HostNode(record))[1]!;
    const items = () => provider.getChildren(group).filter(node => node instanceof ContainerNode)
      .map(node => provider.getTreeItem(node));
    const initialIds = items().map(item => item.id);
    record.devContainers!.state = 'timeout';
    record.devContainers!.stale = true;
    expect(items()[0]?.description).toBe('Running · Stale · ' + first.id.slice(0, 12));
    record.devContainers = recordFor([first, { ...second, displayName: 'renamed' }]).devContainers;
    expect(items().map(item => item.description)).toEqual(['Running', 'Exited']);
    expect(items().map(item => item.label)).toEqual(['project', 'renamed']);
    expect(items().map(item => item.id)).toEqual(initialIds);
    record.devContainers = recordFor([first, second]).devContainers;
    expect(items()[0]?.description).toBe('Running · ' + first.id.slice(0, 12));
    record.devContainers = recordFor([first]).devContainers;
    expect(items().map(item => item.description)).toEqual(['Running']);
    expect(provider.getTreeItem(group).description).toBe('1');
    provider.dispose();
  });

  it('keeps duplicate-name detection local to each host even when IDs and names coincide', () => {
    const alpha = recordFor([first, second]);
    const beta = recordFor([first], 'beta');
    const provider = new NpuTreeProvider(makeService([alpha, beta]) as never);
    const firstItem = (record: HostRecord) => provider.getTreeItem(
      provider.getChildren(provider.getChildren(new HostNode(record))[1]!)[0]!,
    );
    expect(firstItem(alpha).description).toBe('Running · ' + first.id.slice(0, 12));
    expect(firstItem(beta).description).toBe('Running');
    expect(firstItem(alpha).id).toBe('container:alpha:' + first.id);
    expect(firstItem(beta).id).toBe('container:beta:' + first.id);
    provider.dispose();
  });
});
