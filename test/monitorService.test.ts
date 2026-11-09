import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type * as vscode from 'vscode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DevContainerScanResult, MonitorSettings, ScanResult, SshHost } from '../src/types.js';
import {
  informationMessages,
  resetVscodeMock,
  window,
} from './mocks/vscode.js';

import { createMemento, makeSettings } from './helpers/fixtures.js';

type ScanHandler = (
  host: SshHost,
  token?: vscode.CancellationToken,
) => Promise<ScanResult>;

const containersState = vi.hoisted(() => ({
  aliases: [] as string[],
  handler: async (): Promise<DevContainerScanResult> => ({ state: 'ready', snapshot: { containers: [], collectedAt: Date.now(), durationMs: 1 } }),
}));
vi.mock('../src/containers/collector.js', () => ({
  DevContainerCollector: class {
    public async scan(host: SshHost): Promise<DevContainerScanResult> {
      containersState.aliases.push(host.alias);
      return containersState.handler();
    }
  },
}));

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

vi.mock('../src/npu/collector.js', () => ({
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
import { HostBrowser } from '../src/ui/hostBrowser.js';

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
  return {
    globalState: createMemento(),
    workspaceState: createMemento({ 'npuMonitor.subscriptions': subscriptions }),
  } as unknown as vscode.ExtensionContext;
}

function createService(subscriptions: string[] = [], context = createContext(subscriptions)): MonitorService {
  const output = { appendLine: vi.fn() } as unknown as vscode.OutputChannel;
  return new MonitorService(context, output);
}

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryConfig(prefix: string, text: string): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), prefix));
  directories.push(directory);
  const configPath = path.join(directory, 'config');
  writeFileSync(configPath, text);
  return configPath;
}

