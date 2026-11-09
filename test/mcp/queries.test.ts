import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getHistory } from '../../src/mcp/history.js';
import { inspectHost, overview, queryHosts, refreshHosts } from '../../src/mcp/queries.js';
import { bounded, byteSize, RESULT_BYTES, SnapshotPages } from '../../src/mcp/results.js';
import { HISTORY_BUCKET_MS } from '../../src/npu/history.js';
import { getSettings } from '../../src/settings.js';
import { configurationValues, resetVscodeMock } from '../mocks/vscode.js';
import { fixture, record } from './fixtures.js';

const now = Math.floor(Date.UTC(2026, 10, 9, 12) / HISTORY_BUCKET_MS) * HISTORY_BUCKET_MS;
const paging = { limit: 10 };
const query = { ...paging, sort: 'name' as const };
const inspect = { ...paging, host: 'node-1', section: 'summary' as const };
let pages: SnapshotPages;

beforeEach(() => {
  resetVscodeMock(); vi.useFakeTimers(); vi.setSystemTime(now);
  pages = new SnapshotPages();
});
afterEach(() => vi.useRealTimers());

function data<T = any>(result: { data: Record<string, unknown> }, field: string): T { return result.data[field] as T; }

describe('resource discovery', () => {
  it('groups missing model metadata and normalizes cached names without changing cached observations', () => {
    const { service, records } = fixture([record(), record('node-2'), record('node-3')]);
    records[0]!.snapshot!.devices.forEach((device, index) => {
      device.model = index === 0 ? '' : index === 1 ? '   ' : index === 2 ? undefined : ' Ascend910 ';
    });
    records[1]!.snapshot!.devices.forEach(device => { device.model = undefined; });
    records[2]!.snapshot!.devices.forEach(device => { device.model = ''; });
    const settings = getSettings();
    expect(data(overview(service, settings, pages, paging), 'models')).toEqual([
      { model: null, hosts: 3, devices: 35 }, { model: 'Ascend910', hosts: 1, devices: 13 },
    ]);
    const hosts = data(queryHosts(service, settings, pages, query), 'hosts');
    expect(hosts.map((host: any) => host.models)).toEqual([['Ascend910'], [], []]);
    expect(data(queryHosts(service, settings, pages, { ...query, model: ' ascend910 ' }), 'hosts')
      .map((host: any) => host.host)).toEqual(['node-1']);
    const devices = data(inspectHost(service, settings, pages, { ...inspect, section: 'devices' }), 'devices');
    expect(devices.slice(0, 3).map((device: any) => device.model)).toEqual([null, null, null]);
    expect(devices[3].model).toBe('Ascend910');
    expect(records[0]!.snapshot!.devices[1]!.model).toBe('   ');
    expect(service.refreshAliases).not.toHaveBeenCalled();
  });

  it('intersects resource and preference conditions, searches notes and visible container metadata', () => {
    const { service, records, preference } = fixture([record('node-10'), record('node-2')]);
    preference.set('node-2', { favorite: true, note: 'Accuracy Test' });
    records[1]!.subscribed = true;
    const settings = getSettings();
    expect(data(queryHosts(service, settings, pages, { ...query, query: 'accuracy TEST', favorite: true, subscribed: true,
      model: 'ascend910', minIdleCards: 1, minIdleSeconds: 0 }), 'hosts').map((item: any) => item.host)).toEqual(['node-2']);
    expect(data(queryHosts(service, settings, pages, { ...query, minIdleCards: 2 }), 'hosts')).toEqual([]);
    expect(data(queryHosts(service, settings, pages, { ...query, query: '10.0.0.1' }), 'hosts')).toHaveLength(2);
    for (const keyword of ['projectone', 'image:test', '/WORK/benchmark', 'docker-one']) {
      const result = queryHosts(service, settings, pages, { ...query, query: keyword });
      expect(data(result, 'hosts')).toHaveLength(2);
      expect(data(result, 'hosts')[0].containerMatch.id).toHaveLength(64);
      expect(data(result, 'hosts')[0].matchedBy).toEqual(['container']);
    }
    expect(data(queryHosts(service, settings, pages, { ...query, query: 'private:service' }), 'hosts')).toEqual([]);
    configurationValues.set('npuMonitor.containers.filterMode', 'all');
    expect(data(queryHosts(service, getSettings(), pages, { ...query, query: 'private:service' }), 'hosts')).toHaveLength(2);
    configurationValues.set('npuMonitor.containers.filterMode', 'workspacePaths');
    configurationValues.set('npuMonitor.containers.workspacePaths', ['/other']);
    expect(data(queryHosts(service, getSettings(), pages, { ...query, query: 'projectone' }), 'hosts')).toEqual([]);
    expect(service.getIdleHistory.mock.calls.every(call => call[2] === false)).toBe(true);
    expect(service.refreshAliases).not.toHaveBeenCalled();
  });

  it('uses current any-card state while refreshing, excludes expired and incomplete evidence', () => {
    configurationValues.set('npuMonitor.idleScope', 'allCards');
    const { service, records, history } = fixture();
    const item = records[0]!;
    item.refreshing = true;
    item.state = 'busy';
    expect(data(queryHosts(service, getSettings(), pages, { ...query, minIdleCards: 1 }), 'hosts')[0].npu.idleDevices).toBe(1);
    for (const change of [
      () => { item.stale = true; },
      () => { item.snapshot!.partial = true; },
      () => { item.snapshot!.collectedAt = now - 1; },
      () => { item.host.hostname = 'changed'; },
      () => { configurationValues.set('npuMonitor.idleUtilizationThresholdPercent', 10); },
    ]) {
      change();
      expect(data(queryHosts(service, getSettings(), pages, { ...query, minIdleCards: 1 }), 'hosts')).toEqual([]);
      item.stale = false; item.snapshot!.partial = false; item.snapshot!.collectedAt = now; item.host.hostname = '10.0.0.1';
      configurationValues.delete('npuMonitor.idleUtilizationThresholdPercent');
    }
    history.observe(item.host, undefined, getSettings(), now);
    expect(data(inspectHost(service, getSettings(), pages, inspect), 'summary').npu.idleDevices).toBeNull();
    vi.advanceTimersByTime(360001);
    expect(data(queryHosts(service, getSettings(), pages, query), 'hosts')[0].freshness.npu.outdated).toBe(true);
  });

  it('provides aggregate coverage and separates NPU validity from container observations', () => {
    const { service, records } = fixture([record(), record('node-2')]);
    records[1]!.stale = true; records[1]!.state = 'timeout';
    records[1]!.devContainers!.stale = true;
    const result = overview(service, getSettings(), pages, paging);
    expect(result.data).toMatchObject({ totalHosts: 2, npu: { observedHosts: 2, freshHosts: 1, idleHosts: 1,
      idleDevices: 1, unknownHosts: 1, errorHosts: 1 }, containers: { count: 2, observedHosts: 2, staleHosts: 1 } });
    expect(result.data.hosts).toBeUndefined();
    const summary = data(inspectHost(service, getSettings(), pages, inspect), 'summary');
    expect(summary.freshness.npu.validUntil).toBe(now + 360000);
    expect(summary.freshness.containers).toMatchObject({ collectedAt: now, validUntil: null, outdated: null });
    expect(JSON.stringify(result)).not.toContain('/secret');
  });

  it('ranks idle counts and duration with natural name ties, keeping unknown last', () => {
    const { service, records, history } = fixture([record('node-10'), record('node-2'), record('node-3')]);
    const item = records[2]!;
    const previous = { ...item.snapshot!, collectedAt: now - 60000 };
    const fresh = fixture([record('unused')]);
    fresh.history.observe(item.host, previous, getSettings());
    fresh.history.observe(item.host, item.snapshot, getSettings());
    const original = service.getIdleHistory.getMockImplementation()!;
    service.getIdleHistory.mockImplementation((alias, time, bins) => alias === 'node-3'
      ? fresh.history.getHistory(alias, getSettings(), time, item.host, bins) : original(alias, time, bins));
    expect(data(queryHosts(service, getSettings(), pages, { ...query, sort: 'idleDuration' }), 'hosts')
      .map((row: any) => row.host)).toEqual(['node-3', 'node-2', 'node-10']);
    item.snapshot!.devices[1]!.utilizationPercent = 0;
    item.snapshot!.devices[1]!.processCount = 0;
    item.snapshot!.devices[1]!.processes = [];
    history.observe(item.host, item.snapshot, getSettings());
    fresh.history.observe(item.host, item.snapshot, getSettings());
    expect(data(queryHosts(service, getSettings(), pages, { ...query, sort: 'idleCards' }), 'hosts')[0].host).toBe('node-3');
  });
});

