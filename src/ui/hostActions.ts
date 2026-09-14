import * as vscode from 'vscode';

import type { SshHost } from '../types.js';
import { HostNode, type MonitorNode } from './nodes.js';

export function formatSshTarget(host: SshHost): string {
  if (!host.hostname) {
    return '-';
  }
  const hostname = host.hostname.includes(':') ? '[' + host.hostname + ']' : host.hostname;
  return (host.user ? host.user + '@' : '') + hostname + ':' + (host.port ?? 22);
}

export function formatHostInfo(node: HostNode): string {
  const host = node.record.host;
  return [
    vscode.l10n.t('SSH config: {0}', host.configPath || '-'),
    vscode.l10n.t('SSH host: {0}', host.alias || '-'),
    vscode.l10n.t('SSH target: {0}', formatSshTarget(host)),
  ].join('\n');
}

export async function copyHostInfo(
  selection: readonly MonitorNode[],
  node?: MonitorNode,
): Promise<void> {
  let selected = selection.filter((item): item is HostNode => item instanceof HostNode);
  if (node instanceof HostNode && !selected.some(item => item.record.host.alias === node.record.host.alias)) {
    selected = [node];
  }
  const unique = new Map<string, HostNode>();
  for (const item of selected) {
    unique.set(item.record.host.alias, item);
  }
  if (!unique.size) {
    void vscode.window.showInformationMessage(vscode.l10n.t('Select one or more hosts first.'));
    return;
  }
  try {
    await vscode.env.clipboard.writeText([...unique.values()].map(formatHostInfo).join('\n\n---\n\n'));
  } catch (error) {
    void vscode.window.showErrorMessage(vscode.l10n.t('Unable to copy host information: {0}',
      error instanceof Error ? error.message : String(error)));
  }
}
