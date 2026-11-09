import type * as vscode from 'vscode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IdleHistoryStore } from '../../src/npu/history.js';
import { getSettings } from '../../src/settings.js';
import type { HostRecord, HostState } from '../../src/types.js';
import { HostBrowser } from '../../src/ui/hostBrowser.js';
import { findHost, registerHostBrowserActions, selectedHostRecords } from '../../src/ui/hostBrowserActions.js';
import { HostNode, McpNode, StatusNode, type MonitorNode } from '../../src/ui/nodes.js';
import { NpuTreeProvider } from '../../src/ui/treeProvider.js';
import {
  commands, configurationValues, errorMessages, EventEmitter, inputBoxValues,
  quickPicks, resetVscodeMock, window,
} from '../mocks/vscode.js';

const now = Date.UTC(2026, 10, 9, 12);
const browsers: HostBrowser[] = [];

function memory(): vscode.Memento {
  const values = new Map<string, unknown>();
  return {
    get<T>(key: string, fallback?: T): T | undefined { return (values.get(key) ?? fallback) as T | undefined; },
    keys: () => [...values.keys()],
    update: vi.fn(async (key: string, value: unknown) => { values.set(key, structuredClone(value)); }),
  } as vscode.Memento;
}

function record(alias = 'node-1', state: HostState = 'unknown'): HostRecord {
  return {
    host: { alias, hostname: '10.20.0.1', configPath: '/tmp/config', identityFiles: [], useAlias: true },
    state, subscribed: false, refreshing: false, stale: false, idleStreak: 0, idleNotified: false,
  };
}

function setup(records: HostRecord[] = [], state = memory()) {
  const changes = new EventEmitter<void>();
  const history = new IdleHistoryStore(memory());
  const service = {
    getRecords: () => [...records],
    getIdleHistory: (alias: string, time = Date.now(), includeBins = true) => history.getHistory(alias, getSettings(), time,
      records.find(item => item.host.alias === alias)?.host, includeBins),
    onDidChange: changes.event,
    scanAliases: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn(),
  };
  const browser = new HostBrowser(service, state);
  browsers.push(browser);
  const observed = (alias: string, idleMs = 60000, utilization = [0, 80]): HostRecord => {
    const item = record(alias, utilization.every(value => value === 0) ? 'idle' : 'busy');
    item.snapshot = {
      source: 'npu-smi', collectedAt: now, durationMs: 1, partial: false,
      devices: utilization.map((value, id) => ({ id: String(id), health: 'OK', utilizationPercent: value,
        processCount: 0, processes: [] })),
    };
    history.observe(item.host, { ...item.snapshot, collectedAt: now - idleMs }, getSettings());
    history.observe(item.host, item.snapshot, getSettings());
    records.push(item);
    changes.fire();
    return item;
  };
  return { browser, records, changes, history, service, state, observed };
}

function tree(selection: readonly MonitorNode[] = []) {
  return { selection, message: '', reveal: vi.fn(async () => {}) };
}

beforeEach(() => {
  resetVscodeMock();
  vi.useFakeTimers();
  vi.setSystemTime(now);
  configurationValues.set('npuMonitor.pollIntervalSeconds', 60);
});

afterEach(() => {
  browsers.splice(0).forEach(browser => browser.dispose());
  vi.useRealTimers();
});

describe('host preferences', () => {
  it('persists favorites and notes across browsers, isolates SSH configs, and removes empty preferences', async () => {
    const alpha = record('node-10');
    const beta = record('node-2');
    const { browser, state, service } = setup([alpha, beta]);
    expect(browser.preference(alpha)).toEqual({ favorite: false, note: '' });
    expect(browser.records()).toEqual([beta, alpha]);
    await Promise.all([browser.setFavorite([alpha], true), browser.setNote(alpha, '  Benchmark  ')]);
    expect(browser.records()).toEqual([alpha, beta]);
    const reopened = setup([alpha, beta], state).browser;
    expect(reopened.preference(alpha)).toEqual({ favorite: true, note: 'Benchmark' });
    const otherConfig = { ...alpha, host: { ...alpha.host, configPath: '/tmp/other-config' } };
    expect(reopened.preference(otherConfig)).toEqual({ favorite: false, note: '' });
    browser.setFilter('favorites');
    expect(reopened.filter).toBe('all');
    await reopened.setNote(alpha, '');
    expect(reopened.preference(alpha)).toEqual({ favorite: true, note: '' });
    await reopened.setFavorite([alpha], false);
    expect(state.get(state.keys()[0]!)).toEqual({});
    expect(service.scanAliases).not.toHaveBeenCalled();
    expect(service.subscribe).not.toHaveBeenCalled();
    expect(service.unsubscribe).not.toHaveBeenCalled();
    expect(alpha.subscribed).toBe(false);
  });

  it('keeps persisted preferences after a write failure and permits retry', async () => {
    const alpha = record();
    const { browser, state } = setup([alpha]);
    await browser.setNote(alpha, 'Saved');
    vi.mocked(state.update).mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(browser.setFavorite([alpha], true)).rejects.toThrow('storage unavailable');
    expect(browser.preference(alpha)).toEqual({ favorite: false, note: 'Saved' });
    await browser.setFavorite([alpha], true);
    expect(browser.preference(alpha)).toEqual({ favorite: true, note: 'Saved' });
  });
});

