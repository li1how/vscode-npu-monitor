import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import SSHConfig, { LineType, type Directive, type Line, type Section } from 'ssh-config';

import type { MonitorSettings, SshHost } from './types.js';

export interface SshEnvironment {
  platform: NodeJS.Platform;
  isWsl: boolean;
  homeDir: string;
  username: string;
  env: NodeJS.ProcessEnv;
}

export interface LoadedSshConfig {
  configPath: string;
  knownHostsPath?: string;
  sshExecutablePath: string;
  hosts: SshHost[];
  warnings: string[];
}

export function currentSshEnvironment(remoteName?: string): SshEnvironment {
  return {
    platform: process.platform,
    isWsl: process.platform === 'linux' &&
      (remoteName === 'wsl' || Boolean(process.env.WSL_DISTRO_NAME)),
    homeDir: os.homedir(),
    username: os.userInfo().username,
    env: process.env,
  };
}

function expandEnvironmentVariables(value: string, environment: SshEnvironment): string {
  let expanded = value
    .replace(/[$][{]env:([^}]+)[}]/gi, (_, name: string) => environment.env[name] ?? '')
    .replace(/%([^%]+)%/g, (_, name: string) => environment.env[name] ?? '');
  if (expanded === '~' || expanded.startsWith('~/') || expanded.startsWith('~\\')) {
    expanded = path.join(environment.homeDir, expanded.slice(2));
  }
  return expanded;
}

export function windowsPathToWsl(value: string): string {
  const match = /^([a-zA-Z]):[\\/](.*)$/.exec(value);
  if (!match) {
    return value.replace(/\\/g, '/');
  }
  const drive = match[1]?.toLowerCase();
  const tail = match[2]?.replace(/\\/g, '/');
  return '/mnt/' + drive + '/' + tail;
}

function resolveConfiguredPath(value: string, environment: SshEnvironment): string {
  const expanded = expandEnvironmentVariables(value, environment);
  return environment.isWsl ? windowsPathToWsl(expanded) : expanded;
}

export function detectSshConfigPath(
  configuredPath: string,
  remoteSshConfigFile: string,
  environment: SshEnvironment,
): string {
  if (configuredPath) {
    return resolveConfiguredPath(configuredPath, environment);
  }
  if (remoteSshConfigFile) {
    return resolveConfiguredPath(remoteSshConfigFile, environment);
  }
  const candidates: string[] = [];
  if (environment.platform === 'win32') {
    candidates.push(path.win32.join(environment.homeDir, '.ssh', 'config'));
  } else {
    if (environment.isWsl) {
      candidates.push('/mnt/c/Users/' + environment.username + '/.ssh/config');
      const userProfile = environment.env.USERPROFILE;
      if (userProfile) {
        candidates.push(windowsPathToWsl(userProfile + '\\.ssh\\config'));
      }
    }
    candidates.push(path.join(environment.homeDir, '.ssh', 'config'));
  }
  const detected = candidates.find(candidate => existsSync(candidate));
  if (!detected) {
    throw new Error('No SSH configuration file was found. Set npuMonitor.sshConfigPath.');
  }
  return detected;
}

export function detectSshExecutablePath(
  configuredPath: string,
  environment: SshEnvironment,
): string {
  if (configuredPath) {
    return resolveConfiguredPath(configuredPath, environment);
  }
  if (environment.platform === 'win32') {
    const systemRoot = environment.env.SystemRoot ?? 'C:\\Windows';
    return path.win32.join(systemRoot, 'System32', 'OpenSSH', 'ssh.exe');
  }
  return '/usr/bin/ssh';
}

