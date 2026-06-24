import * as vscode from 'vscode';

import { MonitorService, type ScanProgress } from './monitorService.js';
import { HostNode, NpuTreeProvider, type DeviceNode } from './treeProvider.js';

function aliasesFromSelection(
  treeView: vscode.TreeView<HostNode | DeviceNode>,
  node?: HostNode,
): string[] {
  const selected = treeView.selection
    .filter((item): item is HostNode => item instanceof HostNode)
    .map(item => item.record.host.alias);
  if (node && !selected.includes(node.record.host.alias)) {
    return [node.record.host.alias];
  }
  return selected;
}

async function runWithProgress(
  title: string,
  operation: (
    token: vscode.CancellationToken,
    report: (progress: ScanProgress) => void,
  ) => Promise<void>,
): Promise<void> {
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title,
      cancellable: true,
    },
    async (progress, token) => {
      let previous = 0;
      await operation(token, status => {
        const current = status.total === 0 ? 100 : status.completed / status.total * 100;
        progress.report({
          increment: current - previous,
          message: status.alias + ' (' + status.completed + '/' + status.total + ')',
        });
        previous = current;
      });
    },
  );
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('NPU Monitor', { log: true });
  const service = new MonitorService(context, output);
  const provider = new NpuTreeProvider(service);
  const treeView = vscode.window.createTreeView('npuMonitor.hosts', {
    treeDataProvider: provider,
    canSelectMany: true,
    showCollapseAll: true,
  });

  const updateBadge = (): void => {
    const subscribed = service.getRecords().filter(record => record.subscribed).length;
    treeView.badge = subscribed > 0
      ? { value: subscribed, tooltip: vscode.l10n.t('{0} subscribed hosts', subscribed) }
      : undefined;
  };
  context.subscriptions.push(
    output,
    service,
    provider,
    treeView,
    service.onDidChange(updateBadge),
    vscode.commands.registerCommand('npuMonitor.scanAll', async () => {
      await runWithProgress(
        vscode.l10n.t('Scanning all NPU hosts'),
        (token, report) => service.scanAll(token, report),
      );
    }),
    vscode.commands.registerCommand('npuMonitor.reloadConfig', async () => {
      await service.reloadConfig();
    }),
    vscode.commands.registerCommand('npuMonitor.scanHost', async (node?: HostNode) => {
      const aliases = aliasesFromSelection(treeView, node);
      if (aliases.length === 0 && node) {
        aliases.push(node.record.host.alias);
      }
      if (aliases.length === 0) {
        return;
      }
      await runWithProgress(
        vscode.l10n.t('Scanning selected NPU hosts'),
        (token, report) => service.scanAliases(aliases, token, report),
      );
    }),
    vscode.commands.registerCommand('npuMonitor.scanSelected', async (node?: HostNode) => {
      const aliases = aliasesFromSelection(treeView, node);
      if (aliases.length === 0) {
        void vscode.window.showInformationMessage(
          vscode.l10n.t('Select one or more hosts first.'),
        );
        return;
      }
      await runWithProgress(
        vscode.l10n.t('Scanning selected NPU hosts'),
        (token, report) => service.scanAliases(aliases, token, report),
      );
    }),
    vscode.commands.registerCommand('npuMonitor.subscribeHost', async (node?: HostNode) => {
      if (node) {
        await service.subscribe(node.record.host.alias);
      }
    }),
    vscode.commands.registerCommand('npuMonitor.unsubscribeHost', async (node?: HostNode) => {
      if (node) {
        await service.unsubscribe(node.record.host.alias);
      }
    }),
    vscode.commands.registerCommand('npuMonitor.selectSshConfig', async () => {
      const selected = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        title: vscode.l10n.t('Select SSH configuration'),
      });
      const file = selected?.[0];
      if (!file) {
        return;
      }
      await vscode.workspace.getConfiguration('npuMonitor').update(
        'sshConfigPath',
        file.fsPath,
        vscode.ConfigurationTarget.Global,
      );
      await service.reloadConfig();
    }),
    vscode.commands.registerCommand('npuMonitor.openSettings', async () => {
      await vscode.commands.executeCommand(
        'workbench.action.openSettings',
        '@ext:local.vscode-npu-monitor',
      );
    }),
    vscode.commands.registerCommand('npuMonitor.showOutput', () => output.show()),
    vscode.workspace.onDidChangeConfiguration(async event => {
      if (event.affectsConfiguration('npuMonitor')) {
        await service.reloadConfig(false);
        service.restartTimer();
      }
    }),
  );

  await service.initialize();
  updateBadge();
}

export function deactivate(): void {
  // Disposables registered in the extension context perform all cleanup.
}