describe('monitor scan orchestration', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetVscodeMock();
    containersState.aliases.length = 0;
    containersState.handler = async () => ({ state: 'ready', snapshot: { containers: [], collectedAt: Date.now(), durationMs: 1 } });
    collectorState.aliases.length = 0;
    collectorState.handler = async () => snapshot(20, 1);
    const configPath = temporaryConfig('npu-monitor-service-', 'Host alpha beta gamma\n  User root\n  Port 22\n');
    settingsState.value = makeSettings({
      sshConfigPath: configPath, sshExecutablePath: '/usr/bin/ssh', maxConcurrentHosts: 2,
      pollIntervalSeconds: 3600, autoRefreshAllHosts: false, idleScope: 'allCards',
      devContainersEnabled: false,
    });
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

  it('starts and periodically refreshes all hosts when enabled', async () => {
    settingsState.value!.autoRefreshAllHosts = true;
    const service = createService();
    await service.initialize();
    expect(collectorState.aliases.sort()).toEqual(['alpha', 'beta', 'gamma']);
    collectorState.aliases.length = 0;
    await (service as unknown as { runAutomaticScan: () => Promise<void> }).runAutomaticScan();
    expect(collectorState.aliases.sort()).toEqual(['alpha', 'beta', 'gamma']);
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

  it('keeps full scans and subscriptions independent of local browsing preferences and filters', async () => {
    settingsState.value!.devContainersEnabled = true;
    const context = createContext(['alpha']);
    const service = createService(['alpha'], context);
    await service.reloadConfig(false);
    const browser = new HostBrowser(service, context.globalState);
    try {
      await browser.setFavorite([service.getRecord('beta')!], true);
      await browser.setNote(service.getRecord('beta')!, 'Favorite benchmark host');
      expect(service.getHostPreference('beta')).toEqual({ favorite: true, note: 'Favorite benchmark host' });
      browser.setFilter('favorites');
      expect(browser.records().map(record => record.host.alias)).toEqual(['beta']);
      expect(collectorState.aliases).toEqual([]);
      expect(containersState.aliases).toEqual([]);
      await service.scanAll();
      expect(collectorState.aliases.sort()).toEqual(['alpha', 'beta', 'gamma']);
      expect(containersState.aliases.sort()).toEqual(['alpha', 'beta', 'gamma']);
      expect(service.getRecords().filter(record => record.subscribed).map(record => record.host.alias)).toEqual(['alpha']);
    } finally {
      browser.dispose();
      service.dispose();
    }
  });

  it.each(['npu', 'containers', 'both'] as const)('refreshes only the requested %s sources without changing subscriptions', async scope => {
    settingsState.value!.devContainersEnabled = true;
    const service = createService(['alpha']);
    try {
      await service.scanAliases(['alpha']);
      const npu = service.getRecord('alpha')!.snapshot;
      const containers = service.getRecord('alpha')!.devContainers!.snapshot;
      collectorState.aliases.length = 0;
      containersState.aliases.length = 0;
      await service.refreshAliases(['alpha', 'alpha'], scope);
      expect(collectorState.aliases).toEqual(scope === 'containers' ? [] : ['alpha']);
      expect(containersState.aliases).toEqual(scope === 'npu' ? [] : ['alpha']);
      if (scope === 'containers') expect(service.getRecord('alpha')!.snapshot).toBe(npu);
      if (scope === 'npu') expect(service.getRecord('alpha')!.devContainers!.snapshot).toBe(containers);
      expect(service.getRecord('alpha')!.subscribed).toBe(true);
    } finally { service.dispose(); }
  });

  it('keeps successful refresh targets available when another target fails', async () => {
    const service = createService();
    collectorState.handler = async host => host.alias === 'beta'
      ? { state: 'timeout', error: 'Timed out' } : snapshot(0, 0);
    try {
      await service.refreshAliases(['alpha', 'beta'], 'npu');
      expect(service.getRecord('alpha')!.state).toBe('idle');
      expect(service.getRecord('beta')!.state).toBe('timeout');
      expect(containersState.aliases).toEqual([]);
      await expect(service.refreshAliases(['missing'], 'npu')).rejects.toThrow('Unknown');
    } finally { service.dispose(); }
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

describe('Dev Container scan orchestration', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetVscodeMock();
    collectorState.aliases.length = 0;
    containersState.aliases.length = 0;
    collectorState.handler = async () => snapshot(0, 0);
    containersState.handler = async () => ({ state: 'ready', snapshot: {
      containers: [{ id: 'a'.repeat(64), isDevContainer: true, name: 'dev', image: 'image', state: 'running', createdAt: 'now' }],
      collectedAt: Date.now(), durationMs: 1,
    } });
    const configPath = temporaryConfig('npu-container-service-', 'Host alpha beta gamma\n  User root\n');
    settingsState.value = makeSettings({
      sshConfigPath: configPath, sshExecutablePath: '/usr/bin/ssh', maxConcurrentHosts: 2,
      pollIntervalSeconds: 60, autoRefreshAllHosts: false, idleScope: 'allCards',
    });
  });

  it('publishes NPU state before Docker completes and does not wait for idle notification dismissal', async () => {
    vi.spyOn(window, 'showInformationMessage').mockImplementation(() => new Promise(() => {}));
    const service = createService(['alpha']);
    containersState.handler = async () => {
      expect(service.getRecord('alpha')?.state).toBe('idle');
      expect(service.getRecord('alpha')?.snapshot).toBeDefined();
      return { state: 'permissionDenied', error: 'socket permission denied' };
    };
    await service.initialize();
    expect(service.getRecord('alpha')?.state).toBe('idle');
    expect(service.getRecord('alpha')?.devContainers?.state).toBe('permissionDenied');
    expect(service.getRecord('alpha')?.refreshing).toBe(false);
    expect(informationMessages).toHaveLength(0); // the unresolved notification mock intercepted it
    service.dispose();
  });

  it('collects containers even without an NPU collector on the remote host', async () => {
    const service = createService();
    collectorState.handler = async () => ({ state: 'unsupported' });
    await service.scanAliases(['alpha']);
    expect(service.getRecord('alpha')?.state).toBe('unsupported');
    expect(service.getRecord('alpha')?.devContainers?.snapshot?.containers).toHaveLength(1);
    service.dispose();
  });

  it('announces filter changes without scans, snapshot replacement or subscription changes', async () => {
    const service = createService(['alpha']);
    await service.initialize();
    const previous = service.getRecord('alpha')?.devContainers?.snapshot;
    collectorState.aliases.length = 0;
    containersState.aliases.length = 0;
    const changed = vi.fn();
    service.onDidChange(changed);
    for (const mode of ['all', 'workspacePaths', 'devContainers'] as const) {
      settingsState.value!.containerFilterMode = mode;
      settingsState.value!.containerWorkspacePaths = ['/home/user', '/mnt/work'];
      await service.reloadConfig(false);
      expect(service.getRecord('alpha')?.devContainers?.snapshot).toBe(previous);
      expect(service.getRecords().filter(record => record.subscribed).map(record => record.host.alias)).toEqual(['alpha']);
    }
    expect(changed).toHaveBeenCalledTimes(3);
    expect(collectorState.aliases).toEqual([]);
    expect(containersState.aliases).toEqual([]);
    service.dispose();
  });

  it('keeps failed data stale and clears it after a successful empty response', async () => {
    const service = createService();
    await service.scanAliases(['alpha']);
    containersState.handler = async () => ({ state: 'timeout', error: 'timeout' });
    await service.scanAliases(['alpha']);
    expect(service.getRecord('alpha')?.devContainers?.stale).toBe(true);
    expect(service.getRecord('alpha')?.devContainers?.snapshot?.containers).toHaveLength(1);
    containersState.handler = async () => ({ state: 'ready', snapshot: { containers: [], collectedAt: Date.now(), durationMs: 1 } });
    await service.scanAliases(['alpha']);
    expect(service.getRecord('alpha')?.devContainers?.stale).toBe(false);
    expect(service.getRecord('alpha')?.devContainers?.snapshot?.containers).toEqual([]);
    service.dispose();
  });

  it('scans NPU and containers on every host initially, then only NPU periodically', async () => {
    settingsState.value!.autoRefreshAllHosts = true;
    const service = createService(['alpha']);
    await service.initialize();
    expect(collectorState.aliases.sort()).toEqual(['alpha', 'beta', 'gamma']);
    expect(containersState.aliases.sort()).toEqual(['alpha', 'beta', 'gamma']);
    collectorState.aliases.length = 0;
    containersState.aliases.length = 0;
    await (service as unknown as { runAutomaticScan: () => Promise<void> }).runAutomaticScan();
    expect(collectorState.aliases.sort()).toEqual(['alpha', 'beta', 'gamma']);
    expect(containersState.aliases).toEqual([]);
    service.dispose();
  });

  it('adds a container scan when a manual refresh overlaps an NPU-only automatic scan', async () => {
    settingsState.value!.autoRefreshAllHosts = true;
    const service = createService();
    await service.reloadConfig(false);
    let finish!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { finish = resolve; });
    collectorState.handler = async host => {
      if (host.alias === 'beta') { entered(); await blocked; }
      return snapshot(0, 0);
    };
    const automatic = (service as unknown as { runAutomaticScan: () => Promise<void> }).runAutomaticScan();
    await started;
    const manual = service.scanAliases(['beta']);
    finish();
    await Promise.all([automatic, manual]);
    expect(collectorState.aliases.filter(alias => alias === 'beta')).toHaveLength(1);
    expect(containersState.aliases).toEqual(['beta']);
    service.dispose();
  });

  it('scans subscribed containers initially but not periodically when all-host refresh is disabled', async () => {
    const service = createService(['alpha']);
    await service.initialize();
    expect(containersState.aliases).toEqual(['alpha']);
    containersState.aliases.length = 0;
    await service.scanAliases(['beta', 'gamma']);
    expect(containersState.aliases.sort()).toEqual(['beta', 'gamma']);
    expect(service.getRecord('beta')?.subscribed).toBe(false);
    containersState.aliases.length = 0;
    await (service as unknown as { runAutomaticScan: () => Promise<void> }).runAutomaticScan();
    expect(containersState.aliases).toEqual([]);
    service.dispose();
  });

  it('does not launch Docker after cancellation and restores previous data if cancelled during Docker', async () => {
    const service = createService();
    const token = { isCancellationRequested: false } as vscode.CancellationToken;
    collectorState.handler = async () => {
      (token as { isCancellationRequested: boolean }).isCancellationRequested = true;
      return snapshot(0, 0);
    };
    await service.scanAliases(['alpha'], token);
    expect(containersState.aliases).toEqual([]);
    collectorState.handler = async () => snapshot(0, 0);
    await service.scanAliases(['alpha']);
    const previous = service.getRecord('alpha')?.devContainers;
    (token as { isCancellationRequested: boolean }).isCancellationRequested = false;
    containersState.handler = async () => {
      (token as { isCancellationRequested: boolean }).isCancellationRequested = true;
      return { state: 'error' };
    };
    await service.scanAliases(['alpha'], token);
    expect(service.getRecord('alpha')?.devContainers).toBe(previous);
    expect(service.getRecord('alpha')?.refreshing).toBe(false);
    service.dispose();
  });

  it('merges overlapping requests and preserves the record through configuration reloads', async () => {
    const service = createService();
    let finish!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { finish = resolve; });
    containersState.handler = async () => {
      entered();
      await blocked;
      return { state: 'ready', snapshot: { containers: [], collectedAt: Date.now(), durationMs: 1 } };
    };
    const first = service.scanAliases(['alpha']);
    await started;
    const record = service.getRecord('alpha');
    const second = service.scanAliases(['alpha']);
    await Promise.resolve();
    finish();
    await Promise.all([first, second]);
    expect(collectorState.aliases).toEqual(['alpha']);
    expect(containersState.aliases).toEqual(['alpha']);
    expect(service.getRecord('alpha')).toBe(record);
    expect(record?.devContainers?.state).toBe('ready');
    service.dispose();
  });

  it('does not scan Docker when disabled and caps active hosts', async () => {
    const service = createService();
    settingsState.value!.devContainersEnabled = false;
    await service.scanAll();
    expect(containersState.aliases).toEqual([]);
    settingsState.value!.devContainersEnabled = true;
    let active = 0;
    let maximum = 0;
    containersState.handler = async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active -= 1;
      return { state: 'ready', snapshot: { containers: [], collectedAt: Date.now(), durationMs: 1 } };
    };
    await service.scanAll();
    expect(maximum).toBe(2);
    service.dispose();
  });
});
