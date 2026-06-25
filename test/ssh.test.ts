import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildRemoteScanCommand, parseRemoteEnvelope } from '../src/collector.js';
import {
  detectSshConfigPath,
  loadSshHosts,
  windowsPathToWsl,
  type SshEnvironment,
} from '../src/sshConfig.js';
import { buildInteractiveSshArguments, buildSshArguments } from '../src/sshRunner.js';
import type { MonitorSettings, SshHost } from '../src/types.js';

const settings: MonitorSettings = {
  sshConfigPath: '',
  remoteSshConfigFile: '',
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
      platform: process.platform,
      isWsl: false,
      homeDir: os.homedir(),
      username: os.userInfo().username,
      env: process.env,
    };
    const loaded = loadSshHosts({ ...settings, sshConfigPath: configPath }, environment);
    expect(loaded.hosts).toHaveLength(1);
    expect(loaded.hosts[0]).toMatchObject({
      alias: '10.0.0.1(A3)',
      hostname: '10.0.0.1',
      user: 'root',
      port: 22,
      useAlias: process.platform === 'win32',
    });
  });

  it('prefers explicit NPU SSH config over Remote - SSH config', () => {
    const environment: SshEnvironment = {
      platform: 'linux',
      isWsl: false,
      homeDir: '/home/test',
      username: 'test',
      env: {},
    };
    expect(detectSshConfigPath('/npu/config', '/remote/config', environment))
      .toBe('/npu/config');
  });

  it('uses Remote - SSH config before automatic detection', () => {
    const environment: SshEnvironment = {
      platform: 'linux',
      isWsl: false,
      homeDir: '/home/test',
      username: 'test',
      env: {},
    };
    expect(detectSshConfigPath('', '/remote/config', environment))
      .toBe('/remote/config');
  });

  it('falls back to automatic SSH config detection', () => {
    const homeDir = mkdtempSync(path.join(os.tmpdir(), 'npu-monitor-home-'));
    const sshDirectory = path.join(homeDir, '.ssh');
    const configPath = path.join(sshDirectory, 'config');
    mkdirSync(sshDirectory);
    writeFileSync(configPath, 'Host alpha\n  HostName 10.0.0.1\n');
    const environment: SshEnvironment = {
      platform: 'linux',
      isWsl: false,
      homeDir,
      username: 'test',
      env: {},
    };
    expect(detectSshConfigPath('', '', environment)).toBe(configPath);
  });

  it('converts Remote - SSH Windows config paths for WSL', () => {
    const environment: SshEnvironment = {
      platform: 'linux',
      isWsl: true,
      homeDir: '/home/test',
      username: 'test',
      env: {},
    };
    expect(detectSshConfigPath('', 'C:\\Users\\me\\.ssh\\config', environment))
      .toBe('/mnt/c/Users/me/.ssh/config');
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
    expect(args).toContain('UpdateHostKeys=no');
    expect(args).toContain('BatchMode=yes');
    expect(args.at(-1)).toBe('echo ok');
  });

  it('builds interactive SSH terminal arguments without a remote command', () => {
    const host: SshHost = {
      alias: 'alpha',
      hostname: '10.0.0.1',
      user: 'root',
      port: 2222,
      identityFiles: ['/home/me/.ssh/id_ed25519'],
      proxyJump: 'jump',
      configPath: '/tmp/config',
      knownHostsPath: '/tmp/known_hosts',
      useAlias: false,
    };
    const args = buildInteractiveSshArguments(host, 8);
    expect(args).toEqual([
      '-F',
      '/tmp/config',
      '-o',
      'BatchMode=no',
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      'UpdateHostKeys=no',
      '-o',
      'ConnectionAttempts=1',
      '-o',
      'ConnectTimeout=8',
      '-o',
      'UserKnownHostsFile=/tmp/known_hosts',
      '-p',
      '2222',
      '-i',
      '/home/me/.ssh/id_ed25519',
      '-J',
      'jump',
      'root@10.0.0.1',
    ]);
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