describe('detail sections', () => {
  it('validates selected devices and preserves process continuation snapshots', () => {
    const { service, records } = fixture();
    const settings = getSettings();
    const empty = inspectHost(service, settings, pages, { ...inspect, section: 'processes', deviceId: '0' });
    expect(data(empty, 'processes')).toEqual([]);
    expect(empty.page).toMatchObject({ total: 0, returned: 0, nextCursor: null });
    expect(() => inspectHost(service, settings, pages, { ...inspect, section: 'processes', deviceId: '999999' }))
      .toThrow(expect.objectContaining({ code: 'UNKNOWN_CARD' }));
    records[0]!.snapshot!.devices[1]!.processes.push({ pid: '102', name: 'worker-2', memoryMb: 512 });
    const input = { ...inspect, section: 'processes' as const, deviceId: '1', limit: 1 };
    const first = inspectHost(service, settings, pages, input);
    records[0]!.snapshot!.devices = records[0]!.snapshot!.devices.filter(device => device.id !== '1');
    const continued = inspectHost(service, settings, pages, { ...input, cursor: first.page!.nextCursor! });
    expect(continued.asOf).toBe(first.asOf);
    expect(data(continued, 'processes')).toEqual([{ deviceId: '1', pid: '102', name: 'worker-2', memoryMb: 512 }]);
    expect(() => inspectHost(service, settings, pages, input)).toThrow(expect.objectContaining({ code: 'UNKNOWN_CARD' }));
    records[0]!.snapshot = undefined;
    expect(() => inspectHost(service, settings, pages, { ...input, deviceId: '0' }))
      .toThrow(expect.objectContaining({ code: 'UNKNOWN_CARD' }));
    expect(service.refreshAliases).not.toHaveBeenCalled();
  });

  it('discloses only the requested section, with complete IDs and no process lists in devices', () => {
    const { service } = fixture();
    const settings = getSettings();
    const summary = inspectHost(service, settings, pages, inspect);
    expect(data(summary, 'summary').sections).toContain('processes');
    expect(JSON.stringify(summary)).not.toContain('bins');
    expect(JSON.stringify(summary)).not.toContain('/work/benchmark');
    const devices = inspectHost(service, settings, pages, { ...inspect, section: 'devices' });
    expect(devices.page).toMatchObject({ total: 16, returned: 10 });
    expect(data(devices, 'devices')[1]).toHaveProperty('processCount', 1);
    expect(data(devices, 'devices')[1]).not.toHaveProperty('processes');
    const processes = inspectHost(service, settings, pages, { ...inspect, section: 'processes', deviceId: '1' });
    expect(data(processes, 'processes')).toEqual([{ deviceId: '1', pid: '101', name: 'worker', memoryMb: 1024 }]);
    const containers = inspectHost(service, settings, pages, { ...inspect, section: 'containers', query: 'PROJECT' });
    expect(data(containers, 'containers')[0].id).toHaveLength(64);
    expect(data(containers, 'containers')[0]).not.toHaveProperty('configFile');
    const container = inspectHost(service, settings, pages, { ...inspect, section: 'container', containerId: 'a'.repeat(64) });
    expect(data(container, 'container')).toMatchObject({ imageId: 'sha256:' + 'b'.repeat(64), workspaceFolder: '/work/benchmark' });
    expect(() => inspectHost(service, settings, pages, { ...inspect, section: 'container', containerId: 'c'.repeat(64) })).toThrow('visible cache');
    const connection = inspectHost(service, settings, pages, { ...inspect, section: 'connection' });
    expect(data(connection, 'connection')).toMatchObject({ alias: 'node-1', hostname: '10.0.0.1', user: 'user', port: 22, sshConfig: '/tmp/config' });
    expect(JSON.stringify(connection)).not.toContain('/secret');
    expect(() => inspectHost(service, settings, pages, { ...inspect, deviceId: '1' })).toThrow('deviceId');
    expect(() => inspectHost(service, settings, pages, { ...inspect, section: 'container' })).toThrow('containerId');
    expect(service.getIdleHistory.mock.calls.every(call => call[2] === false)).toBe(true);
    expect(service.refreshAliases).not.toHaveBeenCalled();
  });
});

