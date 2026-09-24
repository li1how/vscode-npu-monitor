import * as vscode from 'vscode';

import { DevContainerCollector } from './containers/collector.js';
import { ImageCollector } from './containers/images.js';
import { NpuCollector } from './npu/collector.js';
import { evaluateSnapshot } from './npu/idle.js';
import { IdleHistoryStore, type HostHistoryView, type IdleCandidate } from './npu/history.js';
import { getSettings } from './settings.js';
import { currentSshEnvironment, loadSshHosts } from './ssh/config.js';
import { SshRunner } from './ssh/runner.js';
import type { HostRecord, SshHost } from './types.js';

const SUBSCRIPTIONS_KEY = 'npuMonitor.subscriptions';

export interface ScanProgress {
  completed: number;
  total: number;
  alias: string;
}

export class MonitorService implements vscode.Disposable {
  private readonly records = new Map<string, HostRecord>();
  private readonly inFlight = new Map<string, { task: Promise<void>; includeContainers: boolean }>();
  private readonly containerInFlight = new Map<string, Promise<void>>();
  private readonly history: IdleHistoryStore;
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private collector?: NpuCollector;
  private devContainerCollector?: DevContainerCollector;
  private imageCollector?: ImageCollector;
  private pollTimer?: NodeJS.Timeout;
  private automaticScanRunning = false;
  private subscriptions = new Set<string>();

