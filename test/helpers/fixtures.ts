import type * as vscode from 'vscode';
import { vi } from 'vitest';

import type { HostRecord, MonitorSettings, NpuDevice, SshHost } from '../../src/types.js';

export function makeSettings(overrides: Partial<MonitorSettings> = {}): MonitorSettings {
  return {
    sshConfigPath: '', remoteSshConfigFile: '', knownHostsPath: '', sshExecutablePath: '',
    connectTimeoutSeconds: 8, exporterProbeTimeoutSeconds: 2, npuSmiTimeoutSeconds: 10,
    maxConcurrentHosts: 8, excludedHosts: [], pollIntervalSeconds: 180,
    autoRefreshAllHosts: true, idleHistoryRetentionDays: 7, idleScope: 'anyCard',
    idleRequireNoProcesses: true, idleUtilizationThresholdPercent: 1, idleConsecutiveChecks: 1,
    devContainersEnabled: true, devContainersTimeoutSeconds: 5,
    containerFilterMode: 'devContainers', containerWorkspacePaths: [], containerWorkspaceFile: '',
    ...overrides,
  };
}

export function makeHost(overrides: Partial<SshHost> = {}): SshHost {
  return {
    alias: 'alpha', hostname: '10.0.0.1', user: 'root', port: 22,
    identityFiles: [], configPath: '/tmp/config', useAlias: false,
    ...overrides,
  };
}

export function makeRecord(overrides: Partial<HostRecord> = {}): HostRecord {
  return {
    host: makeHost(), state: 'unknown', refreshing: false, subscribed: false,
    idleStreak: 0, idleNotified: false, stale: false,
    ...overrides,
  };
}

export function makeDevice(overrides: Partial<NpuDevice> = {}): NpuDevice {
  return {
    id: '0', model: 'Ascend910', health: 'OK', utilizationPercent: 0,
    processCount: 0, processes: [],
    ...overrides,
  };
}

export function createMemento(initial: Record<string, unknown> = {}) {
  const values = new Map(Object.entries(structuredClone(initial)));
  function get<T>(key: string): T | undefined;
  function get<T>(key: string, defaultValue: T): T;
  function get<T>(key: string, defaultValue?: T): T | undefined {
    return (values.has(key) ? values.get(key) : defaultValue) as T | undefined;
  }
  return {
    get,
    keys: () => [...values.keys()],
    update: vi.fn(async (key: string, value: unknown) => {
      if (value === undefined) values.delete(key);
      else values.set(key, structuredClone(value));
    }),
  } satisfies vscode.Memento;
}
