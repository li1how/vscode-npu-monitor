import * as vscode from 'vscode';

import { HOST_FILTERS, type HostBrowser, hostFilterLabel } from './hostBrowser.js';
import { formatSshTarget } from './formatters.js';
import { HostNode, type MonitorNode } from './nodes.js';
import { contextSelection, uniqueBy } from './selection.js';
import type { HostRecord } from '../types.js';

interface HostPick extends vscode.QuickPickItem { record: HostRecord }
type BrowserTree = Pick<vscode.TreeView<MonitorNode>, 'selection' | 'reveal' | 'message'>;

export function selectedHostRecords(selection: readonly MonitorNode[], node?: MonitorNode): HostRecord[] {
  const key = (item: HostNode): string => JSON.stringify([item.record.host.configPath, item.record.host.alias]);
  return uniqueBy(contextSelection(selection, node,
    (item): item is HostNode => item instanceof HostNode, key), key).map(item => item.record);
}

export function findHost(browser: HostBrowser, tree: Pick<BrowserTree, 'reveal'>): Promise<void> {
  const picker = vscode.window.createQuickPick<HostPick>();
  picker.title = vscode.l10n.t('Find host');
  picker.placeholder = vscode.l10n.t('Search all hosts by alias, address or note');
  picker.matchOnDescription = true;
  picker.matchOnDetail = true;
  const update = (): void => {
    const active = picker.activeItems[0]?.record;
    picker.items = browser.records('all').map(record => {
      const preference = browser.preference(record);
      return {
        label: (preference.favorite ? '$(star-full) ' : '') + record.host.alias,
        description: browser.summary(record).description.join(' · '),
        detail: formatSshTarget(record.host) + (preference.note ? ' · ' + preference.note : ''),
        record,
      };
    });
    if (active) {
      picker.activeItems = picker.items.filter(item => item.record.host.alias === active.host.alias &&
        item.record.host.configPath === active.host.configPath);
    }
  };
  update();
  return new Promise(resolve => {
    let accepting = false;
    const subscriptions = [
      browser.onDidChange(update),
      picker.onDidAccept(() => {
        if (accepting) return;
        const selected = picker.selectedItems[0]?.record;
        if (!selected) return;
        const record = browser.records('all').find(item => item.host.alias === selected.host.alias &&
          item.host.configPath === selected.host.configPath);
        if (!record) { update(); return; }
        accepting = true;
        if (!browser.records().includes(record)) browser.setFilter('all');
        void Promise.resolve(tree.reveal(new HostNode(record), { select: true, focus: true, expand: true }))
          .then(undefined, () => vscode.window.showErrorMessage(vscode.l10n.t('Unable to reveal the host. Try searching again.')))
          .finally(() => picker.hide());
      }),
      picker.onDidHide(() => {
        subscriptions.forEach(subscription => subscription.dispose());
        picker.dispose();
        resolve();
      }),
    ];
    picker.show();
  });
}

export function registerHostBrowserActions(
  browser: HostBrowser,
  tree: BrowserTree,
): vscode.Disposable[] {
  const update = (): void => {
    tree.message = browser.message;
    void vscode.commands.executeCommand('setContext', 'npuMonitor.hostFilterActive', browser.filter !== 'all');
  };
  update();
  const setFavorite = async (favorite: boolean, node?: MonitorNode): Promise<void> => {
    const records = selectedHostRecords(tree.selection, node);
    if (!records.length) {
      void vscode.window.showInformationMessage(vscode.l10n.t('Select one or more hosts first.'));
      return;
    }
    try {
      await browser.setFavorite(records, favorite);
    } catch {
      void vscode.window.showErrorMessage(vscode.l10n.t('Unable to save host preferences.'));
    }
  };
  return [
    browser.onDidChange(update),
    vscode.commands.registerCommand('npuMonitor.findHost', () => findHost(browser, tree)),
    vscode.commands.registerCommand('npuMonitor.filterHosts', async () => {
      const selected = await vscode.window.showQuickPick(HOST_FILTERS.map(filter => ({
        label: hostFilterLabel(filter), filter,
        description: filter === browser.filter ? vscode.l10n.t('Current filter') : undefined,
      })), { placeHolder: vscode.l10n.t('Filter hosts by cached NPU status or preferences') });
      if (selected) browser.setFilter(selected.filter);
    }),
    vscode.commands.registerCommand('npuMonitor.clearHostFilter', () => browser.setFilter('all')),
    vscode.commands.registerCommand('npuMonitor.favoriteHost', (node?: MonitorNode) => setFavorite(true, node)),
    vscode.commands.registerCommand('npuMonitor.unfavoriteHost', (node?: MonitorNode) => setFavorite(false, node)),
    vscode.commands.registerCommand('npuMonitor.editHostNote', async (node?: MonitorNode) => {
      if (!(node instanceof HostNode)) return;
      const note = await vscode.window.showInputBox({
        title: vscode.l10n.t('Edit note: {0}', node.record.host.alias),
        prompt: vscode.l10n.t('Leave empty to remove the note'),
        value: browser.preference(node.record).note,
      });
      if (note === undefined) return;
      try {
        await browser.setNote(node.record, note);
      } catch {
        void vscode.window.showErrorMessage(vscode.l10n.t('Unable to save host preferences.'));
      }
    }),
  ];
}
