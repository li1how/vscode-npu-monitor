import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildRemoteScanCommand, parseRemoteEnvelope } from '../src/collector.js';
import {
  loadSshHosts,
  windowsPathToWsl,
  type SshEnvironment,
} from '../src/sshConfig.js';
import { buildSshArguments } from '../src/sshRunner.js';
import type { MonitorSettings, SshHost } from '../src/types.js';

const settings: MonitorSettings = {
  sshConfigPath: '',
  knownHostsPath: '',
  sshExecutablePath: '',
  connectTimeoutSeconds: 8,
  exporterProbeTimeoutSeconds: 2,
  npuSmiTimeoutSeconds: 10,
  maxConcurrentHosts: 6,
  excludedHosts: [],
  pollIntervalSeconds: 60,
  idleScope: 'allCards',
  idleRequireNoProcesses: true,
  idleUtilizationThresholdPercent: 1,
  idleConsecutiveChecks: 1,
};

describe('SSH configuration and scan protocol', () => {
  it('converts Windows paths for WSL', () => {
    expect(windowsPathToWsl('C:\\Users\\me\\.ssh\\id_ed25519'))
      .toBe('/mnt/c/Users/me/.ssh/id_ed25519');
  });

  it('loads literal aliases and resolves host defaults safely', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'npu-monitor-'));
    const configPath = path.join(directory, 'config');
    writeFileSync(configPath, [
      'Host 10.0.0.1(A3)',
      '  HostName 10.0.0.1',
      '  User root',
      'Host *',
      '  Port 22',
      '',
    ].join('\n'));
    const environment: SshEnvironment = {
      platform: 'linux',
      isWsl: true,
      homeDir: '/home/test',
      username: 'test',
      env: {},
    };
    const loaded = loadSshHosts({ ...settings, sshConfigPath: configPath }, environment);
    expect(loaded.hosts).toHaveLength(1);
    expect(loaded.hosts[0]).toMatchObject({
      alias: '10.0.0.1(A3)',
      hostname: '10.0.0.1',
      user: 'root',
      port: 22,
      useAlias: false,
    });
  });

  it('builds direct WSL SSH arguments for aliases with parentheses', () => {
    const host: SshHost = {
      alias: '10.0.0.1(A3)',
      hostname: '10.0.0.1',
      user: 'root',
      port: 22,
      identityFiles: [],
      configPath: '/tmp/config',
      useAlias: false,
    };
    const args = buildSshArguments(host, 8, 'echo ok');
    expect(args).toContain('root@10.0.0.1');
    expect(args).toContain('StrictHostKeyChecking=yes');
    expect(args.at(-1)).toBe('echo ok');
  });

  it('uses a cheap exact-name preflight and excludes expensive discovery', () => {
    const command = buildRemoteScanCommand(settings);
    expect(command).toContain('$2=="npu-exporter" || $2=="npu_exporter"');
    expect(command).toContain('command -v npu-smi');
    expect(command).not.toMatch(/systemctl|find \/|docker|kubectl|ss -/);
    expect(command).toContain(' - now + probe_started');
  });

  it('parses framed remote output', () => {
    const envelope = parseRemoteEnvelope([
      '__NPU_MONITOR_CAPS_BEGIN__',
      '__NPU_MONITOR_CAPS_END__',
      '__NPU_MONITOR_SOURCE__npu-smi',
      '__NPU_MONITOR_DATA_BEGIN__',
      'npu-smi data',
      '__NPU_MONITOR_DATA_END__',
    ].join('\n'));
    expect(envelope).toEqual({
      source: 'npu-smi',
      endpoint: undefined,
      data: 'npu-smi data',
    });
  });
});
