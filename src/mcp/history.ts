import { HISTORY_BUCKET_MS } from '../npu/history.js';
import type { MonitorSettings } from '../types.js';
import type { MonitorReader, PageInput } from './queries.js';
import { queryKey } from './queries.js';
import { QueryError, type SnapshotPages, type QueryResult } from './results.js';

export interface HistoryQuery extends PageInput {
  host: string; cards?: string[]; from?: number; to?: number; mode: 'summary' | 'buckets';
}

export function getHistory(service: MonitorReader, settings: MonitorSettings, pages: SnapshotPages, input: HistoryQuery): QueryResult {
  return pages.page(queryKey('get_history', input), input.limit, input.cursor, asOf => {
    const record = service.getRecord(input.host);
    if (!record) throw new QueryError('UNKNOWN_HOST', 'Unknown SSH alias.');
    const oldest = asOf - settings.idleHistoryRetentionDays * 86400000;
    const to = input.to ?? asOf;
    const from = input.from ?? Math.max(oldest, to - 86400000);
    if (from < oldest || to > asOf || from >= to) {
      throw new QueryError('INVALID_RANGE', 'Use from < to within the configured retention period, ending no later than now. Times are Unix milliseconds.');
    }
    const history = service.getIdleHistory(input.host, asOf, true);
    const byId = new Map(history.cards.map(card => [card.id, card]));
    const ids = [...new Set([...byId.keys(), ...(record.snapshot?.devices.map(device => device.id) ?? [])])]
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (input.cards?.some(id => !ids.includes(id))) throw new QueryError('UNKNOWN_CARD', 'Unknown card ID.');
    const selected = ids.filter(id => !input.cards || input.cards.includes(id));
    const totalBuckets = Math.ceil(to / HISTORY_BUCKET_MS) - Math.floor(from / HISTORY_BUCKET_MS);
    const rows: unknown[] = selected.flatMap((id): unknown[] => {
      const card = byId.get(id);
      const bins = (card?.bins ?? []).filter(([start]) => start < to && start + HISTORY_BUCKET_MS > from);
      if (input.mode === 'buckets') return bins.map(([start, state]) => ({ cardId: id, start, state }));
      const counts = { idle: 0, busy: 0, mixed: 0, unknown: 0 };
      for (const [, state] of bins) counts[state]++;
      const observedBuckets = counts.idle + counts.busy + counts.mixed;
      return [{ cardId: id, counts, unobservedBuckets: totalBuckets - bins.length,
        observedBuckets, coverageRatio: totalBuckets ? observedBuckets / totalBuckets : 0,
        current: { state: card?.state ?? 'unknown', observedAt: card?.observedAt ?? null, idleSince: card?.idleSince ?? null } }];
    });
    return { data: { host: input.host, mode: input.mode, range: { from, to, bucketMs: HISTORY_BUCKET_MS },
      retentionDays: history.retentionDays, totalCards: selected.length },
      field: input.mode === 'summary' ? 'cards' : 'buckets', rows };
  });
}