function directiveValues(directive: Directive): string[] {
  if (typeof directive.value === 'string') {
    return directive.value.match(/(?:[^\s"]+|"[^"]*")+/g)?.map(value =>
      value.replace(/^"(.*)"$/, '$1'),
    ) ?? [];
  }
  return directive.value.map(value => value.val);
}

function isSection(line: Line): line is Section {
  return line.type === LineType.DIRECTIVE &&
    'config' in line &&
    (line.param.toLowerCase() === 'host' || line.param.toLowerCase() === 'match');
}

function globMatches(pattern: string, host: string): boolean {
  const escaped = pattern
    .replace(/[.+^{}$()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp('^' + escaped + '$', 'i').test(host);
}

function hostSectionMatches(section: Section, alias: string): boolean {
  const patterns = directiveValues(section);
  let matched = false;
  for (const pattern of patterns) {
    if (pattern.startsWith('!') && globMatches(pattern.slice(1), alias)) {
      return false;
    }
    if (!pattern.startsWith('!') && globMatches(pattern, alias)) {
      matched = true;
    }
  }
  return matched;
}

function applyDirective(
  values: Map<string, string | string[]>,
  directive: Directive,
): void {
  const key = directive.param.toLowerCase();
  const items = directiveValues(directive);
  if (items.length === 0) {
    return;
  }
  if (key === 'identityfile') {
    const current = values.get(key);
    const identityFiles = Array.isArray(current) ? current : [];
    identityFiles.push(...items);
    values.set(key, identityFiles);
  } else if (!values.has(key)) {
    values.set(key, items.join(' '));
  }
}

function computeSafeConfig(config: SSHConfig, alias: string): Map<string, string | string[]> {
  const values = new Map<string, string | string[]>();
  for (const line of config) {
    if (line.type !== LineType.DIRECTIVE) {
      continue;
    }
    if (isSection(line)) {
      if (line.param.toLowerCase() !== 'host' || !hostSectionMatches(line, alias)) {
        continue;
      }
      for (const nestedLine of line.config) {
        if (nestedLine.type === LineType.DIRECTIVE && !isSection(nestedLine)) {
          applyDirective(values, nestedLine);
        }
      }
      continue;
    }
    applyDirective(values, line);
  }
  return values;
}

function literalAliases(config: SSHConfig): string[] {
  const aliases = new Set<string>();
  for (const line of config) {
    if (!isSection(line) || line.param.toLowerCase() !== 'host') {
      continue;
    }
    for (const alias of directiveValues(line)) {
      if (!alias.startsWith('!') && !/[*?]/.test(alias)) {
        aliases.add(alias);
      }
    }
  }
  return [...aliases];
}

function stringValue(values: Map<string, string | string[]>, key: string): string | undefined {
  const value = values.get(key);
  return typeof value === 'string' ? value : undefined;
}

export function loadSshHosts(
  settings: MonitorSettings,
  environment: SshEnvironment,
): LoadedSshConfig {
  const configPath = detectSshConfigPath(
    settings.sshConfigPath,
    settings.remoteSshConfigFile,
    environment,
  );
  const text = readFileSync(configPath, 'utf8');
  const config = SSHConfig.parse(text);
  const warnings: string[] = [];
  const excluded = new Set(settings.excludedHosts.map(host => host.toLowerCase()));

  if (config.some(line =>
    line.type === LineType.DIRECTIVE && !isSection(line) &&
    line.param.toLowerCase() === 'include')) {
    warnings.push('Include directives are not expanded by NPU Monitor.');
  }
  if (config.some(line => isSection(line) && line.param.toLowerCase() === 'match')) {
    warnings.push('Match sections are ignored by NPU Monitor.');
  }

  const configuredKnownHosts = settings.knownHostsPath
    ? resolveConfiguredPath(settings.knownHostsPath, environment)
    : path.join(path.dirname(configPath), 'known_hosts');
  const knownHostsPath = settings.knownHostsPath || existsSync(configuredKnownHosts)
    ? configuredKnownHosts
    : undefined;
  const sshExecutablePath = detectSshExecutablePath(settings.sshExecutablePath, environment);

  const hosts: SshHost[] = [];
  for (const alias of literalAliases(config)) {
    if (excluded.has(alias.toLowerCase())) {
      continue;
    }
    const computed = computeSafeConfig(config, alias);
    const hostname = stringValue(computed, 'hostname') ?? alias;
    const portText = stringValue(computed, 'port');
    const port = portText ? Number.parseInt(portText, 10) : undefined;
    const identityValue = computed.get('identityfile');
    const identityFiles = (Array.isArray(identityValue) ? identityValue : [])
      .map(value => resolveConfiguredPath(value, environment));
    const aliasAcceptedByOpenSsh = /^[a-zA-Z0-9._-]+$/.test(alias);

    hosts.push({
      alias,
      hostname,
      user: stringValue(computed, 'user'),
      port: Number.isInteger(port) ? port : undefined,
      identityFiles,
      proxyJump: stringValue(computed, 'proxyjump'),
      configPath,
      knownHostsPath,
      useAlias: environment.platform === 'win32' || aliasAcceptedByOpenSsh,
    });
  }

  hosts.sort((left, right) => left.alias.localeCompare(right.alias, undefined, {
    numeric: true,
  }));
  return { configPath, knownHostsPath, sshExecutablePath, hosts, warnings };
}
