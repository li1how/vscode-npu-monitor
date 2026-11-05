import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadSshHosts, type SshEnvironment } from '../../src/ssh/config.js';
import { buildInteractiveSshArguments, buildSshArguments } from '../../src/ssh/runner.js';
import type { MonitorSettings } from '../../src/types.js';

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    readFileSync: vi.fn(actual.readFileSync),
    statSync: vi.fn(actual.statSync),
  };
});

const settings: MonitorSettings = {
  sshConfigPath: '', remoteSshConfigFile: '', knownHostsPath: '', sshExecutablePath: '',
  connectTimeoutSeconds: 8, exporterProbeTimeoutSeconds: 2, npuSmiTimeoutSeconds: 10,
  maxConcurrentHosts: 8, excludedHosts: [], pollIntervalSeconds: 180,
  autoRefreshAllHosts: false, idleHistoryRetentionDays: 7, idleScope: 'allCards',
  idleRequireNoProcesses: true, idleUtilizationThresholdPercent: 1, idleConsecutiveChecks: 1,
  devContainersEnabled: false, devContainersTimeoutSeconds: 5,
  containerFilterMode: 'devContainers', containerWorkspacePaths: [], containerWorkspaceFile: '',
};
const configText = 'Host alpha\n  HostName 192.0.2.1\n  User root\n';
const directories: string[] = [];

afterEach(() => {
  vi.resetAllMocks();
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'npu-known-hosts-'));
  directories.push(directory);
  const homeDir = path.join(directory, 'extension user');
  const configDirectory = path.join(directory, 'shared config');
  fs.mkdirSync(path.join(homeDir, '.ssh'), { recursive: true });
  fs.mkdirSync(configDirectory);
  const configPath = path.join(configDirectory, 'config');
  fs.writeFileSync(configPath, configText);
  const environment: SshEnvironment = {
    platform: process.platform, isWsl: false, homeDir, username: 'extension-user', env: {},
  };
  const besideConfig = path.join(configDirectory, 'known_hosts');
  const inHome = path.join(homeDir, '.ssh', 'known_hosts');
  return {
    directory, configPath, environment, besideConfig, inHome,
    load: (overrides: Partial<MonitorSettings> = {}) => loadSshHosts(
      { ...settings, sshConfigPath: configPath, ...overrides }, environment,
    ),
  };
}

describe('automatic known_hosts discovery', () => {
  it.each([
    { configExists: true, homeExists: true },
    { configExists: true, homeExists: false },
    { configExists: false, homeExists: true },
    { configExists: false, homeExists: false },
  ])('uses existing files: config=$configExists, home=$homeExists', ({ configExists, homeExists }) => {
    const context = fixture();
    if (configExists) fs.writeFileSync(context.besideConfig, '');
    if (homeExists) fs.writeFileSync(context.inHome, '');
    const expected = [
      ...(configExists ? [JSON.stringify(context.besideConfig)] : []),
      ...(homeExists ? [JSON.stringify(context.inHome)] : []),
    ].join(' ') || undefined;
    const loaded = context.load();
    expect(loaded.knownHostsPath).toBe(expected);
    expect(loaded.hosts[0]?.knownHostsPath).toBe(expected);
    if (!expected) {
      expect(buildSshArguments(loaded.hosts[0]!, 8, 'npu-smi info'))
        .not.toEqual(expect.arrayContaining([expect.stringMatching(/^UserKnownHostsFile=/)]));
    }
  });

  it.skipIf(process.platform === 'win32')('uses the WSL extension user home with a shared config', () => {
    const context = fixture();
    context.environment.isWsl = true;
    context.environment.env.USERPROFILE = 'C:\\Users\\different-windows-user';
    fs.writeFileSync(context.besideConfig, '');
    fs.writeFileSync(context.inHome, '');
    expect(context.load().knownHostsPath).toBe(
      JSON.stringify(context.besideConfig) + ' ' + JSON.stringify(context.inHome),
    );
  });

  it('deduplicates the config directory and the user SSH directory', () => {
    const context = fixture();
    fs.writeFileSync(context.inHome, '');
    const configPath = path.join(context.environment.homeDir, '.ssh', 'config');
    fs.writeFileSync(configPath, configText);
    expect(context.load({ sshConfigPath: configPath }).knownHostsPath)
      .toBe(JSON.stringify(context.inHome));
  });

  it('ignores directories named known_hosts', () => {
    const context = fixture();
    fs.mkdirSync(context.besideConfig);
    fs.writeFileSync(context.inHome, '');
    expect(context.load().knownHostsPath).toBe(JSON.stringify(context.inHome));
  });

  it.skipIf(process.platform === 'win32')('accepts symlinks to regular files and ignores broken links', () => {
    const context = fixture();
    const target = path.join(context.directory, 'trusted-hosts');
    fs.writeFileSync(target, '');
    fs.symlinkSync(target, context.besideConfig);
    fs.symlinkSync(path.join(context.directory, 'missing'), context.inHome);
    expect(context.load().knownHostsPath).toBe(JSON.stringify(context.besideConfig));
  });

  it.skipIf(process.platform === 'win32')('quotes literal backslashes and double quotes in automatic paths', () => {
    const context = fixture();
    const configDirectory = path.join(context.directory, 'shared\\"config');
    fs.mkdirSync(configDirectory);
    const configPath = path.join(configDirectory, 'config');
    fs.writeFileSync(configPath, configText);
    fs.writeFileSync(path.join(configDirectory, 'known_hosts'), '');
    expect(context.load({ sshConfigPath: configPath }).knownHostsPath)
      .toBe('"' + context.directory + '/shared\\\\\\"config/known_hosts"');
  });

  it('passes both files as one option to scans and interactive terminals', () => {
    const context = fixture();
    fs.writeFileSync(context.besideConfig, '');
    fs.writeFileSync(context.inHome, '');
    const host = context.load().hosts[0]!;
    const scan = buildSshArguments(host, 8, 'npu-smi info');
    const interactive = buildInteractiveSshArguments(host, 8);
    for (const args of [scan, interactive]) {
      expect(args.filter(arg => arg.startsWith('UserKnownHostsFile='))).toEqual([
        'UserKnownHostsFile=' + JSON.stringify(context.besideConfig) + ' ' + JSON.stringify(context.inHome),
      ]);
      const optionIndex = args.findIndex(arg => arg.startsWith('UserKnownHostsFile='));
      expect(args[optionIndex - 1]).toBe('-o');
      expect(args).toContain('StrictHostKeyChecking=yes');
      expect(args).toContain('UpdateHostKeys=no');
    }
    expect(scan).toContain('BatchMode=yes');
    expect(interactive).toContain('BatchMode=no');
  });
});

