import { createHash } from 'node:crypto';

import type * as vscode from 'vscode';

import { isDeviceIdle } from './idle.js';
import type { HostRecord, HostSnapshot, MonitorSettings, SshHost } from '../types.js';

const HISTORY_KEY = 'npuMonitor.idleHistory.v1';
export const HISTORY_BUCKET_MS = 15 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export type HistoryState = 'idle' | 'busy' | 'mixed' | 'unknown';

type Bin = [number, HistoryState];

interface StoredCard {
  state: Exclude<HistoryState, 'mixed'>;
  observedAt: number;
  idleSince: number | null;
  bins: Bin[];
}

interface StoredHost {
  identity: string;
  policy: string;
  cards: Record<string, StoredCard>;
}

interface StoredHistory {
  version: 1;
  hosts: Record<string, StoredHost>;
}

export interface CardHistoryView {
  id: string;
  state: Exclude<HistoryState, 'mixed'>;
  observedAt: number | null;
  idleSince: number | null;
  bins: Bin[];
}

export interface HostHistoryView {
  alias: string;
  retentionDays: number;
  cards: CardHistoryView[];
}

export interface IdleCandidate {
  alias: string;
  durationMs: number;
  idleDevices: number;
  deviceCount: number;
  deviceId: string | null;
  observedAt: number;
  collectedAt: number;
  ageSeconds: number;
  maxAgeSeconds: number;
  validUntil: number;
  outdated: false;
}

function identity(host: SshHost): string {
  return createHash('sha256').update(JSON.stringify([
    host.alias, host.hostname, host.user, host.port, host.configPath,
  ])).digest('hex');
}

function policy(settings: MonitorSettings): string {
  return JSON.stringify([settings.idleRequireNoProcesses, settings.idleUtilizationThresholdPercent]);
}

function validStore(value: unknown): value is StoredHistory {
  return typeof value === 'object' && value !== null &&
    (value as StoredHistory).version === 1 &&
    typeof (value as StoredHistory).hosts === 'object' &&
    (value as StoredHistory).hosts !== null;
}

function combine(previous: HistoryState, next: HistoryState): HistoryState {
  if (previous === 'unknown' || next === 'unknown') return 'unknown';
  if (previous === next) return previous;
  return 'mixed';
}

function putBin(card: StoredCard, time: number, state: HistoryState): void {
  const start = Math.floor(time / HISTORY_BUCKET_MS) * HISTORY_BUCKET_MS;
  const last = card.bins.at(-1);
  if (last?.[0] === start) {
    last[1] = combine(last[1], state);
  } else if (!last || last[0] < start) {
    card.bins.push([start, state]);
  }
}

function currentCard(card: StoredCard, settings: MonitorSettings, now: number): boolean {
  return card.state === 'idle' && card.idleSince !== null &&
    now >= card.observedAt && now - card.observedAt <= settings.pollIntervalSeconds * 2000;
}

export class IdleHistoryStore {
  private readonly data: StoredHistory;
  private pending: Promise<void> = Promise.resolve();

  public constructor(private readonly state: vscode.Memento) {
    const saved = state.get<unknown>(HISTORY_KEY);
    this.data = validStore(saved) ? structuredClone(saved) : { version: 1, hosts: {} };
  }

  public observe(
    host: SshHost,
    snapshot: HostSnapshot | undefined,
    settings: MonitorSettings,
    now = snapshot?.collectedAt ?? Date.now(),
  ): void {
    if (!Number.isFinite(now) || now < 0) return;
    const hostIdentity = identity(host);
    const hostPolicy = policy(settings);
    let entry = this.data.hosts[host.alias];
    if (!entry || entry.identity !== hostIdentity || entry.policy !== hostPolicy) {
      entry = { identity: hostIdentity, policy: hostPolicy, cards: {} };
      this.data.hosts[host.alias] = entry;
    }
    const usable = snapshot && !snapshot.partial && snapshot.devices.length > 0;
    const devices = new Map(usable ? snapshot.devices.map(device => [device.id, device]) : []);
    const ids = new Set([...Object.keys(entry.cards), ...devices.keys()]);
    for (const id of ids) {
      const device = devices.get(id);
      const next: StoredCard['state'] = device?.health === 'OK' &&
        device.utilizationPercent !== undefined
        ? isDeviceIdle(device, settings) ? 'idle' : 'busy'
        : 'unknown';
      let card = entry.cards[id];
      if (!card) {
        card = { state: 'unknown', observedAt: now, idleSince: null, bins: [] };
        entry.cards[id] = card;
      }
      if (now < card.observedAt) continue;
      if (now - card.observedAt > settings.pollIntervalSeconds * 2000) {
        putBin(card, card.observedAt + settings.pollIntervalSeconds * 2000, 'unknown');
        card.idleSince = null;
      }
      card.idleSince = next === 'idle'
        ? card.state === 'idle' && card.idleSince !== null ? card.idleSince : now
        : null;
      card.state = next;
      card.observedAt = now;
      putBin(card, now, next);
      card.bins = card.bins.filter(([start]) => start + HISTORY_BUCKET_MS > now - settings.idleHistoryRetentionDays * DAY_MS);
    }
    this.prune(settings, now);
  }