describe('historical evidence', () => {
  it('summarizes mixed and missing buckets separately and pages sparse observations by card and time', () => {
    const { service } = fixture();
    service.getIdleHistory.mockReturnValue({ alias: 'node-1', retentionDays: 7, cards: [
      { id: '0', state: 'idle', observedAt: now, idleSince: now - 1000,
        bins: [[now - 4 * HISTORY_BUCKET_MS, 'idle'], [now - 3 * HISTORY_BUCKET_MS, 'mixed'], [now - HISTORY_BUCKET_MS, 'unknown']] },
    ] });
    const input = { ...paging, host: 'node-1', cards: ['0'], from: now - 4 * HISTORY_BUCKET_MS, to: now, mode: 'summary' as const };
    const summary = getHistory(service, getSettings(), pages, input);
    expect(data(summary, 'cards')[0]).toMatchObject({ counts: { idle: 1, busy: 0, mixed: 1, unknown: 1 },
      unobservedBuckets: 1, observedBuckets: 2, coverageRatio: 0.5 });
    expect(JSON.stringify(summary)).not.toContain('bins');
    const first = getHistory(service, getSettings(), pages, { ...input, mode: 'buckets', limit: 2 });
    expect(data(first, 'buckets').map((row: any) => row.state)).toEqual(['idle', 'mixed']);
    const second = getHistory(service, getSettings(), pages, { ...input, mode: 'buckets', limit: 2, cursor: first.page!.nextCursor! });
    expect(data(second, 'buckets')).toEqual([{ cardId: '0', start: now - HISTORY_BUCKET_MS, state: 'unknown' }]);
    expect(() => getHistory(service, getSettings(), pages, { ...input, from: now - 8 * 86400000 })).toThrow('retention');
    expect(() => getHistory(service, getSettings(), pages, { ...input, to: now + 1 })).toThrow('retention');
    expect(() => getHistory(service, getSettings(), pages, { ...input, cards: ['missing'] })).toThrow('Unknown card');
  });
});

