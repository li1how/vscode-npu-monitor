import * as vscode from 'vscode';

import type { MonitorService } from '../monitorService.js';
import type { HostHistoryView } from '../npu/history.js';
import { getSettings } from '../settings.js';
import type { HostRecord, HostState } from '../types.js';
import { formatDuration } from './idleHistory.js';

export type HostFilter = 'all' | 'favorites' | 'subscribed' | 'idle' | 'errors' | 'stale';
export const HOST_FILTERS: readonly HostFilter[] = ['all', 'favorites', 'subscribed', 'idle', 'errors', 'stale'];
const PREFERENCES_KEY = 'npuMonitor.hostPreferences.v1';

interface HostPreference { favorite: boolean; note: string }
type BrowserService = Pick<MonitorService, 'getRecords' | 'getIdleHistory' | 'onDidChange'>;

export function hostFilterLabel(filter: HostFilter): string {
  switch (filter) {
    case 'all': return vscode.l10n.t('All hosts');
    case 'favorites': return vscode.l10n.t('Favorite hosts');
    case 'subscribed': return vscode.l10n.t('Subscribed hosts');
    case 'idle': return vscode.l10n.t('Hosts with idle NPUs');
    case 'errors': return vscode.l10n.t('NPU errors');
    case 'stale': return vscode.l10n.t('Stale NPU data');
  }
}

export function hostStateText(state: HostState): string {
  const values: Record<HostState, string> = {
    unknown: vscode.l10n.t('Not scanned'), refreshing: vscode.l10n.t('Refreshing'),
    idle: vscode.l10n.t('Idle'), busy: vscode.l10n.t('Busy'),
    partial: vscode.l10n.t('Partial data'), unhealthy: vscode.l10n.t('Unhealthy'),
    unreachable: vscode.l10n.t('Unreachable'), timeout: vscode.l10n.t('Timed out'),
    authError: vscode.l10n.t('Authentication failed'), hostKeyError: vscode.l10n.t('Host key error'),
    unsupported: vscode.l10n.t('No collector'), error: vscode.l10n.t('Error'),
    missingConfig: vscode.l10n.t('Missing configuration'),
  };
  return values[state];
}

export interface NpuSummary {
  outdated: boolean;
  idleCount: number | null;
  longestIdleMs: number | null;
  description: string[];
}

export function summarizeNpu(record: HostRecord, history: HostHistoryView, now = Date.now()): NpuSummary {
  const snapshot = record.snapshot;
  const fresh = Boolean(snapshot && !record.stale && now >= snapshot.collectedAt &&
    now - snapshot.collectedAt <= getSettings().pollIntervalSeconds * 2000);
  const outdated = Boolean(snapshot && !fresh);
  const cards = new Map(history.cards.map(card => [card.id, card]));
  const usable = fresh && record.state !== 'missingConfig' && snapshot &&
    !snapshot.partial && snapshot.devices.length > 0;
  const currentCards = usable ? snapshot.devices.map(device => cards.get(device.id)) : [];
  const idleCards = usable ? currentCards.flatMap(card => {
    return card?.observedAt === snapshot.collectedAt && card.state === 'idle' &&
      card.idleSince !== null && card.idleSince <= snapshot.collectedAt ? [card] : [];
  }) : [];
  const allKnown = usable && currentCards.every(card => card?.observedAt === snapshot.collectedAt && card.state !== 'unknown');
  const idleCount = idleCards.length > 0 || allKnown ? idleCards.length : null;
  const longestIdleMs = idleCards.length ? now - Math.min(...idleCards.map(card => card.idleSince!)) : null;
  const description: string[] = [];
  if (record.refreshing || outdated || (record.state !== 'idle' && record.state !== 'busy')) {
    description.push(hostStateText(record.refreshing ? 'refreshing' : record.state));
  }
  if (outdated) description.push(vscode.l10n.t('Stale'));
  if (snapshot) {
    description.push(vscode.l10n.t('{0}/{1} idle NPUs', idleCount ?? '?', snapshot.devices.length));
    if (longestIdleMs !== null) description.push(vscode.l10n.t('Longest idle: {0}', formatDuration(longestIdleMs)));
    description.push(new Date(snapshot.collectedAt).toLocaleTimeString());
  }
  return { outdated, idleCount, longestIdleMs, description };
}

function preferenceKey(record: HostRecord): string {
  return JSON.stringify([record.host.configPath, record.host.alias]);
}

