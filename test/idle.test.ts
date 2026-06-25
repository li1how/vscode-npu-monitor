import { describe, expect, it } from 'vitest';

import { evaluateSnapshot, isDeviceIdle } from '../src/idle.js';
import type { HostSnapshot, MonitorSettings, NpuDevice } from '../src/types.js';

const settings: MonitorSettings = {
  sshConfigPath: '',
  remoteSshConfigFile: '',
  knownHostsPath: '',
  sshExecutablePath: '',
  connectTimeoutSeconds: 8,
  exporterProbeTimeoutSeconds: 2,
  npuSmiTimeoutSeconds: 10,
  maxConcurrentHosts: 6,
  excludedHosts: [],
  pollIntervalSeconds: 60,
  idleScope: 'allCards',
  idleRequireNoProcesses: true,
  idleUtilizationThresholdPercent: 1,
  idleConsecutiveChecks: 1,
};

function device(id: string, utilizationPercent: number, processCount: number): NpuDevice {
  return {
    id,
    health: 'OK',
    utilizationPercent,
    processCount,
    processes: [],
  };
}

function snapshot(devices: NpuDevice[], partial = false): HostSnapshot {
  return {
    source: 'npu-smi',
    devices,
    partial,
    collectedAt: 1,
    durationMs: 1,
  };
}

describe('idle policy', () => {
  it('requires low utilization and no processes by default', () => {
    expect(isDeviceIdle(device('0', 0, 0), settings)).toBe(true);
    expect(isDeviceIdle(device('0', 2, 0), settings)).toBe(false);
    expect(isDeviceIdle(device('0', 0, 1), settings)).toBe(false);
  });

  it('supports all-card and any-card scopes', () => {
    const devices = [device('0', 0, 0), device('1', 50, 1)];
    expect(evaluateSnapshot(snapshot(devices), settings).state).toBe('busy');
    expect(evaluateSnapshot(snapshot(devices), {
      ...settings,
      idleScope: 'anyCard',
    }).state).toBe('idle');
  });

  it('never treats partial or unhealthy data as idle', () => {
    expect(evaluateSnapshot(snapshot([device('0', 0, 0)], true), settings).state)
      .toBe('partial');
    expect(evaluateSnapshot(snapshot([{
      ...device('0', 0, 0),
      health: 'ERROR',
    }]), settings).state).toBe('unhealthy');
  });
});
