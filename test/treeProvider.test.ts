import { describe, expect, it } from 'vitest';

import { DeviceNode, HostNode, NpuTreeProvider } from '../src/treeProvider.js';
import type { HostRecord, NpuDevice } from '../src/types.js';
import { resetVscodeMock } from './mocks/vscode.js';

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
  onDidChange: (listener: () => void) => { dispose: () => void };
} {
  return {
    getRecords: () => records,
    onDidChange: () => ({ dispose: () => { /* noop */ } }),
  };
}

describe('NpuTreeProvider', () => {
  it('returns HostNode items for all records at the root level', () => {
    resetVscodeMock();
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
    resetVscodeMock();
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
    resetVscodeMock();
    const record = makeRecord();
    const provider = new NpuTreeProvider(makeService([record]) as never);
    const hostNode = new HostNode(record);
    const children = provider.getChildren(hostNode);
    expect(children).toHaveLength(0);
    provider.dispose();
  });

  it('returns no children for a DeviceNode (leaf node)', () => {
    resetVscodeMock();
    const record = makeRecord();
    const provider = new NpuTreeProvider(makeService([record]) as never);
    const deviceNode = new DeviceNode(record, makeDevice());
    expect(provider.getChildren(deviceNode)).toHaveLength(0);
    provider.dispose();
  });

  it('produces correct context value for subscribed vs unsubscribed host items', () => {
    resetVscodeMock();
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
    resetVscodeMock();
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
    resetVscodeMock();
    const record = makeRecord({ refreshing: true });
    const provider = new NpuTreeProvider(makeService([record]) as never);
    const item = provider.getTreeItem(new HostNode(record));
    expect(item.description as string).toContain('Refreshing');
    provider.dispose();
  });

  it('produces device tree items with utilization and memory in description', () => {
    resetVscodeMock();
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
    resetVscodeMock();
    const record = makeRecord();
    const provider = new NpuTreeProvider(makeService([record]) as never);
    const item = provider.getTreeItem(new DeviceNode(record, makeDevice()));
    expect(item.contextValue).toBe('npuDevice');
    provider.dispose();
  });
});
