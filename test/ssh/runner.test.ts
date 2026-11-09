import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

import type * as vscode from 'vscode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SshRunner } from '../../src/ssh/runner.js';
import { makeHost } from '../helpers/fixtures.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

class SshChild extends EventEmitter {
  public readonly stdout = new EventEmitter();
  public readonly stderr = new EventEmitter();
  public killed = false;
  public readonly kill = vi.fn(() => {
    this.killed = true;
    return true;
  });
}

function cancellation() {
  const emitter = new EventEmitter();
  let cancelled = false;
  const dispose = vi.fn(() => emitter.removeAllListeners('cancel'));
  const token: vscode.CancellationToken = {
    get isCancellationRequested() { return cancelled; },
    onCancellationRequested(listener) {
      emitter.on('cancel', listener);
      return { dispose };
    },
  };
  return {
    token, dispose,
    cancel() { cancelled = true; emitter.emit('cancel'); },
  };
}

describe('SSH process execution', () => {
  let child: SshChild;
  const runner = new SshRunner({ executablePath: '/test/ssh', connectTimeoutSeconds: 8 });

  beforeEach(() => {
    vi.useFakeTimers();
    child = new SshChild();
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetAllMocks();
  });

  it('collects stdout and stderr without a local shell, then releases timeout and cancellation handlers', async () => {
    const request = cancellation();
    const result = runner.run(makeHost(), 'npu-smi info', 1000, request.token);
    expect(spawn).toHaveBeenCalledWith('/test/ssh', expect.arrayContaining([
      'BatchMode=yes', 'StrictHostKeyChecking=yes', 'UpdateHostKeys=no', 'npu-smi info',
    ]), { windowsHide: true, shell: false });
    child.stdout.emit('data', Buffer.from('first\n'));
    child.stdout.emit('data', Buffer.from('second\n'));
    child.stderr.emit('data', Buffer.from('warning'));
    child.emit('close', 0);
    await expect(result).resolves.toEqual({ stdout: 'first\nsecond\n', stderr: 'warning' });
    expect(vi.getTimerCount()).toBe(0);
    expect(request.dispose).toHaveBeenCalledOnce();
    request.cancel();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('reports spawn errors and releases timeout and cancellation handlers', async () => {
    const request = cancellation();
    const result = runner.run(makeHost(), 'npu-smi info', 1000, request.token);
    child.emit('error', new Error('spawn ENOENT'));
    await expect(result).rejects.toMatchObject({ kind: 'error', message: 'spawn ENOENT', stderr: '' });
    expect(vi.getTimerCount()).toBe(0);
    expect(request.dispose).toHaveBeenCalledOnce();
  });

  it.each([
    ['Connection timed out', 'timeout'],
    ['Permission denied (publickey)', 'authError'],
    ['Host key verification failed.', 'hostKeyError'],
    ['No route to host', 'unreachable'],
    ['unexpected failure', 'error'],
  ])('classifies a nonzero exit: %s', async (stderr, kind) => {
    const request = cancellation();
    const result = runner.run(makeHost(), 'npu-smi info', 1000, request.token);
    child.stderr.emit('data', Buffer.from(stderr));
    child.emit('close', 255);
    await expect(result).rejects.toMatchObject({ kind, message: stderr, stderr });
    expect(vi.getTimerCount()).toBe(0);
    expect(request.dispose).toHaveBeenCalledOnce();
  });

  it('terminates a timed-out process and preserves the timeout classification', async () => {
    const request = cancellation();
    const result = runner.run(makeHost(), 'npu-smi info', 1000, request.token);
    vi.advanceTimersByTime(1000);
    expect(child.kill).toHaveBeenCalledOnce();
    child.emit('close', null);
    await expect(result).rejects.toMatchObject({ kind: 'timeout' });
    expect(request.dispose).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('terminates a cancelled process and reports cancellation even if it exits successfully', async () => {
    const request = cancellation();
    const result = runner.run(makeHost(), 'npu-smi info', 1000, request.token);
    request.cancel();
    expect(child.kill).toHaveBeenCalledOnce();
    child.emit('close', 0);
    await expect(result).rejects.toMatchObject({ kind: 'error', message: 'Scan cancelled.' });
    expect(request.dispose).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['stdout', 'stderr'] as const)('bounds %s output by bytes and terminates once', async stream => {
    const request = cancellation();
    const result = runner.run(makeHost(), 'npu-smi info', 1000, request.token);
    child[stream].emit('data', Buffer.alloc(4 * 1024 * 1024, 'a'));
    expect(child.kill).not.toHaveBeenCalled();
    child[stream].emit('data', Buffer.from('中'));
    expect(child.kill).toHaveBeenCalledOnce();
    child[stream].emit('data', Buffer.from('more'));
    expect(child.kill).toHaveBeenCalledOnce();
    // Output limits remain an error even when the process exits with code zero.
    child.emit('close', 0);
    await expect(result).rejects.toMatchObject({ kind: 'error', message: 'Remote output exceeded 4 MiB.' });
    expect(request.dispose).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
