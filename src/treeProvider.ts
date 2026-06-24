import * as vscode from 'vscode';

import { isDeviceIdle } from './idle.js';
import type { MonitorService } from './monitorService.js';
import { getSettings } from './settings.js';
import type { HostRecord, HostState, NpuDevice } from './types.js';

export class HostNode {
  public constructor(public readonly record: HostRecord) {}
}

export class DeviceNode {
  public constructor(
    public readonly record: HostRecord,
    public readonly device: NpuDevice,
  ) {}
}

export type MonitorNode = HostNode | DeviceNode;

function stateText(state: HostState): string {
  const values: Record<HostState, string> = {
    unknown: vscode.l10n.t('Not scanned'),
    refreshing: vscode.l10n.t('Refreshing'),
    idle: vscode.l10n.t('Idle'),
    busy: vscode.l10n.t('Busy'),
    partial: vscode.l10n.t('Partial data'),
    unhealthy: vscode.l10n.t('Unhealthy'),
    unreachable: vscode.l10n.t('Unreachable'),
    timeout: vscode.l10n.t('Timed out'),
    authError: vscode.l10n.t('Authentication failed'),
    hostKeyError: vscode.l10n.t('Host key error'),
    unsupported: vscode.l10n.t('No collector'),
    error: vscode.l10n.t('Error'),
    missingConfig: vscode.l10n.t('Missing configuration'),
  };
  return values[state];
}

function stateIcon(record: HostRecord): vscode.ThemeIcon {
  if (record.refreshing) {
    return new vscode.ThemeIcon('sync~spin');
  }
  switch (record.state) {
    case 'idle':
      return new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('testing.iconPassed'));
    case 'busy':
      return new vscode.ThemeIcon('pulse', new vscode.ThemeColor('charts.yellow'));
    case 'partial':
    case 'unhealthy':
      return new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground'));
    case 'unknown':
      return new vscode.ThemeIcon('question');
    default:
      return new vscode.ThemeIcon('error', new vscode.ThemeColor('problemsErrorIcon.foreground'));
  }
}

function formatNumber(value: number | undefined, suffix = ''): string {
  return value === undefined ? '-' : Math.round(value * 10) / 10 + suffix;
}

export class NpuTreeProvider implements vscode.TreeDataProvider<MonitorNode>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<MonitorNode | undefined>();
  private readonly serviceSubscription: vscode.Disposable;

  public readonly onDidChangeTreeData = this.changeEmitter.event;

  public constructor(private readonly service: MonitorService) {
    this.serviceSubscription = service.onDidChange(() => this.changeEmitter.fire(undefined));
  }

  public getChildren(element?: MonitorNode): MonitorNode[] {
    if (!element) {
      return this.service.getRecords().map(record => new HostNode(record));
    }
    if (element instanceof HostNode) {
      return (element.record.snapshot?.devices ?? []).map(
        device => new DeviceNode(element.record, device),
      );
    }
    return [];
  }

  public getTreeItem(element: MonitorNode): vscode.TreeItem {
    return element instanceof HostNode
      ? this.hostTreeItem(element.record)
      : this.deviceTreeItem(element.record, element.device);
  }

  public dispose(): void {
    this.serviceSubscription.dispose();
    this.changeEmitter.dispose();
  }

  private hostTreeItem(record: HostRecord): vscode.TreeItem {
    const item = new vscode.TreeItem(
      record.host.alias,
      record.snapshot?.devices.length
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    const source = record.snapshot?.source === 'exporter' ? 'Exporter' : 'npu-smi';
    const state = record.refreshing ? stateText('refreshing') : stateText(record.state);
    item.description = record.snapshot
      ? state + ' · ' + record.snapshot.devices.length + ' NPU · ' + source
      : state;
    item.iconPath = stateIcon(record);
    item.contextValue = record.subscribed ? 'npuHostSubscribed' : 'npuHostUnsubscribed';
    item.id = 'host:' + record.host.alias;
    const target = record.host.user
      ? record.host.user + '@' + record.host.hostname
      : record.host.hostname;
    const tooltip = new vscode.MarkdownString();
    tooltip.appendMarkdown('**' + record.host.alias + '**  \n');
    tooltip.appendMarkdown(vscode.l10n.t('Target: {0}', target) + '  \n');
    tooltip.appendMarkdown(vscode.l10n.t('Status: {0}', state) + '  \n');
    tooltip.appendMarkdown(vscode.l10n.t(
      'Subscribed: {0}',
      record.subscribed ? vscode.l10n.t('Yes') : vscode.l10n.t('No'),
    ));
    if (record.snapshot) {
      tooltip.appendMarkdown('  \n' + vscode.l10n.t(
        'Updated: {0}',
        new Date(record.snapshot.collectedAt).toLocaleString(),
      ));
    }
    if (record.error) {
      tooltip.appendMarkdown('  \n\n' + record.error);
    }
    item.tooltip = tooltip;
    return item;
  }

  private deviceTreeItem(record: HostRecord, device: NpuDevice): vscode.TreeItem {
    const item = new vscode.TreeItem('NPU ' + device.id);
    const processCount = device.processCount ?? device.processes.length;
    const details = [
      formatNumber(device.utilizationPercent, '%'),
      device.hbmUsedMb !== undefined && device.hbmTotalMb !== undefined
        ? Math.round(device.hbmUsedMb) + '/' + Math.round(device.hbmTotalMb) + ' MB'
        : undefined,
      formatNumber(device.temperatureC, '°C'),
      vscode.l10n.t('{0} processes', processCount),
    ].filter((value): value is string => Boolean(value));
    item.description = details.join(' · ');
    item.contextValue = 'npuDevice';
    item.iconPath = device.health !== 'OK'
      ? new vscode.ThemeIcon('error', new vscode.ThemeColor('problemsErrorIcon.foreground'))
      : isDeviceIdle(device, getSettings())
        ? new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('testing.iconPassed'))
        : new vscode.ThemeIcon('pulse', new vscode.ThemeColor('charts.yellow'));
    const tooltip = new vscode.MarkdownString();
    tooltip.appendMarkdown('**NPU ' + device.id + '**  \n');
    tooltip.appendMarkdown(vscode.l10n.t('Model: {0}', device.model ?? '-') + '  \n');
    tooltip.appendMarkdown(vscode.l10n.t('Health: {0}', device.health) + '  \n');
    tooltip.appendMarkdown(vscode.l10n.t(
      'Utilization: {0}',
      formatNumber(device.utilizationPercent, '%'),
    ));
    if (device.processes.length > 0) {
      tooltip.appendMarkdown('  \n\n' + vscode.l10n.t('Processes:') + '  \n');
      for (const process of device.processes) {
        tooltip.appendMarkdown(
          '- ' + process.pid + ' ' + (process.name ?? '') +
          (process.memoryMb === undefined ? '' : ' (' + process.memoryMb + ' MB)') + '\n',
        );
      }
    }
    item.tooltip = tooltip;
    return item;
  }
}
