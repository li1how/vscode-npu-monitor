import * as vscode from 'vscode';

import { formatSshTarget } from './formatters.js';
import { HostNode, type MonitorNode } from './nodes.js';
import { contextSelection, uniqueBy } from './selection.js';

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
  const key = (item: HostNode): string => item.record.host.alias;
  const selected = uniqueBy(contextSelection(selection, node,
    (item): item is HostNode => item instanceof HostNode, key), key);
  if (!selected.length) {
    void vscode.window.showInformationMessage(vscode.l10n.t('Select one or more hosts first.'));
    return;
  }
  try {
    await vscode.env.clipboard.writeText(selected.map(formatHostInfo).join('\n\n---\n\n'));
  } catch (error) {
    void vscode.window.showErrorMessage(vscode.l10n.t('Unable to copy host information: {0}',
      error instanceof Error ? error.message : String(error)));
  }
}
