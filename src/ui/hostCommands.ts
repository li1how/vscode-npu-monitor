import * as vscode from 'vscode';

import type { MonitorService, ScanProgress } from '../monitorService.js';
import { getSettings } from '../settings.js';
import { currentSshEnvironment, detectSshExecutablePath } from '../ssh/config.js';
import { buildInteractiveSshArguments } from '../ssh/runner.js';
import { copyContainerInfo, copyContainerSummary, openDevContainer, openSshWindow } from './containerActions.js';
import { copyHostInfo } from './hostActions.js';
import { showIdleHistory } from './idleHistory.js';
import { HostNode, type ContainerNode, type MonitorNode } from './nodes.js';
import { contextSelection } from './selection.js';

type HostCommandService = Pick<MonitorService,
  'getRecords' | 'getRecord' | 'getIdleHistory' | 'onDidChange' | 'scanAll' | 'scanAliases' |
  'reloadConfig' | 'subscribe' | 'unsubscribe'>;

async function runWithProgress(
  title: string,
  operation: (token: vscode.CancellationToken, report: (progress: ScanProgress) => void) => Promise<void>,
): Promise<void> {
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title, cancellable: true },
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

export function openSshTerminal(node?: HostNode): void {
  if (!node) return;
  try {
    const settings = getSettings();
    const environment = currentSshEnvironment(vscode.env.remoteName);
    const terminal = vscode.window.createTerminal({
      name: 'NPU SSH: ' + node.record.host.alias,
      shellPath: detectSshExecutablePath(settings.sshExecutablePath, environment),
      shellArgs: buildInteractiveSshArguments(node.record.host, settings.connectTimeoutSeconds),
    });
    terminal.show();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(vscode.l10n.t(
      'Unable to open SSH terminal for {0}: {1}', node.record.host.alias, message,
    ));
  }
}

export function registerHostCommands(
  service: HostCommandService,
  tree: Pick<vscode.TreeView<MonitorNode>, 'selection'>,
  output: Pick<vscode.OutputChannel, 'show'>,
): vscode.Disposable[] {
  const scanSelection = async (node: HostNode | undefined, showEmpty: boolean): Promise<void> => {
    const aliases = contextSelection(tree.selection, node,
      (item): item is HostNode => item instanceof HostNode, item => item.record.host.alias)
      .map(item => item.record.host.alias);
    if (!aliases.length) {
      if (showEmpty) void vscode.window.showInformationMessage(vscode.l10n.t('Select one or more hosts first.'));
      return;
    }
    await runWithProgress(vscode.l10n.t('Scanning selected NPU hosts'),
      (token, report) => service.scanAliases(aliases, token, report));
  };
  return [
    vscode.commands.registerCommand('npuMonitor.scanAll', () => runWithProgress(
      vscode.l10n.t('Scanning all NPU hosts'), (token, report) => service.scanAll(token, report))),
    vscode.commands.registerCommand('npuMonitor.scanHost', (node?: HostNode) => scanSelection(node, false)),
    vscode.commands.registerCommand('npuMonitor.scanSelected', (node?: HostNode) => scanSelection(node, true)),
    vscode.commands.registerCommand('npuMonitor.showIdleHistory', async (node?: HostNode) => {
      let alias = node?.record.host.alias;
      if (!alias) {
        const selected = await vscode.window.showQuickPick(service.getRecords().map(record => ({
          label: record.host.alias,
        })), { placeHolder: vscode.l10n.t('Choose a host for idle history') });
        alias = selected?.label;
      }
      if (alias) showIdleHistory(service, alias);
    }),
    vscode.commands.registerCommand('npuMonitor.reloadConfig', () => service.reloadConfig()),
    vscode.commands.registerCommand('npuMonitor.subscribeHost', async (node?: HostNode) => {
      if (node) await service.subscribe(node.record.host.alias);
    }),
    vscode.commands.registerCommand('npuMonitor.unsubscribeHost', async (node?: HostNode) => {
      if (node) await service.unsubscribe(node.record.host.alias);
    }),
    vscode.commands.registerCommand('npuMonitor.openSshTerminal', openSshTerminal),
    vscode.commands.registerCommand('npuMonitor.openSshWindow', openSshWindow),
    vscode.commands.registerCommand('npuMonitor.copyHostInfo', (node?: MonitorNode) => copyHostInfo(tree.selection, node)),
    vscode.commands.registerCommand('npuMonitor.copyContainerInfo', (node?: MonitorNode) => copyContainerInfo(tree.selection, node)),
    vscode.commands.registerCommand('npuMonitor.copyContainerSummary', (node?: MonitorNode) => copyContainerSummary(tree.selection, node)),
    vscode.commands.registerCommand('npuMonitor.openDevContainer', (node?: ContainerNode) =>
      openDevContainer(node, async alias => {
        await service.scanAliases([alias]);
        return service.getRecord(alias);
      })),
    vscode.commands.registerCommand('npuMonitor.selectSshConfig', async () => {
      const selected = await vscode.window.showOpenDialog({
        canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
        title: vscode.l10n.t('Select SSH configuration'),
      });
      const file = selected?.[0];
      if (!file) return;
      await vscode.workspace.getConfiguration('npuMonitor').update('sshConfigPath', file.fsPath,
        vscode.ConfigurationTarget.Global);
      await service.reloadConfig();
    }),
    vscode.commands.registerCommand('npuMonitor.openSettings', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', '@ext:local.vscode-npu-monitor')),
    vscode.commands.registerCommand('npuMonitor.showOutput', () => output.show()),
  ];
}