describe('Windows known_hosts discovery', () => {
  function windowsFixture(configPath: string, homeDir: string) {
    const context = fixture();
    const fileStats = fs.statSync(context.configPath);
    vi.mocked(fs.readFileSync).mockReturnValue(configText);
    vi.mocked(fs.statSync).mockReturnValue(fileStats);
    return loadSshHosts({ ...settings, sshConfigPath: configPath }, {
      platform: 'win32', isWsl: false, homeDir, username: 'extension-user', env: {},
    });
  }

  it('uses Windows directory semantics and quotes spaces and backslashes', () => {
    const loaded = windowsFixture('D:\\Shared SSH\\config', 'C:\\Users\\Extension User');
    expect(loaded.knownHostsPath).toBe(
      '"D:\\\\Shared SSH\\\\known_hosts" "C:\\\\Users\\\\Extension User\\\\.ssh\\\\known_hosts"',
    );
    expect(vi.mocked(fs.statSync)).toHaveBeenCalledWith('D:\\Shared SSH\\known_hosts');
    expect(vi.mocked(fs.statSync)).toHaveBeenCalledWith('C:\\Users\\Extension User\\.ssh\\known_hosts');
  });

  it('deduplicates normalized Windows paths without changing retained casing', () => {
    const loaded = windowsFixture('C:/Users/ME/.ssh/../.ssh/config', 'c:\\users\\me');
    expect(loaded.knownHostsPath).toBe('"C:\\\\Users\\\\ME\\\\.ssh\\\\known_hosts"');
  });
});

describe('explicit known_hosts settings', () => {
  it.each([
    { value: '/custom/missing_known_hosts', expected: '/custom/missing_known_hosts' },
    { value: '/first/known_hosts /second/known_hosts', expected: '/first/known_hosts /second/known_hosts' },
    { value: '"/first user/known_hosts" "/second user/known_hosts"', expected: '"/first user/known_hosts" "/second user/known_hosts"' },
    { value: '${env:TRUST_DIR}/known_hosts', expected: '/custom/known_hosts' },
    { value: '%TRUST_DIR%/known_hosts', expected: '/custom/known_hosts' },
  ])('keeps explicit $value without adding automatic files', ({ value, expected }) => {
    const context = fixture();
    context.environment.env.TRUST_DIR = '/custom';
    fs.writeFileSync(context.besideConfig, '');
    fs.writeFileSync(context.inHome, '');
    const host = context.load({ knownHostsPath: value }).hosts[0]!;
    expect(host.knownHostsPath).toBe(expected);
    expect(buildSshArguments(host, 8, 'npu-smi info')
      .filter(arg => arg.startsWith('UserKnownHostsFile=')))
      .toEqual(['UserKnownHostsFile=' + expected]);
  });

  it('expands an explicit home path even when the file does not exist', () => {
    const context = fixture();
    expect(context.load({ knownHostsPath: '~/.ssh/custom_known_hosts' }).knownHostsPath)
      .toBe(path.join(context.environment.homeDir, '.ssh', 'custom_known_hosts'));
  });

  it.skipIf(process.platform === 'win32')('converts an explicit Windows path in WSL', () => {
    const context = fixture();
    context.environment.isWsl = true;
    expect(context.load({ knownHostsPath: 'D:\\SSH\\known_hosts' }).knownHostsPath)
      .toBe('/mnt/d/SSH/known_hosts');
  });
});
