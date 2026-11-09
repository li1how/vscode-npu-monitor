import * as vscode from 'vscode';

import { McpController } from './mcp/controller.js';
import { MonitorService } from './monitorService.js';
import { HostBrowser } from './ui/hostBrowser.js';
import { registerHostBrowserActions } from './ui/hostBrowserActions.js';
import { registerHostCommands } from './ui/hostCommands.js';
import type { MonitorNode } from './ui/nodes.js';
import { NpuTreeProvider } from './ui/treeProvider.js';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('NPU Monitor', { log: true });
  const service = new MonitorService(context, output);
  const mcp = new McpController(context, service, output);
  const browser = new HostBrowser(service, context.globalState);
  const provider = new NpuTreeProvider(service, mcp, browser);
  const treeView = vscode.window.createTreeView<MonitorNode>('npuMonitor.hosts', {
    treeDataProvider: provider, canSelectMany: true, showCollapseAll: true,
  });
  const updateBadge = (): void => {
    const subscribed = service.getRecords().filter(record => record.subscribed).length;
    treeView.badge = subscribed > 0
      ? { value: subscribed, tooltip: vscode.l10n.t('{0} subscribed hosts', subscribed) }
      : undefined;
  };
  context.subscriptions.push(
    output, mcp, service, provider, browser, treeView,
    mcp.onDidChange(() => provider.refresh()),
    vscode.commands.registerCommand('npuMonitor.mcpMenu', () => mcp.showMenu()),
    ...registerHostBrowserActions(browser, treeView),
    ...registerHostCommands(service, treeView, output),
    service.onDidChange(updateBadge),
    vscode.workspace.onDidChangeConfiguration(async event => {
      if (event.affectsConfiguration('npuMonitor.mcp')) await mcp.configure();
      if (event.affectsConfiguration('npuMonitor') || event.affectsConfiguration('remote.SSH.configFile')) {
        await service.reloadConfig(false);
        service.restartTimer();
      }
    }),
  );
  const initialScan = service.initialize();
  void initialScan.catch(error => output.appendLine('Initial scan failed: ' + String(error)));
  await mcp.configure();
  updateBadge();
}

export function deactivate(): void {
  // Disposables registered in the extension context perform all cleanup.
}
