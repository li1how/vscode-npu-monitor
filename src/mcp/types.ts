import type { HostPreference } from '../hostPreferences.js';
import type { HostHistoryView } from '../npu/history.js';
import type { HostRecord } from '../types.js';

export interface MonitorReader {
  getRecords(): HostRecord[];
  getRecord(alias: string): HostRecord | undefined;
  getIdleHistory(alias: string, now?: number, includeBins?: boolean): HostHistoryView;
  getHostPreference(alias: string): HostPreference;
}

export interface MonitorRefresher {
  refreshAliases(aliases: string[], scope: 'npu' | 'containers' | 'both'): Promise<void>;
}

export type MonitorMcpService = MonitorReader & MonitorRefresher;
