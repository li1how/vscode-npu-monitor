import type * as vscode from 'vscode';
import { beforeEach, describe, expect, it } from 'vitest';

import { HISTORY_BUCKET_MS, IdleHistoryStore } from '../../src/npu/history.js';
import { getSettings } from '../../src/settings.js';
import type { HostRecord, HostSnapshot, NpuDevice, SshHost } from '../../src/types.js';
import { configurationValues, resetVscodeMock } from '../mocks/vscode.js';

const host: SshHost = {
  alias: 'alpha', hostname: '10.0.0.1', configPath: '/tmp/ssh', identityFiles: [], useAlias: true,
};
const start = Math.floor(Date.UTC(2026, 8, 23, 12) / HISTORY_BUCKET_MS) * HISTORY_BUCKET_MS;

function device(id: string, utilizationPercent = 0): NpuDevice {
  return { id, health: 'OK', utilizationPercent, processCount: 0, processes: [] };
}
function snapshot(time: number, devices = [device('0'), device('1')], partial = false): HostSnapshot {
  return { source: 'npu-smi', devices, partial, collectedAt: time, durationMs: 1 };
}
function record(snapshotValue: HostSnapshot, alias = 'alpha'): HostRecord {
  return { host: { ...host, alias }, state: 'idle', snapshot: snapshotValue, subscribed: false,
    refreshing: false, stale: false, idleStreak: 1, idleNotified: false };
}
function memory(): vscode.Memento {
  const values = new Map<string, unknown>();
  return {
    get<T>(key: string): T | undefined { return values.get(key) as T | undefined; },
    keys(): readonly string[] { return [...values.keys()]; },
    async update(key: string, value: unknown): Promise<void> { values.set(key, value); },
  } as vscode.Memento;
}

beforeEach(() => resetVscodeMock());

describe('per-NPU idle history', () => {
  it('persists continuous idle time and ranks any-card or all-card candidates consistently', async () => {
    const settings = getSettings();
    expect(settings).toMatchObject({ maxConcurrentHosts: 8, pollIntervalSeconds: 180,
      autoRefreshAllHosts: true, idleHistoryRetentionDays: 7, idleScope: 'anyCard' });
    configurationValues.set('npuMonitor.maxConcurrentHosts', 3);
    expect(getSettings().maxConcurrentHosts).toBe(3);
    configurationValues.set('npuMonitor.pollIntervalSeconds', 45);
    expect(getSettings().pollIntervalSeconds).toBe(45);
    const state = memory();
    const history = new IdleHistoryStore(state);
    history.observe(host, snapshot(start), settings);
    history.observe(host, snapshot(start + 60000, [device('0'), device('1', 50)]), settings);
    history.observe(host, snapshot(start + 120000, [device('0'), device('1')]), settings);
    await history.persist(settings, start + 120000);
    const restored = new IdleHistoryStore(state);
    const view = restored.getHistory(host.alias, settings, start + 120000, host);
    expect(view.cards.map(card => card.idleSince)).toEqual([start, start + 120000]);
    const candidates = restored.getCandidates([record(snapshot(start + 120000))], settings, start + 120000);
    expect(candidates).toMatchObject([{ alias: 'alpha', durationMs: 120000, idleDevices: 2,
      deviceId: '0', validUntil: start + 120000 + 360000 }]);
    configurationValues.set('npuMonitor.idleScope', 'allCards');
    expect(restored.getCandidates([record(snapshot(start + 120000))], getSettings(), start + 120000))
      .toMatchObject([{ durationMs: 0, deviceId: null }]);
    const midway = new IdleHistoryStore(memory());
    midway.observe(host, snapshot(start), settings);
    midway.observe(host, snapshot(start + 60000, [device('0'), device('1', 50)]), settings);
    expect(midway.getCandidates([record(snapshot(start + 60000, [device('0'), device('1', 50)]))],
      getSettings(), start + 60000)).toEqual([]);
  });

  it('breaks idle runs on gaps, failures, partial data and missing devices', () => {
    configurationValues.set('npuMonitor.pollIntervalSeconds', 60);
    const settings = getSettings();
    const history = new IdleHistoryStore(memory());
    history.observe(host, snapshot(start), settings);
    history.observe(host, snapshot(start + 3 * 60000), settings);
    expect(history.getHistory(host.alias, settings, start + 3 * 60000).cards[0]?.idleSince)
      .toBe(start + 3 * 60000);
    history.observe(host, undefined, settings, start + 4 * 60000);
    expect(history.getHistory(host.alias, settings, start + 4 * 60000).cards[0]?.idleSince).toBeNull();
    history.observe(host, snapshot(start + 5 * 60000, [device('0')], true), settings);
    expect(history.getHistory(host.alias, settings, start + 5 * 60000).cards.every(card => card.state === 'unknown')).toBe(true);
    history.observe(host, snapshot(start + 6 * 60000, [device('0')]), settings);
    const cards = history.getHistory(host.alias, settings, start + 6 * 60000).cards;
    expect(cards[0]?.idleSince).toBe(start + 6 * 60000);
    expect(cards[1]?.state).toBe('unknown');
    expect(history.getCandidates([record(snapshot(start + 6 * 60000, [device('0')]))], settings, start + 9 * 60000)).toEqual([]);
  });

  it('prunes retained bins, rejects reused aliases, and resets history when idle rules change', async () => {
    const settings = getSettings();
    settings.idleHistoryRetentionDays = 1;
    const state = memory();
    const history = new IdleHistoryStore(state);
    history.observe(host, snapshot(start - 2 * 86400000), settings);
    history.observe(host, snapshot(start), settings);
    await history.persist(settings, start);
    expect(new IdleHistoryStore(state).getHistory(host.alias, settings, start, host).cards[0]?.bins)
      .toEqual([[start, 'idle']]);
    const changedHost = { ...host, hostname: '10.0.0.2' };
    expect(history.getHistory(host.alias, settings, start, changedHost).cards).toEqual([]);
    expect(history.getCandidates([record(snapshot(start))], { ...settings, idleUtilizationThresholdPercent: 2 }, start)).toEqual([]);
    history.observe(changedHost, snapshot(start + 60000), settings);
    expect(history.getHistory(host.alias, settings, start + 60000, changedHost).cards[0]?.idleSince)
      .toBe(start + 60000);
  });

  it('sorts by duration, then idle card count, then alias', () => {
    const settings = getSettings();
    const history = new IdleHistoryStore(memory());
    for (const alias of ['beta', 'alpha', 'gamma']) {
      const current = { ...host, alias };
      history.observe(current, snapshot(start, alias === 'gamma' ? [device('0')] : [device('0'), device('1')]), settings);
    }
    const records = ['gamma', 'beta', 'alpha'].map(alias => record(
      snapshot(start, alias === 'gamma' ? [device('0')] : [device('0'), device('1')]), alias));
    expect(history.getCandidates(records, settings, start).map(candidate => candidate.alias))
      .toEqual(['alpha', 'beta', 'gamma']);
  });
});
