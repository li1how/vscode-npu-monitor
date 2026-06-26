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

  it('ignores process count when idleRequireNoProcesses is false', () => {
    const noProcessReq = { ...settings, idleRequireNoProcesses: false };
    expect(isDeviceIdle(device('0', 0, 99), noProcessReq)).toBe(true);
    expect(isDeviceIdle(device('0', 2, 99), noProcessReq)).toBe(false);
  });

  it('returns false for a device with undefined utilizationPercent', () => {
    const dev: NpuDevice = {
      id: '0',
      health: 'OK',
      utilizationPercent: undefined,
      processCount: 0,
      processes: [],
    };
    expect(isDeviceIdle(dev, settings)).toBe(false);
  });

  it('treats utilization exactly at the threshold as idle', () => {
    const atThreshold = { ...settings, idleUtilizationThresholdPercent: 5 };
    expect(isDeviceIdle(device('0', 5, 0), atThreshold)).toBe(true);
    expect(isDeviceIdle(device('0', 6, 0), atThreshold)).toBe(false);
  });

  it('treats an empty device list as partial', () => {
    expect(evaluateSnapshot(snapshot([]), settings).state).toBe('partial');
  });

  it('reports idle with idleDevices count when all cards are idle', () => {
    const devices = [device('0', 0, 0), device('1', 0, 0)];
    const result = evaluateSnapshot(snapshot(devices), settings);
    expect(result.state).toBe('idle');
    expect(result.idleDevices).toBe(2);
  });

  it('counts idle devices even when overall scope reports busy', () => {
    const devices = [device('0', 0, 0), device('1', 50, 1)];
    const result = evaluateSnapshot(snapshot(devices), settings);
    expect(result.state).toBe('busy');
    expect(result.idleDevices).toBe(1);
  });
});
