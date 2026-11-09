import type { Memento } from 'vscode';

import type { HostRecord } from './types.js';

export const HOST_PREFERENCES_KEY = 'npuMonitor.hostPreferences.v1';
export interface HostPreference { favorite: boolean; note: string }

export function hostPreferenceKey(record: HostRecord): string {
  return JSON.stringify([record.host.configPath, record.host.alias]);
}

export function readHostPreference(state: Memento, record: HostRecord): HostPreference {
  const value = state.get<Record<string, HostPreference>>(HOST_PREFERENCES_KEY)?.[hostPreferenceKey(record)];
  return { favorite: value?.favorite === true, note: typeof value?.note === 'string' ? value.note : '' };
}
