import { spawn } from 'node:child_process';

import type * as vscode from 'vscode';

import type { SshHost } from './types.js';

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export type SshErrorKind =
  | 'timeout'
  | 'authError'
  | 'hostKeyError'
  | 'unreachable'
  | 'error';

export class SshExecutionError extends Error {
  public constructor(
    public readonly kind: SshErrorKind,
    message: string,
    public readonly stderr: string,
  ) {
    super(message);
  }
}

export interface SshRunnerOptions {
  executablePath: string;
  connectTimeoutSeconds: number;
}

function classifySshError(stderr: string, timedOut: boolean): SshErrorKind {
  if (timedOut || /connection timed out|operation timed out/i.test(stderr)) {
    return 'timeout';
  }
  if (/permission denied|authentication failed/i.test(stderr)) {
    return 'authError';
  }
  if (/remote host identification has changed|host key verification failed/i.test(stderr)) {
    return 'hostKeyError';
  }
  if (/no route to host|connection refused|could not resolve hostname|network is unreachable/i.test(stderr)) {
    return 'unreachable';
  }
  return 'error';
}

export function buildSshArguments(
  host: SshHost,
  connectTimeoutSeconds: number,
  remoteCommand: string,
): string[] {
  return [
    ...buildBaseSshArguments(host, connectTimeoutSeconds, 'yes'),
    remoteCommand,
  ];
}

export function buildInteractiveSshArguments(
  host: SshHost,
  connectTimeoutSeconds: number,
): string[] {
  return buildBaseSshArguments(host, connectTimeoutSeconds, 'no');
}

function buildBaseSshArguments(
  host: SshHost,
  connectTimeoutSeconds: number,
  batchMode: 'yes' | 'no',
): string[] {
  const args = [
    '-F',
    host.configPath,
    '-o',
    'BatchMode=' + batchMode,
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    'UpdateHostKeys=no',
    '-o',
    'ConnectionAttempts=1',
    '-o',
    'ConnectTimeout=' + Math.max(1, Math.floor(connectTimeoutSeconds)),
  ];
  if (host.knownHostsPath) {
    args.push('-o', 'UserKnownHostsFile=' + host.knownHostsPath);
  }
  if (host.useAlias) {
    args.push(host.alias);
  } else {
    if (host.port) {
      args.push('-p', String(host.port));
    }
    for (const identityFile of host.identityFiles) {
      args.push('-i', identityFile);
    }
    if (host.proxyJump) {
      args.push('-J', host.proxyJump);
    }
    args.push(host.user ? host.user + '@' + host.hostname : host.hostname);
  }
  return args;
}

export class SshRunner {
  public constructor(private readonly options: SshRunnerOptions) {}

  public async run(
    host: SshHost,
    remoteCommand: string,
    totalTimeoutMs: number,
    cancellationToken?: vscode.CancellationToken,
  ): Promise<{ stdout: string; stderr: string }> {
    const args = buildSshArguments(
      host,
      this.options.connectTimeoutSeconds,
      remoteCommand,
    );
    return new Promise((resolve, reject) => {
      const child = spawn(this.options.executablePath, args, {
        windowsHide: true,
        shell: false,
      });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let outputTooLarge = false;

      const terminate = (): void => {
        if (!child.killed) {
          child.kill();
        }
      };
      const timeout = setTimeout(() => {
        timedOut = true;
        terminate();
      }, totalTimeoutMs);
      const cancellation = cancellationToken?.onCancellationRequested(terminate);

      const append = (current: string, chunk: Buffer): string => {
        const next = current + chunk.toString('utf8');
        if (Buffer.byteLength(next) > MAX_OUTPUT_BYTES) {
          outputTooLarge = true;
          terminate();
        }
        return next;
      };
      child.stdout.on('data', chunk => {
        stdout = append(stdout, chunk as Buffer);
      });
      child.stderr.on('data', chunk => {
        stderr = append(stderr, chunk as Buffer);
      });
      child.on('error', error => {
        clearTimeout(timeout);
        cancellation?.dispose();
        reject(new SshExecutionError('error', error.message, stderr));
      });
      child.on('close', code => {
        clearTimeout(timeout);
        cancellation?.dispose();
        if (cancellationToken?.isCancellationRequested) {
          reject(new SshExecutionError('error', 'Scan cancelled.', stderr));
          return;
        }
        if (outputTooLarge) {
          reject(new SshExecutionError('error', 'Remote output exceeded 4 MiB.', stderr));
          return;
        }
        if (code !== 0 || timedOut) {
          const kind = classifySshError(stderr, timedOut);
          const detail = stderr.trim() || 'SSH exited with code ' + String(code);
          reject(new SshExecutionError(kind, detail, stderr));
          return;
        }
        resolve({ stdout, stderr });
      });
    });
  }
}
