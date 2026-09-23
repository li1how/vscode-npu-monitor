import * as vscode from 'vscode';

import { filterContainers, invalidWorkspacePathCount } from '../containers/filter.js';
import { devContainerDisplayName } from '../containers/metadata.js';
import type { McpController } from '../mcp/controller.js';
import { isDeviceIdle } from '../npu/idle.js';
import type { MonitorService } from '../monitorService.js';
import { getSettings } from '../settings.js';
import type { DevContainer, DevContainerState, HostRecord, HostState, NpuDevice } from '../types.js';
import { McpNode, ContainerNode, DeviceNode, GroupNode, HostNode, StatusNode, type MonitorNode } from './nodes.js';
import { formatDuration } from './idleHistory.js';

function visibleContainers(record: HostRecord): DevContainer[] {
  return filterContainers(record.devContainers?.snapshot?.containers ?? [], getSettings());
}

function containerGroupLabel(): string {
  return getSettings().containerFilterMode === 'all' ? vscode.l10n.t('Containers') : 'Dev Containers';
}

function containerStateText(state: DevContainerState): string {
  switch (state) {
    case 'ready': return vscode.l10n.t('Scan succeeded');
    case 'missingDocker': return vscode.l10n.t('Docker is not installed');
    case 'permissionDenied': return vscode.l10n.t('Docker access denied');
    case 'daemonUnavailable': return vscode.l10n.t('Docker daemon unavailable');
    default: return stateText(state);
  }
}

