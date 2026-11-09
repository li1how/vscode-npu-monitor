import type { MonitorSettings } from '../types.js';

type PollSettings = Pick<MonitorSettings, 'pollIntervalSeconds'>;

export function npuMaxAgeMs(settings: PollSettings): number {
  return settings.pollIntervalSeconds * 2000;
}

export function isNpuObservationCurrent(collectedAt: number, settings: PollSettings, now: number): boolean {
  return now >= collectedAt && now - collectedAt <= npuMaxAgeMs(settings);
}
