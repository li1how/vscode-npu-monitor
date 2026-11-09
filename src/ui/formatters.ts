import * as vscode from 'vscode';

import type { HostState, SshHost } from '../types.js';

export function formatSshTarget(host: SshHost): string {
  if (!host.hostname) return '-';
  const hostname = host.hostname.includes(':') ? '[' + host.hostname + ']' : host.hostname;
  return (host.user ? host.user + '@' : '') + hostname + ':' + (host.port ?? 22);
}

export function formatDuration(milliseconds: number): string {
  const minutes = Math.max(0, Math.floor(milliseconds / 60000));
  if (minutes < 60) return vscode.l10n.t('{0} min', minutes);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return vscode.l10n.t('{0} h {1} min', hours, minutes % 60);
  return vscode.l10n.t('{0} d {1} h', Math.floor(hours / 24), hours % 24);
}

export function hostStateText(state: HostState): string {
  const values: Record<HostState, string> = {
    unknown: vscode.l10n.t('Not scanned'), refreshing: vscode.l10n.t('Refreshing'),
    idle: vscode.l10n.t('Idle'), busy: vscode.l10n.t('Busy'),
    partial: vscode.l10n.t('Partial data'), unhealthy: vscode.l10n.t('Unhealthy'),
    unreachable: vscode.l10n.t('Unreachable'), timeout: vscode.l10n.t('Timed out'),
    authError: vscode.l10n.t('Authentication failed'), hostKeyError: vscode.l10n.t('Host key error'),
    unsupported: vscode.l10n.t('No collector'), error: vscode.l10n.t('Error'),
    missingConfig: vscode.l10n.t('Missing configuration'),
  };
  return values[state];
}