function runtimeStateText(state: string): string {
  switch (state) {
    case 'running': return vscode.l10n.t('Running');
    case 'exited': return vscode.l10n.t('Exited');
    case 'created': return vscode.l10n.t('Created');
    case 'paused': return vscode.l10n.t('Paused');
    case 'restarting': return vscode.l10n.t('Restarting');
    case 'removing': return vscode.l10n.t('Removing');
    case 'dead': return vscode.l10n.t('Dead');
    default: return state;
  }
}

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

  public constructor(private readonly service: MonitorService, private readonly mcp?: McpController) {
    this.serviceSubscription = service.onDidChange(() => this.changeEmitter.fire(undefined));
  }

  public refresh(): void { this.changeEmitter.fire(undefined); }

  public getChildren(element?: MonitorNode): MonitorNode[] {
    if (!element) {
      return [...(this.mcp ? [new McpNode(this.mcp.state, this.mcp.tooltip)] : []),
        ...this.service.getRecords().map(record => new HostNode(record))];
    }
    if (element instanceof HostNode) {
      if (getSettings().devContainersEnabled) {
        return [new GroupNode(element.record, 'npu'), new GroupNode(element.record, 'containers')];
      }
      return (element.record.snapshot?.devices ?? []).map(
        device => new DeviceNode(element.record, device),
      );
    }
    if (element instanceof GroupNode) {
      if (element.kind === 'npu') {
        const devices = element.record.snapshot?.devices ?? [];
        return devices.length ? devices.map(device => new DeviceNode(element.record, device))
          : [new StatusNode(stateText(element.record.state))];
      }
      const record = element.record.devContainers;
      const containers = visibleContainers(element.record);
      const nameCounts = new Map<string, number>();
      for (const container of containers) {
        const name = devContainerDisplayName(container);
        nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
      }
      const children: MonitorNode[] = containers.map(container => new ContainerNode(
        element.record, container, (nameCounts.get(devContainerDisplayName(container)) ?? 0) > 1,
      ));
      if (!record || record.state !== 'ready') {
        children.unshift(new StatusNode(containerStateText(record?.state ?? 'unknown')));
      } else if (!children.length) {
        const settings = getSettings();
        const unfiltered = record.snapshot?.containers ?? [];
        const hasDevContainers = unfiltered.some(container => container.isDevContainer);
        children.push(new StatusNode(settings.containerFilterMode === 'all'
          ? vscode.l10n.t('No containers found')
          : hasDevContainers ? vscode.l10n.t('No containers match the current filter')
          : vscode.l10n.t('No Dev Containers found')));
      }
      const invalidPaths = invalidWorkspacePathCount(getSettings());
      if (invalidPaths) {
        children.unshift(new StatusNode(vscode.l10n.t(
          'Invalid workspace paths: {0}. Use absolute Linux paths.', invalidPaths)));
      }
      return children;
    }
    return [];
  }

  public getParent(element: MonitorNode): MonitorNode | undefined {
    if (element instanceof GroupNode) return new HostNode(element.record);
    if (element instanceof DeviceNode) return getSettings().devContainersEnabled
      ? new GroupNode(element.record, 'npu') : new HostNode(element.record);
    if (element instanceof ContainerNode) return new GroupNode(element.record, 'containers');
    return undefined;
  }

  public getTreeItem(element: MonitorNode): vscode.TreeItem {
    if (element instanceof McpNode) {
      const item = new vscode.TreeItem('MCP');
      item.id = 'npu-monitor:mcp';
      item.contextValue = 'npuMonitorMcp';
      item.description = element.state;
      item.tooltip = element.tooltip;
      item.iconPath = new vscode.ThemeIcon('plug');
      item.command = { command: 'npuMonitor.mcpMenu', title: 'MCP' };
      return item;
    }
    if (element instanceof GroupNode) {
      return this.groupTreeItem(element);
    }
    if (element instanceof ContainerNode) {
      return this.containerTreeItem(element);
    }
    if (element instanceof StatusNode) {
      return new vscode.TreeItem(element.text);
    }
    return element instanceof HostNode
      ? this.hostTreeItem(element.record)
      : this.deviceTreeItem(element.record, element.device);
  }

  private groupTreeItem(node: GroupNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.kind === 'npu' ? 'NPU' : containerGroupLabel(),
      vscode.TreeItemCollapsibleState.Expanded);
    item.id = 'group:' + node.record.host.alias + ':' + node.kind;
    item.contextValue = 'npuMonitorGroup';
    if (node.kind === 'npu') {
      item.description = stateText(node.record.state) +
        (node.record.stale ? ' · ' + vscode.l10n.t('Stale') : '');
      item.iconPath = new vscode.ThemeIcon('circuit-board');
      return item;
    }
    const record = node.record.devContainers;
    item.description = record?.refreshing ? stateText('refreshing')
      : record?.state === 'ready' ? String(visibleContainers(node.record).length)
      : containerStateText(record?.state ?? 'unknown');
    if (record?.stale) {
      item.description += ' · ' + vscode.l10n.t('Stale');
    }
    item.iconPath = new vscode.ThemeIcon(record?.refreshing ? 'sync~spin'
      : record && record.state !== 'ready' && record.state !== 'unknown' ? 'warning' : 'package');
    const tooltip = new vscode.MarkdownString();
    tooltip.appendText(containerStateText(record?.state ?? 'unknown'));
    if (record?.snapshot) {
      tooltip.appendText('\n' + vscode.l10n.t('Updated: {0}', new Date(record.snapshot.collectedAt).toLocaleString()));
    }
    if (record?.error) {
      tooltip.appendText('\n' + record.error);
    }
    item.tooltip = tooltip;
    return item;
  }

  private containerTreeItem(node: ContainerNode): vscode.TreeItem {
    const container = node.container;
    const name = devContainerDisplayName(container);
    const item = new vscode.TreeItem(name);
    item.id = 'container:' + node.record.host.alias + ':' + container.id;
    item.contextValue = container.state === 'running' &&
      node.record.devContainers?.state === 'ready' && !node.record.devContainers.stale
      ? 'npuDevContainerRunning' : 'npuDevContainer';
    item.description = runtimeStateText(container.state) +
      (node.record.devContainers?.stale ? ' · ' + vscode.l10n.t('Stale') : '');
    if (node.duplicateName) {
      item.description += ' · ' + container.id.slice(0, 12);
    }
    item.iconPath = new vscode.ThemeIcon(container.state === 'running' ? 'vm-running' : 'vm-outline');
    const tooltip = new vscode.MarkdownString();
    const fields = [
      vscode.l10n.t('Docker name: {0}', container.name),
      vscode.l10n.t('Container ID: {0}', container.id),
      vscode.l10n.t('Type: {0}', container.isDevContainer ? 'Dev Container' : vscode.l10n.t('Docker container')),
      vscode.l10n.t('Status: {0}', runtimeStateText(container.state)),
      vscode.l10n.t('Image: {0}', container.image),
      vscode.l10n.t('Workspace folder: {0}', container.workspaceFolder ?? '-'),
      vscode.l10n.t('Container workspace folder: {0}', container.containerWorkspaceFolder ?? '-'),
      vscode.l10n.t('Configuration file: {0}', container.configFile ?? '-'),
      vscode.l10n.t('Created: {0}', container.createdAt),
      vscode.l10n.t('Started: {0}', container.startedAt ?? '-'),
    ];
    if (node.record.devContainers?.snapshot) {
      fields.push(vscode.l10n.t('Updated: {0}',
        new Date(node.record.devContainers.snapshot.collectedAt).toLocaleString()));
    }
    tooltip.appendText(fields.join('\n'));
    item.tooltip = tooltip;
    return item;
  }

  public dispose(): void {
    this.serviceSubscription.dispose();
    this.changeEmitter.dispose();
  }

  private hostTreeItem(record: HostRecord): vscode.TreeItem {
    const item = new vscode.TreeItem(
      record.host.alias,
      getSettings().devContainersEnabled || record.snapshot?.devices.length
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    const source = record.snapshot?.source === 'exporter' ? 'Exporter' : 'npu-smi';
    const state = record.refreshing ? stateText('refreshing') : stateText(record.state);
    item.description = record.snapshot
      ? state + ' · ' + record.snapshot.devices.length + ' NPU · ' + source
      : state;
    if (record.snapshot) {
      const now = Date.now();
      const fresh = !record.stale && now >= record.snapshot.collectedAt && now - record.snapshot.collectedAt <=
        getSettings().pollIntervalSeconds * 2000;
      const history = this.service.getIdleHistory(record.host.alias, now);
      const ids = new Set(record.snapshot.devices.map(device => device.id));
      const idleCards = fresh ? history.cards.filter(card => ids.has(card.id) && card.idleSince !== null) : [];
      item.description += ' · ' + vscode.l10n.t('{0}/{1} idle NPUs',
        idleCards.length, record.snapshot.devices.length);
      if (idleCards.length) {
        const longest = Math.min(...idleCards.map(card => card.idleSince!));
        item.description += ' · ' + vscode.l10n.t('Longest idle: {0}', formatDuration(now - longest));
      }
      item.description += ' · ' + new Date(record.snapshot.collectedAt).toLocaleTimeString();
    }
    if (getSettings().devContainersEnabled && record.devContainers?.snapshot) {
      item.description += ' · ' + visibleContainers(record).length + ' ' + containerGroupLabel() +
        (record.devContainers.stale ? ' · ' + vscode.l10n.t('Stale') : '');
    }
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
    const now = Date.now();
    const history = this.service.getIdleHistory(record.host.alias, now).cards.find(card => card.id === device.id);
    const idleSince = record.stale ? null : history?.idleSince ?? null;
    const details = [
      formatNumber(device.utilizationPercent, '%'),
      device.hbmUsedMb !== undefined && device.hbmTotalMb !== undefined
        ? Math.round(device.hbmUsedMb) + '/' + Math.round(device.hbmTotalMb) + ' MB'
        : undefined,
      formatNumber(device.temperatureC, '°C'),
      vscode.l10n.t('{0} processes', processCount),
      idleSince === null ? undefined : vscode.l10n.t('Idle for {0}', formatDuration(now - idleSince)),
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
    if (history?.observedAt !== null && history?.observedAt !== undefined) {
      tooltip.appendMarkdown('  \n' + vscode.l10n.t('Updated: {0}',
        new Date(history.observedAt).toLocaleString()));
    }
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