export class HostBrowser implements vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private readonly serviceSubscription: vscode.Disposable;
  private expiryTimer?: ReturnType<typeof setTimeout>;
  private pending: Promise<void> = Promise.resolve();
  private currentFilter: HostFilter = 'all';
  private disposed = false;
  public readonly onDidChange = this.changeEmitter.event;

  public constructor(private readonly service: BrowserService, private readonly state: vscode.Memento) {
    this.serviceSubscription = service.onDidChange(() => this.refresh());
    this.scheduleExpiry();
  }

  public get filter(): HostFilter { return this.currentFilter; }

  public setFilter(filter: HostFilter): void {
    this.currentFilter = filter;
    this.refresh();
  }

  public preference(record: HostRecord): HostPreference {
    const value = this.state.get<Record<string, HostPreference>>(PREFERENCES_KEY)?.[preferenceKey(record)];
    return { favorite: value?.favorite === true, note: typeof value?.note === 'string' ? value.note : '' };
  }

  public setFavorite(records: readonly HostRecord[], favorite: boolean): Promise<void> {
    return this.save(records, { favorite });
  }

  public setNote(record: HostRecord, note: string): Promise<void> {
    return this.save([record], { note: note.trim() });
  }

  private save(records: readonly HostRecord[], patch: Partial<HostPreference>): Promise<void> {
    this.pending = this.pending.catch(() => {}).then(async () => {
      const saved = { ...this.state.get<Record<string, HostPreference>>(PREFERENCES_KEY) };
      for (const record of records) {
        const key = preferenceKey(record);
        const next = { ...this.preference(record), ...patch };
        if (!next.favorite && !next.note) delete saved[key];
        else saved[key] = next;
      }
      await this.state.update(PREFERENCES_KEY, saved);
      if (!this.disposed) this.refresh();
    });
    return this.pending;
  }

  public summary(record: HostRecord, now = Date.now()): NpuSummary {
    return summarizeNpu(record, this.service.getIdleHistory(record.host.alias, now, false), now);
  }

  public records(filter: HostFilter = this.filter, now = Date.now()): HostRecord[] {
    const summaries = new Map<HostRecord, NpuSummary>();
    const summary = (record: HostRecord): NpuSummary => {
      if (!summaries.has(record)) summaries.set(record, this.summary(record, now));
      return summaries.get(record)!;
    };
    return this.service.getRecords().filter(record => {
      switch (filter) {
        case 'all': return true;
        case 'favorites': return this.preference(record).favorite;
        case 'subscribed': return record.subscribed;
        case 'idle': return (summary(record).idleCount ?? 0) > 0;
        case 'errors': return !['unknown', 'refreshing', 'idle', 'busy'].includes(record.state);
        case 'stale': return summary(record).outdated;
      }
    }).sort((left, right) => {
      if (filter === 'idle') {
        return (summary(right).longestIdleMs! - summary(left).longestIdleMs!) ||
          (summary(right).idleCount! - summary(left).idleCount!) || this.compareNames(left, right);
      }
      return Number(this.preference(right).favorite) - Number(this.preference(left).favorite) ||
        this.compareNames(left, right);
    });
  }

  public get message(): string {
    const count = this.records().length;
    const summary = vscode.l10n.t('{0} · {1} / {2} hosts', hostFilterLabel(this.filter), count, this.service.getRecords().length);
    return count ? summary : summary + '\n' + (this.filter === 'all'
      ? vscode.l10n.t('No configured hosts.')
      : vscode.l10n.t('No matching hosts. Clear the filter to show all hosts.'));
  }

  private compareNames(left: HostRecord, right: HostRecord): number {
    return left.host.alias.localeCompare(right.host.alias, undefined, { numeric: true });
  }

  private refresh(): void {
    if (this.disposed) return;
    this.scheduleExpiry();
    this.changeEmitter.fire();
  }

  private scheduleExpiry(): void {
    clearTimeout(this.expiryTimer);
    const now = Date.now();
    const boundaries = this.service.getRecords().flatMap(record => {
      const snapshot = record.snapshot;
      if (!snapshot || record.stale) return [];
      return [snapshot.collectedAt, snapshot.collectedAt + getSettings().pollIntervalSeconds * 2000 + 1]
        .filter(time => time > now);
    });
    if (boundaries.length) {
      this.expiryTimer = setTimeout(() => this.refresh(), Math.min(Math.min(...boundaries) - now, 2_147_483_647));
      this.expiryTimer.unref();
    }
  }

  public dispose(): void {
    this.disposed = true;
    clearTimeout(this.expiryTimer);
    this.serviceSubscription.dispose();
    this.changeEmitter.dispose();
  }
}