describe('bounded result snapshots', () => {
  it('freezes result contents and ordering, binds cursors to conditions and expires them', () => {
    const { service, records } = fixture(Array.from({ length: 15 }, (_, i) => record('node-' + i)));
    const first = queryHosts(service, getSettings(), pages, query);
    const cursor = first.page!.nextCursor!;
    records.splice(0);
    const second = queryHosts(service, getSettings(), pages, { ...query, cursor });
    expect(second.asOf).toBe(first.asOf);
    expect(data(second, 'hosts').map((row: any) => row.host)).toEqual(['node-10', 'node-11', 'node-12', 'node-13', 'node-14']);
    expect(() => queryHosts(service, getSettings(), pages, { ...query, cursor, favorite: true })).toThrow('another query');
    expect(() => queryHosts(service, getSettings(), pages, { ...query, cursor: 'bad' })).toThrow('Invalid cursor');
    vi.advanceTimersByTime(120000);
    expect(() => queryHosts(service, getSettings(), pages, { ...query, cursor })).toThrow('expired');
  });

  it('reduces pages to the byte budget, handles oversized items, and evicts by count and bytes', () => {
    const build = () => ({ data: {}, field: 'rows', rows: Array.from({ length: 50 }, () => ({ value: 'x'.repeat(2000) })) });
    const first = pages.page('one', 50, undefined, build);
    expect(first.page!.returned).toBeLessThan(50);
    expect(first.page!.nextCursor).toBeTruthy();
    expect(byteSize(first)).toBeLessThanOrEqual(RESULT_BYTES);
    expect(() => pages.page('large', 1, undefined, () => ({ ...build(), rows: ['x'.repeat(RESULT_BYTES)] }))).toThrow('One item');
    expect(() => bounded({ asOf: now, data: { text: 'x'.repeat(RESULT_BYTES) } })).toThrow('16 KiB');
    for (let index = 0; index < 32; index++) pages.page('other-' + index, 1, undefined, build);
    expect(() => pages.page('one', 1, first.page!.nextCursor!, build)).toThrow('evicted');
    pages.clear();
    const big = () => ({ data: {}, field: 'rows', rows: Array.from({ length: 500 }, () => ({ value: 'x'.repeat(10000) })) });
    const before = pages.page('big-one', 1, undefined, big);
    pages.page('big-two', 1, undefined, big);
    expect(() => pages.page('big-one', 1, before.page!.nextCursor!, big)).toThrow('evicted');
  });

  it('keeps 150 hosts, 16 cards and seven days of history out of ordinary responses', () => {
    const { service } = fixture(Array.from({ length: 150 }, (_, i) => record('node-' + i)));
    const bins: [number, 'idle'][] = Array.from({ length: 7 * 96 }, (_, i) => [now - (7 * 96 - i) * HISTORY_BUCKET_MS, 'idle']);
    service.getIdleHistory.mockImplementation((alias, time, includeBins) => ({ alias, retentionDays: 7,
      cards: Array.from({ length: 16 }, (_, id) => ({ id: String(id), state: 'idle', observedAt: time ?? now,
        idleSince: now - 60000, bins: includeBins ? bins : [] })) }));
    const results = [overview(service, getSettings(), pages, paging), queryHosts(service, getSettings(), pages, query),
      inspectHost(service, getSettings(), pages, { ...inspect, host: 'node-0' })];
    for (const result of results) {
      expect(byteSize(result)).toBeLessThanOrEqual(RESULT_BYTES);
      expect(JSON.stringify(result)).not.toContain('bins');
    }
    expect(results[1]!.page).toMatchObject({ total: 150, returned: 10 });
    expect(service.getIdleHistory.mock.calls.every(call => call[2] === false)).toBe(true);
    const summary = getHistory(service, getSettings(), pages, { ...paging, host: 'node-0', mode: 'summary' });
    const buckets = getHistory(service, getSettings(), pages, { ...paging, host: 'node-0', mode: 'buckets', from: now - 7 * 86400000 });
    expect(summary.page!.total).toBe(16);
    expect(buckets.page!.total).toBe(16 * 7 * 96);
    expect(byteSize(summary)).toBeLessThanOrEqual(RESULT_BYTES);
    expect(byteSize(buckets)).toBeLessThanOrEqual(RESULT_BYTES);
  });
});

