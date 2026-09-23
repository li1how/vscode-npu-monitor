import { randomBytes } from 'node:crypto';

import * as vscode from 'vscode';

import { HISTORY_BUCKET_MS, type HistoryState, type HostHistoryView } from '../npu/history.js';
import type { MonitorService } from '../monitorService.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export function formatDuration(milliseconds: number): string {
  const minutes = Math.max(0, Math.floor(milliseconds / 60000));
  if (minutes < 60) return vscode.l10n.t('{0} min', minutes);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return vscode.l10n.t('{0} h {1} min', hours, minutes % 60);
  return vscode.l10n.t('{0} d {1} h', Math.floor(hours / 24), hours % 24);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!);
}

function stateLabel(state: HistoryState): string {
  switch (state) {
    case 'idle': return vscode.l10n.t('Idle');
    case 'busy': return vscode.l10n.t('Busy');
    case 'mixed': return vscode.l10n.t('Mixed');
    case 'unknown': return vscode.l10n.t('Unknown');
  }
}

export function renderIdleHistory(history: HostHistoryView, now = Date.now(), nonce = 'test'): string {
  const count = history.retentionDays * DAY_MS / HISTORY_BUCKET_MS;
  const end = Math.floor(now / HISTORY_BUCKET_MS) * HISTORY_BUCKET_MS;
  const start = end - (count - 1) * HISTORY_BUCKET_MS;
  const cards = history.cards.map(card => ({
    ...card,
    binsByTime: new Map(card.bins),
  }));
  const days: string[] = [];
  for (let day = 0; day < history.retentionDays; day += 1) {
    const dayStart = start + day * DAY_MS;
    const dayEnd = dayStart + DAY_MS;
    const rows = cards.map(card => {
      const cells: string[] = [];
      for (let time = dayStart; time < dayEnd; time += HISTORY_BUCKET_MS) {
        const state = card.binsByTime.get(time) ?? 'unknown';
        const title = new Date(time).toLocaleString() + ' – ' +
          new Date(time + HISTORY_BUCKET_MS).toLocaleTimeString() + ': ' + stateLabel(state);
        cells.push(`<span class="cell ${state}" title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}"></span>`);
      }
      return `<div class="row"><div class="name">NPU ${escapeHtml(card.id)}</div><div class="cells">${cells.join('')}</div></div>`;
    });
    days.push(`<section><h2>${escapeHtml(new Date(dayStart).toLocaleString())} – ${escapeHtml(new Date(dayEnd).toLocaleString())}</h2>${rows.join('')}</section>`);
  }
  const summary = cards.length ? cards.map(card => {
    const duration = card.idleSince === null ? stateLabel(card.state) :
      vscode.l10n.t('Idle for {0}', formatDuration(now - card.idleSince));
    const updated = card.observedAt === null ? vscode.l10n.t('No observations') :
      vscode.l10n.t('Updated: {0}', new Date(card.observedAt).toLocaleString());
    return `<li>NPU ${escapeHtml(card.id)}: ${escapeHtml(duration)} · ${escapeHtml(updated)}</li>`;
  }).join('') : `<li>${escapeHtml(vscode.l10n.t('No observations'))}</li>`;
  const title = vscode.l10n.t('Idle history: {0}', history.alias);
  const legend = (['idle', 'busy', 'mixed', 'unknown'] as const)
    .map(state => `<span><i class="cell ${state}"></i>${escapeHtml(stateLabel(state))}</span>`).join('');
  return `<!DOCTYPE html><html lang="${escapeHtml(vscode.env.language)}"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${escapeHtml(title)}</title>
<style nonce="${nonce}">
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:16px}
h1{font-size:1.3em}h2{font-size:1em;margin:18px 0 8px}.legend{display:flex;gap:18px;flex-wrap:wrap}
.legend span{display:flex;align-items:center;gap:5px}.legend .cell{width:13px;height:13px}
section{overflow-x:auto}.row{display:flex;align-items:center;margin:3px 0}.name{width:80px;flex:none}
.cells{display:grid;grid-template-columns:repeat(96,minmax(7px,1fr));gap:1px;min-width:720px;flex:1}
.cell{display:inline-block;height:17px;border-radius:2px;background:var(--vscode-editorWidget-border)}
.cell.idle{background:var(--vscode-testing-iconPassed)}.cell.busy{background:var(--vscode-charts-yellow)}
.cell.mixed{background:var(--vscode-charts-orange)}.cell.unknown{background:var(--vscode-editorWidget-border)}
</style></head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(vscode.l10n.t('Observed history only; idle is not a reservation.'))}</p>
<ul>${summary}</ul><div class="legend">${legend}</div>${days.join('')}</body></html>`;
}

export function showIdleHistory(service: MonitorService, alias: string): void {
  const panel = vscode.window.createWebviewPanel(
    'npuMonitor.idleHistory', vscode.l10n.t('Idle history: {0}', alias),
    vscode.ViewColumn.Active, { enableScripts: false },
  );
  const nonce = randomBytes(16).toString('base64');
  let timer: NodeJS.Timeout | undefined;
  const refresh = (): void => {
    panel.webview.html = renderIdleHistory(service.getIdleHistory(alias), Date.now(), nonce);
  };
  refresh();
  const subscription = service.onDidChange(() => {
    if (!panel.visible || timer) return;
    timer = setTimeout(() => { timer = undefined; refresh(); }, 250);
  });
  panel.onDidDispose(() => {
    if (timer) clearTimeout(timer);
    subscription.dispose();
  });
}
