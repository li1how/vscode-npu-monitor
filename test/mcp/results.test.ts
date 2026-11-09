import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { bounded, byteSize, RESULT_BYTES, SnapshotPages } from '../../src/mcp/results.js';

let pages: SnapshotPages;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2026, 10, 9));
  pages = new SnapshotPages();
});
afterEach(() => vi.useRealTimers());

describe('bounded result snapshots', () => {
  it('preserves saved rows while allowing continuation with a different page size', () => {
    const source = { data: { host: 'node-1' }, field: 'rows', rows: [{ value: 1 }, { value: 2 }, { value: 3 }] };
    const build = vi.fn(() => source);
    const first = pages.page('one', 1, undefined, build);
    source.rows[1]!.value = 99;
    const second = pages.page('one', 2, first.page.nextCursor!, build);
    expect(second.data.rows).toEqual([{ value: 2 }, { value: 3 }]);
    expect(second.page).toEqual({ total: 3, returned: 2, nextCursor: null });
    expect(second.asOf).toBe(first.asOf);
    expect(build).toHaveBeenCalledOnce();
  });

  it('rejects malformed cursors and invalidates snapshots on expiry or clear', () => {
    const build = () => ({ data: {}, field: 'rows', rows: [1, 2] });
    for (const value of ['bad', JSON.stringify(['id']), JSON.stringify(['id', -1]), JSON.stringify(['id', 0.5])]) {
      const cursor = Buffer.from(value).toString('base64url');
      expect(() => pages.page('one', 1, cursor, build)).toThrow('Invalid cursor');
    }
    const cursor = pages.page('one', 1, undefined, build).page.nextCursor!;
    vi.advanceTimersByTime(120000);
    expect(() => pages.page('one', 1, cursor, build)).toThrow('expired');
    const next = pages.page('one', 1, undefined, build).page.nextCursor!;
    pages.clear();
    expect(() => pages.page('one', 1, next, build)).toThrow('evicted');
  });

  it('reduces pages by UTF-8 bytes and rejects oversized rows, metadata and snapshots', () => {
    const build = () => ({ data: {}, field: 'rows', rows: Array.from({ length: 50 }, () => ({ value: '界'.repeat(2000) })) });
    const first = pages.page('one', 50, undefined, build);
    expect(first.page.returned).toBeLessThan(50);
    expect(first.page.nextCursor).toBeTruthy();
    expect(byteSize(first)).toBeLessThanOrEqual(RESULT_BYTES);
    expect(() => pages.page('large', 1, undefined, () => ({ ...build(), rows: [{ value: 'x'.repeat(RESULT_BYTES) }] }))).toThrow('One item');
    expect(() => bounded({ asOf: Date.now(), data: { text: 'x'.repeat(RESULT_BYTES) } })).toThrow('16 KiB');
    expect(() => pages.page('huge', 1, undefined, () => ({
      data: {}, field: 'rows', rows: ['x'.repeat(8 * 1024 * 1024)],
    }))).toThrow('8 MiB');
  });

  it('evicts retained snapshots by count and total bytes', () => {
    const build = () => ({ data: {}, field: 'rows', rows: Array.from({ length: 50 }, () => ({ value: 'x'.repeat(2000) })) });
    const first = pages.page('one', 1, undefined, build);
    for (let index = 0; index < 32; index++) pages.page('other-' + index, 1, undefined, build);
    expect(() => pages.page('one', 1, first.page.nextCursor!, build)).toThrow('evicted');
    pages.clear();
    const big = () => ({ data: {}, field: 'rows', rows: Array.from({ length: 500 }, () => ({ value: 'x'.repeat(10000) })) });
    const before = pages.page('big-one', 1, undefined, big);
    pages.page('big-two', 1, undefined, big);
    expect(() => pages.page('big-one', 1, before.page.nextCursor!, big)).toThrow('evicted');
  });
});