describe('cached host filters and NPU summaries', () => {
  it('supports all six filters with overlapping errors and expiry, independent of Docker', async () => {
    const { browser, observed, records, changes } = setup();
    const idle = observed('idle');
    idle.subscribed = true;
    const busy = observed('busy', 0, [80, 90]);
    busy.devContainers = { state: 'timeout', refreshing: false, stale: true };
    const failed = observed('failed');
    failed.state = 'timeout';
    failed.stale = true;
    const unscanned = record('unscanned');
    records.push(unscanned);
    await browser.setFavorite([busy], true);
    changes.fire();
    expect(browser.records('all')).toHaveLength(4);
    expect(browser.records('favorites')).toEqual([busy]);
    expect(browser.records('subscribed')).toEqual([idle]);
    expect(browser.records('idle')).toEqual([idle]);
    expect(browser.records('errors')).toEqual([failed]);
    expect(browser.records('stale')).toEqual([failed]);
    browser.setFilter('favorites');
    expect(browser.message).toBe('Favorite hosts · 1 / 4 hosts');
    browser.setFilter('all');
    expect(browser.message).toBe('All hosts · 4 / 4 hosts');
    expect(browser.summary(busy).idleCount).toBe(0);
    expect(browser.summary(failed).idleCount).toBeNull();
    expect(browser.summary(unscanned).outdated).toBe(false);
  });

  it.each<HostState>(['partial', 'unhealthy', 'unreachable', 'timeout', 'authError', 'hostKeyError', 'unsupported', 'error', 'missingConfig'])(
    'includes %s in NPU errors', state => {
      const item = record('failed', state);
      const { browser } = setup([item]);
      expect(browser.records('errors')).toEqual([item]);
    },
  );

  it('ranks any-card idle duration, card count and natural names without changing all-card candidates', async () => {
    configurationValues.set('npuMonitor.idleScope', 'allCards');
    const { browser, observed, history, records } = setup();
    const newest = observed('node-1', 30000);
    const ten = observed('node-10', 60000);
    const two = observed('node-2', 60000);
    const allIdle = observed('node-20', 60000, [0, 0]);
    await browser.setFavorite([newest], true);
    const candidates = history.getCandidates(records, getSettings());
    expect(candidates.map(item => item.alias)).toEqual(['node-20']);
    expect(browser.records('idle')).toEqual([allIdle, two, ten, newest]);
    expect(browser.summary(two)).toMatchObject({ idleCount: 1, longestIdleMs: 60000 });
    expect(history.getCandidates(records, getSettings())).toEqual(candidates);
  });

  it('rejects partial, failed and mismatched observations', () => {
    const { browser, observed, history } = setup();
    const item = observed('alpha');
    for (const change of [
      () => { item.snapshot!.partial = true; },
      () => { item.stale = true; },
      () => { item.snapshot!.collectedAt = now + 1; },
      () => { item.snapshot!.collectedAt = now - 1; },
      () => { history.observe(item.host, undefined, getSettings(), now); },
    ]) {
      item.snapshot!.partial = false;
      item.stale = false;
      item.snapshot!.collectedAt = now;
      change();
      expect(browser.records('idle')).toEqual([]);
      expect(browser.summary(item).idleCount).toBeNull();
      expect(browser.summary(item).description.join(' ')).toContain('?/2 idle NPUs');
    }
  });

  it('invalidates idle history when the host identity or idle policy changes', () => {
    const { browser, observed } = setup();
    const item = observed('alpha');
    item.host.hostname = 'other-host';
    expect(browser.records('idle')).toEqual([]);
    item.host.hostname = '10.20.0.1';
    expect(browser.records('idle')).toEqual([item]);
    configurationValues.set('npuMonitor.idleUtilizationThresholdPercent', 10);
    expect(browser.summary(item).idleCount).toBeNull();
  });

  it('accepts a confirmed idle card when another card has unknown health, but never reports unknown as zero', () => {
    const { browser, observed, history } = setup();
    const item = observed('alpha');
    item.snapshot!.devices[1]!.health = 'UNKNOWN';
    item.snapshot!.devices[1]!.utilizationPercent = undefined;
    history.observe(item.host, item.snapshot, getSettings());
    expect(browser.records('idle')).toEqual([item]);
    expect(browser.summary(item).idleCount).toBe(1);
    item.snapshot!.devices[0]!.health = 'UNKNOWN';
    item.snapshot!.devices[0]!.utilizationPercent = undefined;
    history.observe(item.host, item.snapshot, getSettings());
    expect(browser.summary(item).idleCount).toBeNull();
  });

  it('updates the view at expiry without collection and cleans up timers', () => {
    const { browser, observed, service } = setup();
    const item = observed('alpha');
    item.refreshing = true;
    browser.setFilter('idle');
    const listener = vi.fn();
    browser.onDidChange(listener);
    vi.advanceTimersByTime(120000);
    expect(browser.records()).toEqual([item]);
    vi.advanceTimersByTime(1);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(browser.records()).toEqual([]);
    expect(browser.records('stale')).toEqual([item]);
    expect(browser.message).toContain('No matching hosts');
    expect(service.scanAliases).not.toHaveBeenCalled();
    browser.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('host tree and actions', () => {
  it('filters only host rows, keeps stable IDs and status icons, and displays notes safely', async () => {
    const { browser, service, observed } = setup();
    const item = observed('alpha');
    item.subscribed = true;
    const provider = new NpuTreeProvider(service as never, { state: 'Disabled', tooltip: '' } as never, browser);
    const before = provider.getTreeItem(new HostNode(item));
    const changes = vi.fn();
    provider.onDidChangeTreeData(changes);
    await browser.setFavorite([item], true);
    await browser.setNote(item, '[note](command:bad)');
    browser.setFilter('favorites');
    const after = provider.getTreeItem(new HostNode(item));
    expect(after.label).toBe('★ alpha');
    expect(after.id).toBe(before.id);
    expect(after.iconPath).toEqual(before.iconPath);
    expect(after.contextValue).toBe('npuHostSubscribedFavorite');
    expect(after.description).toContain('1/2 idle NPUs');
    expect((after.tooltip as vscode.MarkdownString).value).toContain('\\[note\\]');
    expect(provider.getChildren()[0]).toBeInstanceOf(McpNode);
    expect(provider.getChildren()).toHaveLength(2);
    expect(browser.message).toBe('Favorite hosts · 1 / 1 hosts');
    await browser.setFavorite([item], false);
    expect(provider.getChildren()).toHaveLength(1);
    expect(changes).toHaveBeenCalled();
    provider.dispose();
  });

  it('deduplicates host selections and uses an unselected context target alone', () => {
    const alpha = record('alpha');
    const beta = record('beta');
    const selected = [new HostNode(alpha), new HostNode(alpha), new StatusNode('status')];
    expect(selectedHostRecords(selected, new HostNode(alpha))).toEqual([alpha]);
    expect(selectedHostRecords([new HostNode(alpha), new HostNode(beta)], new HostNode({ ...alpha }))).toEqual([alpha, beta]);
    expect(selectedHostRecords(selected, new HostNode(beta))).toEqual([beta]);
    expect(selectedHostRecords([new StatusNode('status')])).toEqual([]);
  });

  it('registers filters, multi-host favorites, notes and clearing without changing subscriptions', async () => {
    const alpha = record('alpha');
    const beta = record('beta');
    const { browser, service } = setup([alpha, beta]);
    const view = tree([new HostNode(alpha), new HostNode(beta)]);
    const subscriptions = registerHostBrowserActions(browser, view as never);
    await commands.executeCommand('npuMonitor.favoriteHost', new HostNode(alpha));
    expect(browser.records('favorites')).toEqual([alpha, beta]);
    window.quickPickAction = 'favorites';
    await commands.executeCommand('npuMonitor.filterHosts');
    expect(view.message).toBe('Favorite hosts · 2 / 2 hosts');
    inputBoxValues.push('Benchmark');
    await commands.executeCommand('npuMonitor.editHostNote', new HostNode(alpha));
    expect(browser.preference(alpha).note).toBe('Benchmark');
    inputBoxValues.push(undefined);
    await commands.executeCommand('npuMonitor.editHostNote', new HostNode(alpha));
    expect(browser.preference(alpha).note).toBe('Benchmark');
    inputBoxValues.push('');
    await commands.executeCommand('npuMonitor.editHostNote', new HostNode(alpha));
    expect(browser.preference(alpha).note).toBe('');
    await commands.executeCommand('npuMonitor.unfavoriteHost', new HostNode(beta));
    expect(browser.records()).toEqual([]);
    await commands.executeCommand('npuMonitor.clearHostFilter');
    expect(browser.records()).toHaveLength(2);
    expect(service.scanAliases).not.toHaveBeenCalled();
    expect(service.subscribe).not.toHaveBeenCalled();
    subscriptions.forEach(subscription => subscription.dispose());
  });

  it('shows a save failure without changing persisted favorite state', async () => {
    const alpha = record();
    const { browser, state } = setup([alpha]);
    const subscriptions = registerHostBrowserActions(browser, tree([new HostNode(alpha)]) as never);
    vi.mocked(state.update).mockRejectedValueOnce(new Error('unavailable'));
    await commands.executeCommand('npuMonitor.favoriteHost', new HostNode(alpha));
    expect(errorMessages).toEqual(['Unable to save host preferences.']);
    expect(browser.preference(alpha).favorite).toBe(false);
    subscriptions.forEach(subscription => subscription.dispose());
  });

  it('searches all hosts with address and note matching and reveals a filtered-out result', async () => {
    const alpha = record('node-10');
    const beta = record('node-2');
    const { browser } = setup([alpha, beta]);
    await browser.setNote(alpha, 'BenchMark');
    await browser.setFavorite([alpha], true);
    browser.setFilter('subscribed');
    const view = tree();
    const subscriptions = registerHostBrowserActions(browser, view as never);
    const done = findHost(browser, view as never);
    const picker = quickPicks[0]!;
    expect(picker.items.map(item => item.label)).toEqual(['$(star-full) node-10', 'node-2']);
    expect(picker.matchOnDescription).toBe(true);
    expect(picker.matchOnDetail).toBe(true);
    expect(picker.items[0]?.detail).toBe('10.20.0.1:22 · BenchMark');
    picker.selectedItems = [picker.items[0]!];
    picker.accept();
    await done;
    expect(browser.filter).toBe('all');
    expect(view.message).toBe('All hosts · 2 / 2 hosts');
    expect(view.reveal).toHaveBeenCalledWith(expect.objectContaining({ record: alpha }),
      { select: true, focus: true, expand: true });
    expect(picker.disposed).toBe(true);
    subscriptions.forEach(subscription => subscription.dispose());
  });

  it('cancels search without changing the filter or selection and refreshes open results at expiry', async () => {
    const { browser, observed } = setup();
    const alpha = observed('alpha');
    const selected = [new HostNode(alpha)];
    const view = tree(selected);
    browser.setFilter('favorites');
    const done = findHost(browser, view as never);
    const picker = quickPicks[0]!;
    expect(picker.items[0]?.description).toContain('1/2 idle NPUs');
    vi.advanceTimersByTime(120001);
    expect(picker.items[0]?.description).toContain('Stale');
    expect(picker.items[0]?.description).toContain('?/2 idle NPUs');
    picker.hide();
    await done;
    expect(browser.filter).toBe('favorites');
    expect(view.selection).toBe(selected);
    expect(view.reveal).not.toHaveBeenCalled();
  });

  it('ignores a search result removed by configuration reload and reports reveal failures', async () => {
    const { browser, records, changes } = setup([record('alpha')]);
    const view = tree();
    const done = findHost(browser, view as never);
    const picker = quickPicks[0]!;
    const original = picker.items[0]!;
    records.splice(0);
    changes.fire();
    picker.selectedItems = [original];
    picker.accept();
    expect(view.reveal).not.toHaveBeenCalled();
    expect(picker.items).toEqual([]);
    records.push(record('alpha'));
    changes.fire();
    view.reveal.mockRejectedValueOnce(new Error('tree unavailable'));
    picker.selectedItems = [picker.items[0]!];
    picker.accept();
    await done;
    expect(errorMessages).toEqual(['Unable to reveal the host. Try searching again.']);
    expect(picker.disposed).toBe(true);
  });
});
