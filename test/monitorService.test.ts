import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type * as vscode from 'vscode';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MonitorSettings, ScanResult, SshHost } from '../src/types.js';
import {
  informationMessages,
  resetVscodeMock,
} from './mocks/vscode.js';

type ScanHandler = (
  host: SshHost,
  token?: vscode.CancellationToken,
) => Promise<ScanResult>;

const settingsState = vi.hoisted(() => ({
  value: undefined as MonitorSettings | undefined,
}));
const collectorState = vi.hoisted(() => ({
  aliases: [] as string[],
  handler: undefined as ScanHandler | undefined,
}));

vi.mock('../src/settings.js', () => ({
  getSettings: (): MonitorSettings => {
    if (!settingsState.value) {
      throw new Error('Test settings were not initialized.');
    }
    return settingsState.value;
  },
}));

vi.mock('../src/collector.js', () => ({
  NpuCollector: class {
    public async scan(
      host: SshHost,
      token?: vscode.CancellationToken,
    ): Promise<ScanResult> {
      collectorState.aliases.push(host.alias);
      if (!collectorState.handler) {
        throw new Error('Test collector was not initialized.');
      }
      return collectorState.handler(host, token);
    }
  },
}));

import { MonitorService } from '../src/monitorService.js';

function snapshot(utilizationPercent: number, processCount: number): ScanResult {
  return {
    state: 'unknown',
    snapshot: {
      source: 'npu-smi',
      devices: [{
        id: '0',
        health: 'OK',
        utilizationPercent,
        processCount,
        processes: [],
      }],
      partial: false,
      collectedAt: Date.now(),
      durationMs: 1,
    },
  };
}

function createContext(subscriptions: string[] = []): vscode.ExtensionContext {
  const values = new Map<string, unknown>([['npuMonitor.subscriptions', subscriptions]]);
  return {
    workspaceState: {
      get<T>(key: string, defaultValue?: T): T | undefined {
        return (values.has(key) ? values.get(key) : defaultValue) as T | undefined;
      },
      async update(key: string, value: unknown): Promise<void> {
        values.set(key, value);
      },
    },
  } as unknown as vscode.ExtensionContext;
}

function createService(subscriptions: string[] = []): MonitorService {
  const output = { appendLine: vi.fn() } as unknown as vscode.OutputChannel;
  return new MonitorService(createContext(subscriptions), output);
}

describe('monitor scan orchestration', () => {
  beforeEach(() => {
    resetVscodeMock();
    collectorState.aliases.length = 0;
    collectorState.handler = async () => snapshot(20, 1);
    const directory = mkdtempSync(path.join(os.tmpdir(), 'npu-monitor-service-'));
    const configPath = path.join(directory, 'config');
    writeFileSync(configPath, [
      'Host alpha beta gamma',
      '  User root',
      '  Port 22',
      '',
    ].join('\n'));
    settingsState.value = {
      sshConfigPath: configPath,
      remoteSshConfigFile: '',
      knownHostsPath: '',
      sshExecutablePath: '/usr/bin/ssh',
      connectTimeoutSeconds: 8,
      exporterProbeTimeoutSeconds: 2,
      npuSmiTimeoutSeconds: 10,
      maxConcurrentHosts: 2,
      excludedHosts: [],
      pollIntervalSeconds: 3600,
      idleScope: 'allCards',
      idleRequireNoProcesses: true,
      idleUtilizationThresholdPercent: 1,
      idleConsecutiveChecks: 1,
    };
  });

  it('restores and automatically scans only subscribed hosts', async () => {
    const service = createService(['alpha']);
    await service.initialize();
    expect(collectorState.aliases).toEqual(['alpha']);

    collectorState.aliases.length = 0;
    await service.subscribe('beta');
    expect(collectorState.aliases).toEqual(['beta']);

    collectorState.aliases.length = 0;
    await (service as unknown as { runAutomaticScan: () => Promise<void> })
      .runAutomaticScan();
    expect(collectorState.aliases.sort()).toEqual(['alpha', 'beta']);
    service.dispose();
  });

  it('scans all, one, or multiple hosts without changing subscriptions', async () => {
    const service = createService(['alpha']);
    await service.reloadConfig(false);

    await service.scanAll();
    expect(collectorState.aliases.sort()).toEqual(['alpha', 'beta', 'gamma']);

    collectorState.aliases.length = 0;
    await service.scanAliases(['beta']);
    expect(collectorState.aliases).toEqual(['beta']);

    collectorState.aliases.length = 0;
    await service.scanAliases(['gamma', 'alpha']);
    expect(collectorState.aliases.sort()).toEqual(['alpha', 'gamma']);
    expect(service.getRecord('alpha')?.subscribed).toBe(true);
    expect(service.getRecord('beta')?.subscribed).toBe(false);
    service.dispose();
  });

  it('stops taking queued hosts after cancellation', async () => {
    const service = createService();
    await service.reloadConfig(false);
    if (!settingsState.value) {
      throw new Error('Test settings were not initialized.');
    }
    settingsState.value.maxConcurrentHosts = 1;
    const token = {
      isCancellationRequested: false,
    } as vscode.CancellationToken;
    collectorState.handler = async () => {
      (token as { isCancellationRequested: boolean }).isCancellationRequested = true;
      return snapshot(20, 1);
    };

    await service.scanAliases(['alpha', 'beta', 'gamma'], token);
    expect(collectorState.aliases).toEqual(['alpha']);
    service.dispose();
  });

  it('notifies once while idle and notifies again after becoming busy', async () => {
    const service = createService(['alpha']);
    collectorState.handler = async () => snapshot(0, 0);
    await service.initialize();
    await service.scanAliases(['alpha']);
    expect(informationMessages).toEqual(['alpha is idle.']);

    collectorState.handler = async () => snapshot(30, 1);
    await service.scanAliases(['alpha']);
    collectorState.handler = async () => snapshot(0, 0);
    await service.scanAliases(['alpha']);
    expect(informationMessages).toEqual(['alpha is idle.', 'alpha is idle.']);
    service.dispose();
  });
});
