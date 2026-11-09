import type { HostHistoryView } from './history.js';
import { isNpuObservationCurrent } from './freshness.js';
import type { HostRecord, MonitorSettings } from '../types.js';

export function currentNpuState(record: HostRecord, history: HostHistoryView, settings: MonitorSettings, now: number) {
  const snapshot = record.snapshot;
  const fresh = Boolean(snapshot && !record.stale && isNpuObservationCurrent(snapshot.collectedAt, settings, now));
  const cards = new Map(history.cards.map(card => [card.id, card]));
  const usable = fresh && record.state !== 'missingConfig' && snapshot &&
    !snapshot.partial && snapshot.devices.length > 0;
  const currentCards = usable ? snapshot.devices.map(device => cards.get(device.id)) : [];
  const idleCards = usable ? currentCards.flatMap(card =>
    card?.observedAt === snapshot.collectedAt && card.state === 'idle' && card.idleSince !== null &&
      card.idleSince <= snapshot.collectedAt ? [card] : []) : [];
  const allKnown = usable && currentCards.every(card => card?.observedAt === snapshot.collectedAt && card.state !== 'unknown');
  return {
    fresh,
    outdated: Boolean(snapshot && !fresh),
    idleCount: idleCards.length > 0 || allKnown ? idleCards.length : null,
    longestIdleMs: idleCards.length ? now - Math.min(...idleCards.map(card => card.idleSince!)) : null,
  };
}
