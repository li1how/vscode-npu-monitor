import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  detectSshConfigPath,
  detectSshExecutablePath,
  loadSshHosts,
  windowsPathToWsl,
  type SshEnvironment,
} from '../../src/ssh/config.js';
import { buildInteractiveSshArguments, buildSshArguments } from '../../src/ssh/runner.js';
import type { SshHost } from '../../src/types.js';
import { makeSettings } from '../helpers/fixtures.js';

const settings = makeSettings({
  maxConcurrentHosts: 6, pollIntervalSeconds: 60, autoRefreshAllHosts: false,
  idleScope: 'allCards', devContainersEnabled: false,
});
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

describe('SSH configuration and arguments', () => {
  it('converts Windows paths for WSL', () => {
    expect(windowsPathToWsl('C:\\Users\\me\\.ssh\\id_ed25519'))
      .toBe('/mnt/c/Users/me/.ssh/id_ed25519');
  });

  it('loads literal aliases and resolves host defaults safely', () => {
    const directory = temporaryDirectory('npu-monitor-');
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
    const homeDir = temporaryDirectory('npu-monitor-home-');
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

  it('throws when no SSH config file can be found', () => {
    const homeDir = temporaryDirectory('npu-monitor-empty-');
    const environment: SshEnvironment = {
      platform: 'linux',
      isWsl: false,
      homeDir,
      username: 'test',
      env: {},
    };
    expect(() => detectSshConfigPath('', '', environment)).toThrow(
      'No SSH configuration file was found',
    );
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

  it('uses the alias directly when useAlias is true', () => {
    const host: SshHost = {
      alias: 'myserver',
      hostname: '10.0.0.5',
      user: 'root',
      port: 22,
      identityFiles: [],
      configPath: '/tmp/config',
      useAlias: true,
    };
    const args = buildSshArguments(host, 8, 'echo hi');
    expect(args).toContain('myserver');
    expect(args).not.toContain('root@10.0.0.5');
    expect(args).not.toContain('-p');
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

  it('excludes hosts case-insensitively when loading config', () => {
    const directory = temporaryDirectory('npu-monitor-excl-');
    const configPath = path.join(directory, 'config');
    writeFileSync(configPath, [
      'Host alpha',
      '  HostName 10.0.0.1',
      '  User root',
      'Host BETA',
      '  HostName 10.0.0.2',
      '  User root',
      '',
    ].join('\n'));
    const environment: SshEnvironment = {
      platform: 'linux',
      isWsl: false,
      homeDir: os.homedir(),
      username: 'test',
      env: {},
    };
    const loaded = loadSshHosts(
      { ...settings, sshConfigPath: configPath, excludedHosts: ['beta'] },
      environment,
    );
    expect(loaded.hosts.map(h => h.alias)).toEqual(['alpha']);
  });

  it('reports a warning when an Include directive is present', () => {
    const directory = temporaryDirectory('npu-monitor-inc-');
    const configPath = path.join(directory, 'config');
    writeFileSync(configPath, [
      'Include ~/.ssh/other',
      'Host alpha',
      '  HostName 10.0.0.1',
      '',
    ].join('\n'));
    const environment: SshEnvironment = {
      platform: 'linux',
      isWsl: false,
      homeDir: os.homedir(),
      username: 'test',
      env: {},
    };
    const loaded = loadSshHosts({ ...settings, sshConfigPath: configPath }, environment);
    expect(loaded.warnings.some(w => w.includes('Include'))).toBe(true);
  });

  it('reports a warning when a Match section is present', () => {
    const directory = temporaryDirectory('npu-monitor-match-');
    const configPath = path.join(directory, 'config');
    writeFileSync(configPath, [
      'Host alpha',
      '  HostName 10.0.0.1',
      'Match host 10.*',
      '  User admin',
      '',
    ].join('\n'));
    const environment: SshEnvironment = {
      platform: 'linux',
      isWsl: false,
      homeDir: os.homedir(),
      username: 'test',
      env: {},
    };
    const loaded = loadSshHosts({ ...settings, sshConfigPath: configPath }, environment);
    expect(loaded.warnings.some(w => w.includes('Match'))).toBe(true);
  });

  it('returns platform-appropriate default SSH executable path', () => {
    const linuxEnv: SshEnvironment = {
      platform: 'linux',
      isWsl: false,
      homeDir: '/home/test',
      username: 'test',
      env: {},
    };
    expect(detectSshExecutablePath('', linuxEnv)).toBe('/usr/bin/ssh');

    const winEnv: SshEnvironment = {
      platform: 'win32',
      isWsl: false,
      homeDir: 'C:\\Users\\test',
      username: 'test',
      env: { SystemRoot: 'C:\\Windows' },
    };
    expect(detectSshExecutablePath('', winEnv)).toBe(
      'C:\\Windows\\System32\\OpenSSH\\ssh.exe',
    );
  });

  it('respects a custom SSH executable path', () => {
    const environment: SshEnvironment = {
      platform: 'linux',
      isWsl: false,
      homeDir: '/home/test',
      username: 'test',
      env: {},
    };
    expect(detectSshExecutablePath('/custom/ssh', environment)).toBe('/custom/ssh');
  });
});