describe('explicit refresh', () => {
  it('deduplicates targets and only returns the selected source; continuation never repeats collection', async () => {
    const { service } = fixture([record(), record('node-2')]);
    const input = { hosts: ['node-1', 'node-2', 'node-1'], scope: 'containers' as const, limit: 1 };
    const first = await refreshHosts(service, getSettings(), pages, input);
    const second = await refreshHosts(service, getSettings(), pages, { ...input, cursor: first.page!.nextCursor! });
    expect(service.refreshAliases).toHaveBeenCalledExactlyOnceWith(['node-1', 'node-2'], 'containers');
    expect(data(first, 'hosts')[0]).not.toHaveProperty('npu');
    expect(data(second, 'hosts')[0]).toMatchObject({ host: 'node-2', containers: { state: 'ready', success: true } });
    await expect(refreshHosts(service, getSettings(), pages, { ...input, hosts: ['missing'] })).rejects.toThrow('Unknown');
    configurationValues.set('npuMonitor.devContainers.enabled', false);
    await expect(refreshHosts(service, getSettings(), pages, input)).rejects.toThrow('disabled');
  });

  it('returns failures independently instead of attaching all snapshots', async () => {
    const { service, records } = fixture([record(), record('node-2')]);
    service.refreshAliases.mockImplementation(async () => { records[1]!.state = 'timeout'; records[1]!.stale = true; });
    const result = await refreshHosts(service, getSettings(), pages, { ...paging, hosts: ['node-1', 'node-2'], scope: 'both' });
    expect(data(result, 'hosts')[0].npu.success).toBe(true);
    expect(data(result, 'hosts')[1].npu).toMatchObject({ state: 'timeout', success: false });
    expect(JSON.stringify(result)).not.toContain('devices');
    expect(records.every(item => item.subscribed === false)).toBe(true);
  });
});
