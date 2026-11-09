import { randomUUID } from 'node:crypto';

export const RESULT_BYTES = 16 * 1024;
const CURSOR_TTL_MS = 120_000;
const MAX_SNAPSHOTS = 32;
const CACHE_BYTES = 8 * 1024 * 1024;

export interface QueryResult {
  asOf: number;
  data: Record<string, unknown>;
  page?: { total: number; returned: number; nextCursor: string | null };
  error?: { code: string; message: string };
}

export class QueryError extends Error {
  public constructor(public readonly code: string, message: string) { super(message); }
}

export function byteSize(value: unknown): number { return Buffer.byteLength(JSON.stringify(value), 'utf8'); }

export function bounded(result: QueryResult): QueryResult {
  if (byteSize(result) > RESULT_BYTES) {
    throw new QueryError('RESULT_TOO_LARGE', 'Result exceeds 16 KiB. Narrow the query, section or time range.');
  }
  return result;
}

export function failure(error: unknown): QueryResult {
  return { asOf: Date.now(), data: {}, error: error instanceof QueryError
    ? { code: error.code, message: error.message }
    : { code: 'QUERY_FAILED', message: 'The operation failed.' } };
}

interface PageSource {
  data: Record<string, unknown>;
  field: string;
  rows: unknown[];
}
interface Snapshot extends PageSource { key: string; asOf: number; bytes: number }

export class SnapshotPages {
  private readonly snapshots = new Map<string, Snapshot>();

  public clear(): void { this.snapshots.clear(); }

  public page(
    key: string, limit: number, cursor: string | undefined, build: (asOf: number) => PageSource,
  ): QueryResult {
    const now = Date.now();
    for (const [id, snapshot] of this.snapshots) {
      if (now < snapshot.asOf || now - snapshot.asOf >= CURSOR_TTL_MS) this.snapshots.delete(id);
    }
    let id: string;
    let offset = 0;
    let snapshot: Snapshot;
    if (cursor) {
      try {
        const decoded: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
        if (!Array.isArray(decoded) || decoded.length !== 2 || typeof decoded[0] !== 'string' ||
          !Number.isSafeInteger(decoded[1]) || decoded[1] < 0) throw new Error('cursor');
        [id, offset] = decoded as [string, number];
      } catch { throw new QueryError('INVALID_CURSOR', 'Invalid cursor. Repeat the original query without a cursor.'); }
      const saved = this.snapshots.get(id);
      if (!saved || saved.key !== key || offset >= saved.rows.length) {
        throw new QueryError('CURSOR_EXPIRED', 'Cursor expired, was evicted, or belongs to another query. Repeat the original query.');
      }
      snapshot = saved;
    } else {
      id = randomUUID();
      const source = build(now);
      const bytes = byteSize(source);
      if (bytes > CACHE_BYTES) throw new QueryError('RESULT_TOO_LARGE', 'Query snapshot exceeds 8 MiB. Narrow the query or time range.');
      snapshot = { ...structuredClone(source), key, asOf: now, bytes };
    }
    const result = (count: number): QueryResult => ({
      asOf: snapshot.asOf,
      data: { ...snapshot.data, [snapshot.field]: snapshot.rows.slice(offset, offset + count) },
      page: { total: snapshot.rows.length, returned: count,
        nextCursor: offset + count < snapshot.rows.length
          ? Buffer.from(JSON.stringify([id, offset + count])).toString('base64url') : null },
    });
    let count = Math.min(limit, snapshot.rows.length - offset);
    while (count > 0 && byteSize(result(count)) > RESULT_BYTES) count--;
    if (snapshot.rows.length > offset && count === 0) {
      throw new QueryError('RESULT_TOO_LARGE', 'One item exceeds 16 KiB. Choose a narrower section, filter or time range.');
    }
    const output = bounded(result(count));
    if (!cursor && output.page?.nextCursor) {
      while (this.snapshots.size >= MAX_SNAPSHOTS ||
        [...this.snapshots.values()].reduce((sum, value) => sum + value.bytes, 0) + snapshot.bytes > CACHE_BYTES) {
        this.snapshots.delete(this.snapshots.keys().next().value!);
      }
      this.snapshots.set(id, snapshot);
    }
    return output;
  }
}
