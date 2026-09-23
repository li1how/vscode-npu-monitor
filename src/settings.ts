import * as vscode from 'vscode';

import type { MonitorSettings } from './types.js';

function numberSetting(config: vscode.WorkspaceConfiguration, key: string, fallback: number): number {
  const value = config.get<number>(key, fallback);
  return Number.isFinite(value) ? value : fallback;
}

export function getSettings(): MonitorSettings {
  const config = vscode.workspace.getConfiguration('npuMonitor');
  const remoteSshConfig = vscode.workspace.getConfiguration('remote.SSH');
  const mode = config.get<string>('containers.filterMode', 'devContainers');
  const paths = config.get<unknown>('containers.workspacePaths', []);
  const workspaceFile = config.get<unknown>('containers.workspaceFile', '');
  return {
    sshConfigPath: config.get<string>('sshConfigPath', '').trim(),
    remoteSshConfigFile: remoteSshConfig.get<string>('configFile', '').trim(),
    knownHostsPath: config.get<string>('knownHostsPath', '').trim(),
    sshExecutablePath: config.get<string>('sshExecutablePath', '').trim(),
    connectTimeoutSeconds: numberSetting(config, 'connectTimeoutSeconds', 8),
    exporterProbeTimeoutSeconds: numberSetting(config, 'exporterProbeTimeoutSeconds', 2),
    npuSmiTimeoutSeconds: numberSetting(config, 'npuSmiTimeoutSeconds', 10),
    maxConcurrentHosts: Math.max(1, Math.floor(numberSetting(config, 'maxConcurrentHosts', 8))),
    excludedHosts: config.get<string[]>('excludedHosts', []),
    pollIntervalSeconds: Math.max(10, numberSetting(config, 'pollIntervalSeconds', 180)),
    autoRefreshAllHosts: config.get<boolean>('autoRefreshAllHosts', true),
    idleHistoryRetentionDays: Math.min(30, Math.max(1,
      Math.floor(numberSetting(config, 'idleHistoryRetentionDays', 7)))),
    idleScope: config.get<'allCards' | 'anyCard'>('idleScope', 'anyCard'),
    idleRequireNoProcesses: config.get<boolean>('idleRequireNoProcesses', true),
    idleUtilizationThresholdPercent: numberSetting(config, 'idleUtilizationThresholdPercent', 1),
    idleConsecutiveChecks: Math.max(1, Math.floor(numberSetting(config, 'idleConsecutiveChecks', 1))),
    devContainersEnabled: config.get<boolean>('devContainers.enabled', true),
    containerFilterMode: mode === 'all' || mode === 'workspacePaths' ? mode : 'devContainers',
    // Invalid input must not turn a requested path filter into an unfiltered list.
    containerWorkspacePaths: Array.isArray(paths)
      ? paths.map(value => typeof value === 'string' ? value : '') : [''],
    containerWorkspaceFile: typeof workspaceFile === 'string' ? workspaceFile.trim() : String(workspaceFile),
    devContainersTimeoutSeconds: Math.min(60, Math.max(1,
      Math.floor(numberSetting(config, 'devContainers.timeoutSeconds', 5)))),
  };
}
