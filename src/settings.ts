import * as vscode from 'vscode';

import type { MonitorSettings } from './types.js';

function numberSetting(config: vscode.WorkspaceConfiguration, key: string, fallback: number): number {
  const value = config.get<number>(key, fallback);
  return Number.isFinite(value) ? value : fallback;
}

export function getSettings(): MonitorSettings {
  const config = vscode.workspace.getConfiguration('npuMonitor');
  return {
    sshConfigPath: config.get<string>('sshConfigPath', '').trim(),
    knownHostsPath: config.get<string>('knownHostsPath', '').trim(),
    sshExecutablePath: config.get<string>('sshExecutablePath', '').trim(),
    connectTimeoutSeconds: numberSetting(config, 'connectTimeoutSeconds', 8),
    exporterProbeTimeoutSeconds: numberSetting(config, 'exporterProbeTimeoutSeconds', 2),
    npuSmiTimeoutSeconds: numberSetting(config, 'npuSmiTimeoutSeconds', 10),
    maxConcurrentHosts: Math.max(1, Math.floor(numberSetting(config, 'maxConcurrentHosts', 6))),
    excludedHosts: config.get<string[]>('excludedHosts', []),
    pollIntervalSeconds: Math.max(10, numberSetting(config, 'pollIntervalSeconds', 60)),
    idleScope: config.get<'allCards' | 'anyCard'>('idleScope', 'allCards'),
    idleRequireNoProcesses: config.get<boolean>('idleRequireNoProcesses', true),
    idleUtilizationThresholdPercent: numberSetting(config, 'idleUtilizationThresholdPercent', 1),
    idleConsecutiveChecks: Math.max(1, Math.floor(numberSetting(config, 'idleConsecutiveChecks', 1))),
  };
}
