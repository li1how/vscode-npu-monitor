import * as vscode from 'vscode';

import { devContainerDisplayName, isValidWorkspaceFileName } from '../containers/metadata.js';
import { getSettings } from '../settings.js';
import type { HostRecord } from '../types.js';
import { formatSshTarget } from './hostActions.js';
import { ContainerNode, type HostNode, type MonitorNode } from './nodes.js';

export function formatContainerSummary(node: ContainerNode): string {
  const { container, record } = node;
  // Keep these keys stable across UI languages for pasting into other tools.
  const fields = [
    'SSH config: ' + (record.host.configPath || '-'),
    'SSH host: ' + (record.host.alias || '-'),
    'Container ID: ' + (container.id || '-'),
    'Host workspace: ' + (container.workspaceFolder || '-'),
    'Container workspace: ' + (container.containerWorkspaceFolder || '-'),
  ];
  if (container.state !== 'running') {
    fields.push('Status: ' + (container.state || 'unknown'));
  }
  if (record.devContainers?.stale) {
    fields.push('Stale: yes');
  }
  return fields.join('\n');
}

export function formatContainerInfo(node: ContainerNode): string {
  const { container, record } = node;
  const host = record.host;
  const updated = record.devContainers?.snapshot?.collectedAt;
  return [
    vscode.l10n.t('SSH config: {0}', host.configPath || '-'),
    vscode.l10n.t('SSH host: {0}', host.alias),
    vscode.l10n.t('SSH target: {0}', formatSshTarget(host)),
    vscode.l10n.t('Name: {0}', devContainerDisplayName(container)),
    vscode.l10n.t('Docker name: {0}', container.name),
    vscode.l10n.t('Container ID: {0}', container.id),
    vscode.l10n.t('Type: {0}', container.isDevContainer ? 'Dev Container' : vscode.l10n.t('Docker container')),
    vscode.l10n.t('Status: {0}', container.state || '-'),
    vscode.l10n.t('Image: {0}', container.image || '-'),
    vscode.l10n.t('Workspace folder: {0}', container.workspaceFolder ?? '-'),
    vscode.l10n.t('Container workspace folder: {0}', container.containerWorkspaceFolder ?? '-'),
    vscode.l10n.t('Configuration file: {0}', container.configFile ?? '-'),
    vscode.l10n.t('Created: {0}', container.createdAt || '-'),
    vscode.l10n.t('Started: {0}', container.startedAt ?? '-'),
    vscode.l10n.t('Updated: {0}', updated === undefined ? '-' : new Date(updated).toISOString()),
    vscode.l10n.t('Stale: {0}', record.devContainers?.stale ? vscode.l10n.t('Yes') : vscode.l10n.t('No')),
  ].join('\n');
}

export function copyContainerInfo(selection: readonly MonitorNode[], node?: MonitorNode): Promise<void> {
  return copyContainers(selection, node, formatContainerInfo);
}

export function copyContainerSummary(selection: readonly MonitorNode[], node?: MonitorNode): Promise<void> {
  return copyContainers(selection, node, formatContainerSummary);
}

async function copyContainers(
  selection: readonly MonitorNode[],
  node: MonitorNode | undefined,
  format: (container: ContainerNode) => string,
): Promise<void> {
  let selected = selection.filter((item): item is ContainerNode => item instanceof ContainerNode);
  if (node instanceof ContainerNode && !selected.some(item =>
    item.record.host.alias === node.record.host.alias && item.container.id === node.container.id)) {
    selected = [node];
  }
  const unique = new Map<string, ContainerNode>();
  for (const item of selected) {
    // A refresh can replace a snapshot while VS Code still holds an old tree selection.
    const latest = item.record.devContainers?.snapshot?.containers.find(value => value.id === item.container.id);
    if (latest) {
      unique.set(JSON.stringify([item.record.host.alias, latest.id]), new ContainerNode(item.record, latest));
    }
  }
  if (!unique.size) {
    void vscode.window.showInformationMessage(vscode.l10n.t('Select one or more containers first.'));
    return;
  }
  try {
    await vscode.env.clipboard.writeText([...unique.values()].map(format).join('\n\n---\n\n'));
  } catch (error) {
    void vscode.window.showErrorMessage(vscode.l10n.t('Unable to copy container information: {0}',
      error instanceof Error ? error.message : String(error)));
  }
}

// Dev Containers' resolver-owned authority format, isolated here for compatibility.
// Match its attached-container ID payload and @ssh-remote parent routing. Encoding
// the SSH object preserves aliases containing spaces, uppercase, +, or parentheses.
export function attachedContainerAuthority(alias: string, id: string): string {
  if (!alias || !/^[a-f0-9]{64}$/.test(id)) {
    throw new Error('Invalid SSH host or container ID.');
  }
  const parent = Buffer.from(JSON.stringify({ hostName: alias }), 'utf8').toString('hex');
  const container = Buffer.from(JSON.stringify({ containerId: id }), 'utf8').toString('hex');
  return 'attached-container+' + container + '@ssh-remote+' + parent;
}

export async function openDevContainer(
  node: ContainerNode | undefined,
  refreshHost: (alias: string) => Promise<HostRecord | undefined>,
): Promise<void> {
  if (!node) {
    return;
  }
  const alias = node.record.host.alias;
  const id = node.container.id;
  try {
    // getCommands() only lists registered commands, not installed extensions.
    // Let the new window activate its local remote resolvers on demand, including
    // when this extension runs in WSL and the resolver extensions run on Windows.
    const record = await refreshHost(alias);
    const snapshot = record?.devContainers;
    if (!record || snapshot?.state !== 'ready' || snapshot.stale) {
      throw new Error(vscode.l10n.t('Unable to verify the container state. Refresh the host and try again.'));
    }
    const container = snapshot.snapshot?.containers.find(item => item.id === id);
    if (!container) {
      throw new Error(vscode.l10n.t('The container no longer exists.'));
    }
    if (container.state !== 'running') {
      throw new Error(vscode.l10n.t('The container is not running. Start it before opening a window.'));
    }
    const authority = attachedContainerAuthority(alias, id);
    if (container.containerWorkspaceFolder) {
      const workspaceFileName = getSettings().containerWorkspaceFile;
      if (!isValidWorkspaceFileName(workspaceFileName)) {
        throw new Error(vscode.l10n.t(
          'Invalid workspace file name "{0}". Use a file name ending in .code-workspace without path separators.',
          workspaceFileName,
        ));
      }
      const target = workspaceFileName
        ? container.containerWorkspaceFile
        : container.containerWorkspaceFolder;
      if (!target) {
        throw new Error(vscode.l10n.t(
          'The configured workspace file "{0}" was not found in the workspace folder.',
          workspaceFileName,
        ));
      }
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.from({
        scheme: 'vscode-remote', authority, path: target,
      }), { forceNewWindow: true });
    } else {
      await vscode.commands.executeCommand('vscode.newWindow', { remoteAuthority: authority, reuseWindow: false });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(vscode.l10n.t('Unable to open {0} on {1}: {2}',
      devContainerDisplayName(node.container), alias, message));
  }
}

export async function openSshWindow(node: HostNode | ContainerNode | undefined): Promise<void> {
  if (!node) {
    return;
  }
  const alias = node.record.host.alias;
  try {
    // Executing the contributed command activates Remote - SSH if needed.
    await vscode.commands.executeCommand('opensshremotes.openEmptyWindow', { host: alias });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(vscode.l10n.t('Unable to open SSH window for {0}: {1}', alias, message));
  }
}
