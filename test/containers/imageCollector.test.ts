import { describe, expect, it, vi } from 'vitest';

import { ImageCollector } from '../../src/containers/images.js';
import { SshExecutionError } from '../../src/ssh/runner.js';

const id = 'sha256:' + 'a'.repeat(64);
const host = { alias: 'node' } as never;

describe('ImageCollector', () => {
  it('uses only read-only Docker commands and returns selected metadata', async () => {
    const run = vi.fn()
      .mockResolvedValueOnce({ stdout: JSON.stringify({ Repository: 'team/vllm-ascend', Tag: 'dev', ID: id }) + '\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: JSON.stringify({ id, tags: ['team/vllm-ascend:dev'], createdAt: '2026-01-01', architecture: 'arm64', os: 'linux' }) + '\n', stderr: '' });
    const result = await new ImageCollector({ run } as never).list(host);
    expect(result.state).toBe('ready');
    expect(result.images).toEqual([{ id, tags: ['team/vllm-ascend:dev'], createdAt: '2026-01-01', architecture: 'arm64', os: 'linux' }]);
    expect(run.mock.calls.map(call => call[1])).toEqual([
      "docker image ls --filter 'reference=*vllm*ascend*' --no-trunc --format '{{json .}}'",
      expect.stringContaining('docker image inspect --format'),
    ]);
    expect(run.mock.calls[1]?.[1]).not.toMatch(/docker (?:pull|run|rm|exec)|Config\.Env/);
  });
  it('bounds candidates and reports SSH and Docker failures', async () => {
    const listing = Array.from({ length: 25 }, (_, index) => JSON.stringify({
      Repository: 'vllm-ascend', ID: 'sha256:' + index.toString(16).padStart(64, '0'),
    })).join('\n');
    const run = vi.fn().mockResolvedValueOnce({ stdout: listing, stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' });
    const result = await new ImageCollector({ run } as never).list(host);
    expect(result.images).toEqual([]);
    expect(run.mock.calls[1]?.[1].match(/sha256:/g)).toHaveLength(20);
    run.mockReset().mockRejectedValue(new SshExecutionError('timeout', 'Timed out', ''));
    expect(await new ImageCollector({ run } as never).list(host)).toMatchObject({ state: 'timeout', images: [] });
    run.mockReset().mockRejectedValue(new Error('docker: command not found'));
    expect(await new ImageCollector({ run } as never).list(host)).toMatchObject({ state: 'missingDocker', images: [] });
    run.mockReset().mockRejectedValue(new SshExecutionError('error', 'permission denied', 'permission denied'));
    expect(await new ImageCollector({ run } as never).list(host)).toMatchObject({ state: 'permissionDenied', images: [] });
  });

  it('rejects invalid IDs before forming the inspect command', async () => {
    const run = vi.fn().mockResolvedValue({ stdout: JSON.stringify({ Repository: 'vllm-ascend', ID: '$(bad)' }), stderr: '' });
    expect(await new ImageCollector({ run } as never).list(host)).toMatchObject({ state: 'error', images: [], error: 'Invalid Docker image ID' });
    expect(run).toHaveBeenCalledTimes(1);
  });
});