  public readonly onDidChange = this.changeEmitter.event;

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
  ) {
    this.history = new IdleHistoryStore(context.globalState);
    this.subscriptions = new Set(
      context.workspaceState.get<string[]>(SUBSCRIPTIONS_KEY, []),
    );
  }

  public getRecords(): HostRecord[] {
    return [...this.records.values()].sort((left, right) =>
      left.host.alias.localeCompare(right.host.alias, undefined, { numeric: true }),
    );
  }

  public getRecord(alias: string): HostRecord | undefined {
    return this.records.get(alias);
  }

  public getIdleHistory(alias: string, now = Date.now()): HostHistoryView {
    return this.history.getHistory(alias, getSettings(), now, this.records.get(alias)?.host);
  }

  public getIdleCandidates(now = Date.now()): IdleCandidate[] {
    return this.history.getCandidates(this.getRecords(), getSettings(), now);
  }

  public async initialize(): Promise<void> {
    await this.reloadConfig(false);
    const settings = getSettings();
    const records = this.getRecords().filter(record =>
      record.state !== 'missingConfig' && (settings.autoRefreshAllHosts || record.subscribed),
    );
    await this.scanRecords(records);
    this.restartTimer();
  }

  public async reloadConfig(showError = true): Promise<void> {
    const settings = getSettings();
    try {
      const environment = currentSshEnvironment(vscode.env.remoteName);
      const loaded = loadSshHosts(settings, environment);
      const nextAliases = new Set(loaded.hosts.map(host => host.alias));
      for (const host of loaded.hosts) {
        const existing = this.records.get(host.alias);
        this.records.set(host.alias, existing
          ? Object.assign(existing, {
              host,
              subscribed: this.subscriptions.has(host.alias),
              state: existing.state === 'missingConfig' ? 'unknown' : existing.state,
              error: existing.state === 'missingConfig' ? undefined : existing.error,
            })
          : this.newRecord(host));
      }
      for (const [alias, record] of this.records) {
        if (!nextAliases.has(alias)) {
          if (record.subscribed) {
            record.state = 'missingConfig';
            record.error = vscode.l10n.t('The host is no longer present in the SSH configuration.');
            record.refreshing = false;
          } else {
            this.records.delete(alias);
          }
        }
      }
      const runner = new SshRunner({
        executablePath: loaded.sshExecutablePath,
        connectTimeoutSeconds: settings.connectTimeoutSeconds,
      });
      this.imageCollector = new ImageCollector(runner);
      this.devContainerCollector = settings.devContainersEnabled
        ? new DevContainerCollector(runner, settings) : undefined;
      this.collector = new NpuCollector(
        runner,
        settings,
        message => this.log(message),
      );
      this.log('SSH config: ' + loaded.configPath);
      this.log('SSH executable: ' + loaded.sshExecutablePath);
      for (const warning of loaded.warnings) {
        this.log('Warning: ' + warning);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log('Configuration error: ' + message);
      if (showError) {
        void vscode.window.showErrorMessage(
          vscode.l10n.t('Unable to load SSH configuration: {0}', message),
        );
      }
    }
    this.changeEmitter.fire();
  }

  public async scanAll(
    token?: vscode.CancellationToken,
    onProgress?: (progress: ScanProgress) => void,
  ): Promise<void> {
    await this.reloadConfig();
    await this.scanRecords(
      this.getRecords().filter(record => record.state !== 'missingConfig'),
      token,
      onProgress,
    );
  }

  public async scanAliases(
    aliases: string[],
    token?: vscode.CancellationToken,
    onProgress?: (progress: ScanProgress) => void,
  ): Promise<void> {
    await this.reloadConfig();
    const unique = [...new Set(aliases)];
    const records = unique
      .map(alias => this.records.get(alias))
      .filter((record): record is HostRecord =>
        record !== undefined && record.state !== 'missingConfig',
      );
    await this.scanRecords(records, token, onProgress);
  }

  public async scanContainerAliases(aliases: string[]): Promise<void> {
    await this.reloadConfig();
    const records = [...new Set(aliases)].map(alias => this.records.get(alias));
    if (!getSettings().devContainersEnabled) throw new Error('Dev Container collection is disabled');
    if (records.some(record => !record || record.state === 'missingConfig')) {
      throw new Error('Unknown or unavailable SSH host');
    }
    let cursor = 0;
    const workers = Math.min(getSettings().maxConcurrentHosts, records.length);
    await Promise.all(Array.from({ length: workers }, async () => {
      while (cursor < records.length) {
        const record = records[cursor++];
        if (record) await this.scanContainers(record);
      }
    }));
  }

  public async listHostImages(alias: string) {
    await this.reloadConfig();
    const record = this.records.get(alias);
    if (!record || record.state === 'missingConfig' || !this.imageCollector) {
      throw new Error('Unknown or unavailable SSH host');
    }
    return this.imageCollector.list(record.host);
  }

  public async subscribe(alias: string): Promise<void> {
    const record = this.records.get(alias);
    if (!record) {
      return;
    }
    record.subscribed = true;
    record.idleNotified = false;
    record.idleStreak = 0;
    this.subscriptions.add(alias);
    await this.persistSubscriptions();
    this.restartTimer();
    this.changeEmitter.fire();
    await this.scanRecords([record]);
  }

  public async unsubscribe(alias: string): Promise<void> {
    const record = this.records.get(alias);
    if (record) {
      record.subscribed = false;
      record.idleNotified = false;
      record.idleStreak = 0;
    }
    this.subscriptions.delete(alias);
    await this.persistSubscriptions();
    this.restartTimer();
    this.changeEmitter.fire();
  }

  public restartTimer(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    if (this.subscriptions.size === 0 && !getSettings().autoRefreshAllHosts) {
      return;
    }
    const intervalMs = getSettings().pollIntervalSeconds * 1000;
    this.pollTimer = setInterval(() => {
      void this.runAutomaticScan();
    }, intervalMs);
  }

  public dispose(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
    }
    this.changeEmitter.dispose();
  }

  private newRecord(host: SshHost): HostRecord {
    return {
      host,
      state: 'unknown',
      refreshing: false,
      subscribed: this.subscriptions.has(host.alias),
      idleStreak: 0,
      idleNotified: false,
      stale: false,
    };
  }

  private async runAutomaticScan(): Promise<void> {
    if (this.automaticScanRunning) {
      this.log('Automatic scan skipped because the previous scan is still running.');
      return;
    }
    this.automaticScanRunning = true;
    try {
      await this.reloadConfig(false);
      const settings = getSettings();
      const records = this.getRecords().filter(record =>
        record.state !== 'missingConfig' && (settings.autoRefreshAllHosts || record.subscribed),
      );
      await this.scanRecords(records, undefined, undefined, false);
    } finally {
      this.automaticScanRunning = false;
    }
  }

  private async scanRecords(
    records: HostRecord[],
    token?: vscode.CancellationToken,
    onProgress?: (progress: ScanProgress) => void,
    includeContainers: boolean | ((record: HostRecord) => boolean) = true,
  ): Promise<void> {
    const total = records.length;
    let completed = 0;
    let cursor = 0;
    const workerCount = Math.min(getSettings().maxConcurrentHosts, total);
    const worker = async (): Promise<void> => {
      while (cursor < total && !token?.isCancellationRequested) {
        const index = cursor;
        cursor += 1;
        const record = records[index];
        if (!record) {
          continue;
        }
        await this.scanRecord(record, token, typeof includeContainers === 'boolean'
          ? includeContainers : includeContainers(record));
        completed += 1;
        onProgress?.({ completed, total, alias: record.host.alias });
      }
    };
    await Promise.all(Array.from({ length: workerCount }, worker));
    try {
      await this.history.persist(getSettings());
    } catch (error) {
      this.log('Idle history persistence failed: ' + String(error));
    }
  }

  private async scanRecord(
    record: HostRecord,
    token?: vscode.CancellationToken,
    includeContainers = true,
  ): Promise<void> {
    const alias = record.host.alias;
    const existing = this.inFlight.get(alias);
    if (existing) {
      await existing.task;
      if (includeContainers && !existing.includeContainers && !token?.isCancellationRequested) {
        await this.scanContainers(record, token);
      }
      return;
    }
    const task = this.performScan(record, token, includeContainers);
    this.inFlight.set(alias, { task, includeContainers });
    try {
      await task;
    } finally {
      this.inFlight.delete(alias);
    }
  }

  private async performScan(
    record: HostRecord,
    token?: vscode.CancellationToken,
    includeContainers = true,
  ): Promise<void> {
    if (!this.collector) {
      return;
    }
    record.refreshing = true;
    record.error = undefined;
    this.changeEmitter.fire();
    this.log(record.host.alias + ': scan started');
    const result = await this.collector.scan(record.host, token);
    if (token?.isCancellationRequested) {
      record.refreshing = false;
      this.changeEmitter.fire();
      return;
    }

    this.history.observe(record.host, result.snapshot, getSettings());
    if (result.snapshot) {
      const evaluated = evaluateSnapshot(result.snapshot, getSettings());
      record.snapshot = result.snapshot;
      record.stale = false;
      record.error = undefined;
      if (evaluated.state === 'idle') {
        record.idleStreak += 1;
        record.state = record.idleStreak >= getSettings().idleConsecutiveChecks
          ? 'idle'
          : 'busy';
      } else {
        record.state = evaluated.state;
        record.idleStreak = 0;
        record.idleNotified = false;
      }
      this.log(
        record.host.alias + ': ' + record.state + ' via ' +
        result.snapshot.source + ' in ' + result.snapshot.durationMs + ' ms',
      );
      if (record.subscribed && record.state === 'idle' && !record.idleNotified) {
        record.idleNotified = true;
        void this.notifyIdle(record).catch(error => this.log('Idle notification failed: ' + String(error)));
      }
    } else {
      record.state = result.state;
      record.error = result.error;
      record.stale = Boolean(record.snapshot);
      record.idleStreak = 0;
      record.idleNotified = false;
      this.log(record.host.alias + ': ' + result.state + ' - ' + (result.error ?? 'unknown error'));
    }
    this.changeEmitter.fire();
    if (includeContainers && !token?.isCancellationRequested) {
      await this.scanContainers(record, token);
    }
    record.refreshing = false;
    this.changeEmitter.fire();
  }

  private async scanContainers(record: HostRecord, token?: vscode.CancellationToken): Promise<void> {
    const collector = this.devContainerCollector;
    if (!collector || !getSettings().devContainersEnabled || token?.isCancellationRequested) return;
    const alias = record.host.alias;
    const existing = this.containerInFlight.get(alias);
    if (existing) return existing;
    const task = (async () => {
      const previous = record.devContainers;
      record.devContainers = {
        state: previous?.state ?? 'unknown',
        snapshot: previous?.snapshot,
        refreshing: true,
        stale: previous?.stale ?? false,
      };
      this.changeEmitter.fire();
      const containers = await collector.scan(record.host, token);
      if (!token?.isCancellationRequested) {
        record.devContainers = {
          ...containers,
          snapshot: containers.snapshot ?? previous?.snapshot,
          refreshing: false,
          stale: !containers.snapshot && Boolean(previous?.snapshot),
        };
        this.log(alias + ': Dev Containers ' + containers.state +
          (containers.snapshot ? ' (' + containers.snapshot.containers.length + ')' : '') +
          (containers.error ? ' - ' + containers.error : ''));
      } else {
        record.devContainers = previous;
      }
      this.changeEmitter.fire();
    })();
    this.containerInFlight.set(alias, task);
    try {
      await task;
    } finally {
      this.containerInFlight.delete(alias);
    }
  }

  private async notifyIdle(record: HostRecord): Promise<void> {
    const show = vscode.l10n.t('Show NPU Monitor');
    const unsubscribe = vscode.l10n.t('Unsubscribe');
    const choice = await vscode.window.showInformationMessage(
      vscode.l10n.t('{0} is idle.', record.host.alias),
      show,
      unsubscribe,
    );
    if (choice === show) {
      await vscode.commands.executeCommand('npuMonitor.hosts.focus');
    } else if (choice === unsubscribe) {
      await this.unsubscribe(record.host.alias);
    }
  }

  private async persistSubscriptions(): Promise<void> {
    await this.context.workspaceState.update(
      SUBSCRIPTIONS_KEY,
      [...this.subscriptions].sort(),
    );
  }

  private log(message: string): void {
    this.output.appendLine(new Date().toISOString() + ' ' + message);
  }
}
