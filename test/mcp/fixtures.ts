import { vi } from 'vitest';

import { IdleHistoryStore } from '../../src/npu/history.js';
import { getSettings } from '../../src/settings.js';
import type { HostRecord } from '../../src/types.js';
import type { MonitorMcpService } from '../../src/mcp/types.js';
import { createMemento, makeDevice, makeHost, makeRecord } from '../helpers/fixtures.js';

export function record(alias = 'node-1', now = Date.now()): HostRecord {
  return makeRecord({
    host: makeHost({ alias, user: 'user', identityFiles: ['/secret/key'], useAlias: true }),
    state: 'idle', idleStreak: 1,
    snapshot: { source: 'npu-smi', collectedAt: now, partial: false, durationMs: 1,
      devices: Array.from({ length: 16 }, (_, id) => makeDevice({ id: String(id),
        utilizationPercent: id === 0 ? 0 : 50, processCount: id === 0 ? 0 : 1,
        processes: id === 0 ? [] : [{ pid: String(100 + id), name: 'worker', memoryMb: 1024 }] })) },
    devContainers: { state: 'ready', refreshing: false, stale: false,
      snapshot: { collectedAt: now, durationMs: 1, containers: [
        { id: 'a'.repeat(64), name: 'docker-one', displayName: 'ProjectOne', isDevContainer: true,
          state: 'running', image: 'image:test', imageId: 'sha256:' + 'b'.repeat(64), createdAt: '2026-01-01',
          workspaceFolder: '/work/benchmark', containerWorkspaceFolder: '/workspace', configFile: '/work/devcontainer.json' },
        { id: 'c'.repeat(64), name: 'hidden', isDevContainer: false, state: 'running', image: 'private:service', createdAt: '' },
      ] } },
  });
}

export function fixture(records = [record()]) {
  const history = new IdleHistoryStore(createMemento());
  for (const item of records) history.observe(item.host, item.snapshot, getSettings());
  const preference = new Map<string, { favorite: boolean; note: string }>();
  const service = {
    getRecords: () => records,
    getRecord: (alias: string) => records.find(item => item.host.alias === alias),
    getHostPreference: (alias: string) => preference.get(alias) ?? { favorite: false, note: '' },
    getIdleHistory: vi.fn((alias: string, now = Date.now(), includeBins = true) =>
      history.getHistory(alias, getSettings(), now, records.find(item => item.host.alias === alias)?.host, includeBins)),
    refreshAliases: vi.fn<MonitorMcpService['refreshAliases']>(async () => {}),
  } satisfies MonitorMcpService;
  return { records, history, preference, service };
}
