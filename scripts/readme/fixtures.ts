import * as vscode from 'vscode';

import { HOST_PREFERENCES_KEY, hostPreferenceKey, readHostPreference } from '../../src/hostPreferences.js';
import type { MonitorService as ProductionService } from '../../src/monitorService.js';
import type { HostHistoryView, HistoryState } from '../../src/npu/history.js';
import type { HostRecord } from '../../src/types.js';

export const CAPTURE_TIME = Date.UTC(2026, 10, 9, 2, 30);
const BUCKET_MS = 15 * 60 * 1000;
const hosts = [
  { alias: 'ascend-a3-01', idle: 4, model: 'Ascend910B', note: 'Inference pool', minutes: 210 },
  { alias: 'ascend-a3-02', idle: 2, model: 'Ascend910B', note: 'Training / evaluation', minutes: 45 },
  { alias: 'ascend-a5-01', idle: 0, model: 'Ascend950', note: 'Model serving', minutes: 0 },
  { alias: 'ascend-a5-02', idle: 8, model: 'Ascend950', note: 'Available for experiments', minutes: 95 },
];

// This module replaces the service only in the screenshot build. No SSH config,
// collectors, timers or real subscriptions are used by this backend.
export class MonitorService implements Pick<ProductionService, keyof ProductionService> {
  private readonly emitter = new vscode.EventEmitter<void>();
  public readonly onDidChange = this.emitter.event;
  private readonly records: HostRecord[] = hosts.map((spec, index) => ({
    host: {
      alias: spec.alias, hostname: `192.0.2.${index + 10}`, user: 'demo', port: 22,
      identityFiles: [], configPath: '/demo/ssh-config', useAlias: true,
    },
    state: spec.idle ? 'idle' : 'busy', subscribed: index < 2,
    refreshing: false, idleStreak: 1, idleNotified: false, stale: false,
    snapshot: {
      source: 'exporter', partial: false, collectedAt: CAPTURE_TIME, durationMs: 120,
      devices: Array.from({ length: 8 }, (_, id) => ({
        id: String(id), model: spec.model, health: 'OK',
        utilizationPercent: id < spec.idle ? 0 : 76 + id,
        hbmUsedMb: id < spec.idle ? 512 : 43200 + id * 100, hbmTotalMb: 65536,
        temperatureC: id < spec.idle ? 37 : 62, powerW: id < spec.idle ? 85 : 287,
        processCount: id < spec.idle ? 0 : 1,
        processes: id < spec.idle ? [] : [{ pid: String(12000 + id), name: 'python', memoryMb: 42200 }],
      })),
    },
    devContainers: {
      state: 'ready', refreshing: false, stale: false,
      snapshot: {
        collectedAt: CAPTURE_TIME, durationMs: 80,
        containers: ['vllm-ascend-dev', 'benchmark'].slice(0, index === 2 ? 1 : 2).map((name, id) => ({
          id: String(index + 1).repeat(63) + id, isDevContainer: true,
          name, displayName: name, image: 'demo/ascend:latest', state: 'running',
          createdAt: '2026-11-08T00:00:00Z', workspaceFolder: `/home/demo/${name}`,
          containerWorkspaceFolder: `/workspaces/${name}`,
        })),
      },
    },
  }));

  public constructor(private readonly context: vscode.ExtensionContext) {}

  public async initialize(): Promise<void> {
    await this.context.globalState.update(HOST_PREFERENCES_KEY, Object.fromEntries(
      this.records.map((record, index) => [hostPreferenceKey(record), {
        favorite: index === 0, note: hosts[index]!.note,
      }]),
    ));
    this.emitter.fire();
  }

  public getRecords(): HostRecord[] { return this.records; }
  public getRecord(alias: string): HostRecord | undefined {
    return this.records.find(record => record.host.alias === alias);
  }
  public getHostPreference(alias: string) {
    const record = this.getRecord(alias);
    return record ? readHostPreference(this.context.globalState, record) : { favorite: false, note: '' };
  }

  public getIdleHistory(alias: string, now = CAPTURE_TIME, includeBins = true): HostHistoryView {
    const spec = hosts.find(host => host.alias === alias);
    const end = Math.floor(now / BUCKET_MS) * BUCKET_MS;
    return {
      alias, retentionDays: 2,
      cards: !spec ? [] : this.getRecord(alias)!.snapshot!.devices.map((device, id) => {
        const idle = id < spec.idle;
        const minutes = spec.minutes + id * 5;
        const stateAt = (index: number): HistoryState => {
          if (idle && index > 191 - Math.ceil(minutes / 15)) return 'idle';
          if (!idle && index >= 184) return 'busy';
          const phase = (index + id * 7) % 37;
          return phase < 16 ? 'busy' : phase < 33 ? 'idle' : (index + id) % 3 ? 'mixed' : 'unknown';
        };
        return {
          id: device.id, state: idle ? 'idle' : 'busy', observedAt: CAPTURE_TIME,
          idleSince: idle ? CAPTURE_TIME - minutes * 60000 : null,
          bins: includeBins ? Array.from({ length: 192 }, (_, index) =>
            [end - (191 - index) * BUCKET_MS, stateAt(index)] as [number, HistoryState]) : [],
        };
      }),
    };
  }

  public reloadConfig(): Promise<void> { return Promise.resolve(); }
  public restartTimer(): void { /* Screenshot data does not poll. */ }
  public dispose(): void { this.emitter.dispose(); }

  private async rejectCollection(): Promise<never> {
    throw new Error('SSH collection is disabled in README capture.');
  }
  public scanAll: ProductionService['scanAll'] = () => this.rejectCollection();
  public scanAliases: ProductionService['scanAliases'] = () => this.rejectCollection();
  public scanContainerAliases: ProductionService['scanContainerAliases'] = () => this.rejectCollection();
  public refreshAliases: ProductionService['refreshAliases'] = () => this.rejectCollection();
  public subscribe: ProductionService['subscribe'] = () => this.rejectCollection();
  public unsubscribe: ProductionService['unsubscribe'] = () => this.rejectCollection();
}