  public getHistory(alias: string, settings: MonitorSettings, now = Date.now(), host?: SshHost): HostHistoryView {
    const saved = this.data.hosts[alias];
    const entry = saved && (!host || saved.identity === identity(host)) && saved.policy === policy(settings)
      ? saved : undefined;
    const cutoff = now - settings.idleHistoryRetentionDays * DAY_MS;
    return {
      alias,
      retentionDays: settings.idleHistoryRetentionDays,
      cards: Object.entries(entry?.cards ?? {}).sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
        .map(([id, card]) => ({
          id,
          state: now < card.observedAt || now - card.observedAt > settings.pollIntervalSeconds * 2000
            ? 'unknown' : card.state,
          observedAt: card.observedAt,
          idleSince: currentCard(card, settings, now) ? card.idleSince : null,
          bins: card.bins.filter(([start]) => start + HISTORY_BUCKET_MS > cutoff).map(bin => [...bin] as Bin),
        })),
    };
  }

  public getCandidates(records: HostRecord[], settings: MonitorSettings, now = Date.now()): IdleCandidate[] {
    const candidates: IdleCandidate[] = [];
    for (const record of records) {
      const snapshot = record.snapshot;
      if (!snapshot || snapshot.partial || record.stale || record.refreshing ||
        now < snapshot.collectedAt || now - snapshot.collectedAt > settings.pollIntervalSeconds * 2000) continue;
      const entry = this.data.hosts[record.host.alias];
      if (!entry || entry.identity !== identity(record.host) || entry.policy !== policy(settings)) continue;
      const idleCards = snapshot.devices.filter(device => {
        const card = entry.cards[device.id];
        return card && card.observedAt === snapshot.collectedAt && currentCard(card, settings, now);
      });
      if (idleCards.length === 0 || (settings.idleScope === 'allCards' && idleCards.length !== snapshot.devices.length)) continue;
      const sorted = idleCards.map(device => ({ id: device.id, since: entry.cards[device.id]!.idleSince! }))
        .sort((a, b) => a.since - b.since || a.id.localeCompare(b.id, undefined, { numeric: true }));
      const since = settings.idleScope === 'allCards' ? sorted.at(-1)! : sorted[0]!;
      candidates.push({
        alias: record.host.alias,
        durationMs: now - since.since,
        idleDevices: idleCards.length,
        deviceCount: snapshot.devices.length,
        deviceId: settings.idleScope === 'anyCard' ? since.id : null,
        observedAt: snapshot.collectedAt,
        collectedAt: snapshot.collectedAt,
        ageSeconds: (now - snapshot.collectedAt) / 1000,
        maxAgeSeconds: settings.pollIntervalSeconds * 2,
        validUntil: snapshot.collectedAt + settings.pollIntervalSeconds * 2000,
        outdated: false,
      });
    }
    return candidates.sort((a, b) => b.durationMs - a.durationMs ||
      b.idleDevices - a.idleDevices || a.alias.localeCompare(b.alias, undefined, { numeric: true }));
  }

  public persist(settings: MonitorSettings, now = Date.now()): Promise<void> {
    this.prune(settings, now);
    const copy = structuredClone(this.data);
    this.pending = this.pending.catch(() => {}).then(() => this.state.update(HISTORY_KEY, copy));
    return this.pending;
  }

  private prune(settings: MonitorSettings, now: number): void {
    const cutoff = now - settings.idleHistoryRetentionDays * DAY_MS;
    for (const [alias, host] of Object.entries(this.data.hosts)) {
      for (const [id, card] of Object.entries(host.cards)) {
        card.bins = card.bins.filter(([start]) => start + HISTORY_BUCKET_MS > cutoff);
        if (card.bins.length === 0 && card.observedAt < cutoff) delete host.cards[id];
      }
      if (Object.keys(host.cards).length === 0) delete this.data.hosts[alias];
    }
  }
}
