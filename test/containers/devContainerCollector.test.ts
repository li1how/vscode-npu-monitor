import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { buildDevContainerScanCommand, DevContainerCollector, parseDevContainerOutput } from '../../src/containers/collector.js';
import { getSettings } from '../../src/settings.js';
import { SshExecutionError } from '../../src/ssh/runner.js';

const id = 'a'.repeat(64);
const metadata = {
  id, name: '/workspace', image: 'image:dev', state: 'running',
  createdAt: '2026-09-13T00:00:00Z', startedAt: '2026-09-13T01:00:00Z',
  workspaceFolder: '/data/workspace', configFile: '/data/workspace/.devcontainer/devcontainer.json',
};

function envelope(data = '', status = 'inspect', code = 0): string {
  return `__NPU_MONITOR_DOCKER_STATUS__${status}\n__NPU_MONITOR_DOCKER_BEGIN__\n${data}\n__NPU_MONITOR_DOCKER_END__\n${code}\n`;
}

describe('Dev Container collection', () => {
  it('parses selected metadata, normalizes names, deduplicates IDs and sorts containers', () => {
    const other = { ...metadata, id: 'b'.repeat(64), name: '/aaa', configuredName: 'AAA', state: 'exited', startedAt: '0001-01-01T00:00:00Z' };
    const result = parseDevContainerOutput(envelope([metadata, other, metadata].map(x => JSON.stringify(x)).join('\n')));
    expect(result.state).toBe('ready');
    expect(result.snapshot?.containers.map(x => x.name)).toEqual(['aaa', 'workspace']);
    expect(result.snapshot?.containers[0]?.startedAt).toBeUndefined();
  });

  it.each([
    { workspaceFolder: '/modern', configFile: null },
    { workspaceFolder: null, configFile: '/config.json' },
    { workspaceFolder: null, configFile: null, legacyFolder: '/legacy' },
  ])('recognizes each supported label independently: %j', labels => {
    expect(parseDevContainerOutput(envelope(JSON.stringify({ ...metadata, ...labels })))
      .snapshot?.containers).toMatchObject([{ isDevContainer: true }]);
  });

  it('prefers the modern workspace label and falls back to the legacy label when empty', () => {
    const parse = (workspaceFolder: string) => parseDevContainerOutput(envelope(JSON.stringify({
      ...metadata, workspaceFolder, legacyFolder: '/legacy',
    }))).snapshot!.containers[0]!;
    expect(parse('/modern').workspaceFolder).toBe('/modern');
    expect(parse('').workspaceFolder).toBe('/legacy');
  });

  it('retains ordinary containers with an explicit type and accepts an empty successful scan', () => {
    expect(parseDevContainerOutput(envelope(JSON.stringify({ ...metadata, workspaceFolder: null, configFile: null })))
      .snapshot?.containers).toMatchObject([{ isDevContainer: false, name: 'workspace' }]);
    expect(parseDevContainerOutput(envelope()).snapshot?.containers).toEqual([]);
  });

  it('preserves spaces, quotes, unicode and newlines without interpreting them', () => {
    const folder = '/data/中文 "quotes"\n`id` $(whoami)';
    const result = parseDevContainerOutput(envelope(JSON.stringify({ ...metadata, workspaceFolder: folder })));
    expect(result.snapshot?.containers[0]?.workspaceFolder).toBe(folder);
  });

  it('maps the labeled workspace into its actual container bind mount', () => {
    const workspaceFolder = '/home/user/project/中文 space';
    const result = parseDevContainerOutput(envelope(JSON.stringify({
      ...metadata, workspaceFolder, mounts: [
        { type: 'bind', source: '/home/user/project', destination: '/workspaces/project' },
      ],
    }) + '\n__NPU_MONITOR_WORKSPACE_FILE__' + id), 'project.code-workspace');
    expect(result.snapshot?.containers[0]?.containerWorkspaceFolder).toBe('/workspaces/project/中文 space');
    expect(result.snapshot?.containers[0]?.containerWorkspaceFile)
      .toBe('/workspaces/project/中文 space/project.code-workspace');
    expect(parseDevContainerOutput(envelope(JSON.stringify(metadata)))
      .snapshot?.containers[0]?.containerWorkspaceFolder).toBeUndefined();
  });

  it.each([
    ['missingDocker', '', 'missingDocker'],
    ['error', 'permission denied while trying to connect to the Docker daemon socket', 'permissionDenied'],
    ['error', 'Cannot connect to the Docker daemon. Is the docker daemon running?', 'daemonUnavailable'],
    ['error', 'unexpected docker failure', 'error'],
  ])('classifies %s / %s separately from SSH authentication', (status, message, expected) => {
    expect(parseDevContainerOutput(envelope(message, status)).state).toBe(expected);
  });

  it('keeps successful entries if another listed container was removed', () => {
    const result = parseDevContainerOutput(envelope(JSON.stringify(metadata) +
      '\nError: No such container: ' + 'b'.repeat(64), 'inspect', 1));
    expect(result.state).toBe('ready');
    expect(result.snapshot?.containers).toHaveLength(1);
    expect(parseDevContainerOutput(envelope('Error: No such object: ' + id, 'inspect', 1)).snapshot?.containers).toEqual([]);
  });

  it('does not treat other inspect failures as an empty or successful scan', () => {
    const result = parseDevContainerOutput(envelope(JSON.stringify(metadata) + '\npermission denied', 'inspect', 1));
    expect(result.state).toBe('permissionDenied');
    expect(result.snapshot).toBeUndefined();
    expect(parseDevContainerOutput(envelope('', 'inspect', 1)).state).toBe('error');
  });

  it.each(['garbage', envelope('{invalid'), envelope('{}'), envelope('', 'bad'),
    envelope(JSON.stringify({ ...metadata, id: 'not-an-id' })),
    envelope(JSON.stringify({ ...metadata, name: undefined }))])('rejects incomplete or invalid output', output => {
    expect(() => parseDevContainerOutput(output)).toThrow();
  });

  it('uses only read-only Docker operations and requests no environment variables', () => {
    const command = buildDevContainerScanCommand('project.code-workspace');
    expect(command).toContain('docker ps -a --no-trunc');
    expect(command).toContain('docker inspect --type container');
    expect(command).toContain('[ -f "$workspace/$workspace_file" ]');
    for (const label of ['devcontainer.local_folder', 'devcontainer.config_file', 'vsch.local.folder']) {
      expect(command).toContain(label);
    }
    expect(command).not.toMatch(/sudo|Config\.Env|docker (?:run|exec|start|stop|rm|pull)|eval /);
    expect(buildDevContainerScanCommand('../secret.code-workspace')).not.toContain('../secret.code-workspace');
  });

  it.skipIf(process.platform === 'win32')('executes the generated POSIX shell command with a Docker stub, including a removal race', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'dev-container-shell-'));
    try {
      const workspaceFile = '项目 \'quoted\' $(touch PWNED).code-workspace';
      const shellMetadata = {
        ...metadata,
        workspaceFolder: dir,
        workspaceFile: undefined,
        mounts: [{ type: 'bind', source: dir, destination: '/workspaces/project' }],
      };
      writeFileSync(path.join(dir, workspaceFile), 'workspace contents must not be returned');
      writeFileSync(path.join(dir, 'docker'), `#!/bin/sh\nif [ "$1" = ps ]; then\n printf '%s\\n' '${id}' '${'b'.repeat(64)}'\nelif [ "\${5#'{{if'}" != "$5" ]; then\n printf '%s\\n' '${dir}'\nelse\n cat <<'DATA'\n${JSON.stringify(shellMetadata)}\nError: No such container: ${'b'.repeat(64)}\nDATA\n exit 1\nfi\n`, { mode: 0o755 });
      const output = execFileSync('/bin/sh', ['-c', buildDevContainerScanCommand(workspaceFile)], {
        cwd: dir, env: { ...process.env, PATH: dir + ':' + process.env.PATH }, encoding: 'utf8',
      });
      expect(parseDevContainerOutput(output, workspaceFile).snapshot?.containers).toMatchObject([{
        containerWorkspaceFile: '/workspaces/project/' + workspaceFile,
      }]);
      expect(output).not.toContain('workspace contents must not be returned');
      expect(existsSync(path.join(dir, 'PWNED'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes the independent timeout and cancellation token to the shared runner', async () => {
    const run = vi.fn().mockResolvedValue({ stdout: envelope(), stderr: '' });
    const collector = new DevContainerCollector({ run } as never, getSettings());
    const token = { isCancellationRequested: false };
    await collector.scan({ alias: 'host' } as never, token as never);
    expect(run.mock.calls[0]?.[2]).toBe(13000);
    expect(run.mock.calls[0]?.[3]).toBe(token);
    run.mockRejectedValue(new SshExecutionError('timeout', 'Timed out', ''));
    expect((await collector.scan({} as never)).state).toBe('timeout');
    run.mockRejectedValue(new SshExecutionError('authError', 'SSH permission denied', ''));
    expect((await collector.scan({} as never)).state).toBe('authError');
  });
});
