import { randomBytes } from 'node:crypto';

import * as vscode from 'vscode';

import { getSettings } from '../settings.js';
import { MonitorHttpServer } from './server.js';
import type { MonitorReader } from './tools.js';

export class McpController implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  public readonly onDidChange = this.emitter.event;
  public state = vscode.l10n.t('Disabled');
  public error = '';
  public port = 49160;
  private token = '';
  private running = false;
  private disposed = false;
  private queue = Promise.resolve();
  private readonly server: MonitorHttpServer;

  public constructor(private readonly context: vscode.ExtensionContext, service: MonitorReader,
    private readonly output: vscode.LogOutputChannel) {
    this.server = new MonitorHttpServer(service, getSettings);
  }

  public get url(): string { return `http://127.0.0.1:${this.port}/mcp`; }
  public get tooltip(): string {
    return `${this.url}\n${vscode.env.remoteName ?? 'local'}${this.error ? '\n' + this.error : ''}`;
  }

  private update(state: string): void { this.state = state; this.emitter.fire(); }

  public configure(): Promise<void> {
    this.queue = this.queue.then(async () => {
      this.update(vscode.l10n.t('Stopping'));
      await this.server.stop();
      this.running = false;
      this.error = '';
      if (this.disposed) return;
      const config = vscode.workspace.getConfiguration('npuMonitor');
      this.port = config.get<number>('mcp.port', 49160);
      if (!config.get<boolean>('mcp.enabled', false)) { this.update(vscode.l10n.t('Disabled')); return; }
      this.update(vscode.l10n.t('Starting'));
      if (!Number.isInteger(this.port) || this.port < 1024 || this.port > 65535) throw new Error('Invalid MCP port');
      this.token = await this.context.secrets.get('npuMonitor.mcp.token') ?? randomBytes(32).toString('hex');
      await this.context.secrets.store('npuMonitor.mcp.token', this.token);
      if (this.disposed) return;
      await this.server.start(this.port, this.token);
      this.running = true;
      this.update(vscode.l10n.t('Running'));
    }).catch((error: unknown) => {
      this.error = (error as NodeJS.ErrnoException).code === 'EADDRINUSE'
        ? vscode.l10n.t('MCP port is already in use') : vscode.l10n.t('Unable to start MCP service');
      this.output.error(this.error);
      this.update(this.error);
    });
    return this.queue;
  }

  public async showMenu(): Promise<void> {
    const enabled = vscode.workspace.getConfiguration('npuMonitor').get<boolean>('mcp.enabled', false);
    const items = [
      { label: enabled ? vscode.l10n.t('Disable MCP') : vscode.l10n.t('Enable MCP'), action: 'toggle' },
      { label: vscode.l10n.t('Retry MCP startup'), action: 'retry' },
      { label: vscode.l10n.t('Copy MCP environment variables'), action: 'copy' },
      { label: vscode.l10n.t('Show output'), action: 'log' },
    ];
    const selected = await vscode.window.showQuickPick(items);
    try {
      if (selected?.action === 'toggle') {
        if (!vscode.workspace.workspaceFolders?.length && !vscode.workspace.workspaceFile) {
          await vscode.window.showInformationMessage(vscode.l10n.t('Open a workspace to enable MCP.')); return;
        }
        await vscode.workspace.getConfiguration('npuMonitor').update('mcp.enabled', !enabled, vscode.ConfigurationTarget.Workspace);
      } else if (selected?.action === 'retry') await this.configure();
      else if (selected?.action === 'copy') {
        if (!this.running) {
          await vscode.window.showInformationMessage(vscode.l10n.t('Start MCP before copying connection settings.')); return;
        }
        await vscode.env.clipboard.writeText(`NPU_MONITOR_MCP_URL='${this.url}'\nNPU_MONITOR_MCP_TOKEN='${this.token}'\n`);
        await vscode.window.showInformationMessage(vscode.l10n.t('Copied MCP credentials. Paste into your private .env file.'));
      } else if (selected?.action === 'log') this.output.show();
    } catch {
      await vscode.window.showErrorMessage(vscode.l10n.t('Unable to update or copy MCP settings.'));
    }
  }

  public dispose(): void {
    this.disposed = true;
    void this.queue.then(() => this.server.stop());
    this.emitter.dispose();
  }
}
