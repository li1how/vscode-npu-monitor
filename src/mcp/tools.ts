import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { version } from '../../package.json';
import type { MonitorSettings } from '../types.js';
import { getHistory } from './history.js';
import { inspectHost, overview, queryHosts, refreshHosts, SECTIONS, type MonitorReader } from './queries.js';
import { bounded, failure, type QueryResult, SnapshotPages } from './results.js';

export type { MonitorReader } from './queries.js';
const pageInput = {
  limit: z.number().int().min(1).max(50).default(10).describe('Maximum rows; the response byte budget may reduce the page size.'),
  cursor: z.string().min(1).max(1024).optional().describe('Previous nextCursor; keep the other query conditions unchanged.'),
};
const host = z.string().min(1).max(512);
const query = z.string().trim().min(1).max(256).optional();
const state = z.enum(['unknown', 'refreshing', 'idle', 'busy', 'partial', 'unhealthy', 'unreachable',
  'timeout', 'authError', 'hostKeyError', 'unsupported', 'error', 'missingConfig']);
const outputSchema = {
  asOf: z.number(), data: z.record(z.string(), z.unknown()),
  page: z.object({ total: z.number().int(), returned: z.number().int(), nextCursor: z.string().nullable() }).optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
};

export function createMonitorMcp(service: MonitorReader, settings: () => MonitorSettings, pages = new SnapshotPages()): McpServer {
  const server = new McpServer({ name: 'npu-monitor', version }, {
    instructions: 'Queries read caches; only refresh_hosts runs SSH collection. NPU observations expire after twice the poll interval; containers have no fixed expiry. Pages use fixed asOf snapshots. Idle is not a reservation. Subscriptions and remote resources are unchanged.',
  });
  const execute = async (operation: () => QueryResult | Promise<QueryResult>) => {
    let data: QueryResult;
    try { data = bounded(await operation()); } catch (error) { data = failure(error); }
    return { content: [{ type: 'text' as const, text: JSON.stringify(data) }],
      structuredContent: { ...data }, ...(data.error ? { isError: true } : {}) };
  };
  const annotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  server.registerTool('get_overview', {
    description: 'Read cached resource totals, model distribution and observation coverage.',
    inputSchema: pageInput, outputSchema, annotations,
  }, input => execute(() => overview(service, settings(), pages, input)));
  server.registerTool('query_hosts', {
    description: 'Search and filter cached hosts and visible containers. Returns paginated resource summaries with freshness; conditions intersect.',
    inputSchema: { ...pageInput,
      query: query.describe('Case-insensitive alias, address, note or container name/image/workspace search.'),
      model: z.string().trim().min(1).max(256).optional().describe('Exact reported model name, case-insensitive.'),
      minIdleCards: z.number().int().min(1).optional().describe('Minimum confirmed idle devices, independent of notification idleScope.'),
      minIdleSeconds: z.number().min(0).optional().describe('Minimum longest continuous idle duration among devices.'),
      state: state.optional(), favorite: z.boolean().optional(), subscribed: z.boolean().optional(),
      sort: z.enum(['name', 'idleCards', 'idleDuration']).default('name').describe('Name ascending; idle counts or durations descending, then name.') }, outputSchema, annotations,
  }, input => execute(() => queryHosts(service, settings(), pages, input)));
  server.registerTool('inspect_host', {
    description: 'Read a cached host summary or one selected detail section.',
    inputSchema: { ...pageInput, host, section: z.enum(SECTIONS).default('summary'),
      deviceId: z.string().min(1).max(128).optional().describe('Existing cached device ID for the processes section.'),
      query: query.describe('Container search for the containers section.'),
      containerId: z.string().min(1).max(128).optional().describe('Full container ID; required for the container section.') },
    outputSchema, annotations,
  }, input => execute(() => inspectHost(service, settings(), pages, input)));
  server.registerTool('get_history', {
    description: 'Read per-device observation counts and coverage, or paginated 15-minute history buckets.',
    inputSchema: { ...pageInput, host, cards: z.array(z.string().min(1).max(128)).min(1).max(128).optional(),
      from: z.number().int().min(0).optional().describe('Unix milliseconds within retention; defaults to 24 hours before to.'),
      to: z.number().int().min(0).optional().describe('Unix milliseconds; defaults to now.'),
      mode: z.enum(['summary', 'buckets']).default('summary') }, outputSchema, annotations,
  }, input => execute(() => getHistory(service, settings(), pages, input)));
  server.registerTool('refresh_hosts', {
    description: 'Refresh NPU or container caches for selected hosts. Returns per-source status and collection times.',
    inputSchema: { ...pageInput,
      cursor: pageInput.cursor.describe('Continue stored refresh results without collecting again.'),
      hosts: z.array(host).min(1).max(20), scope: z.enum(['npu', 'containers', 'both']).default('npu') },
    outputSchema, annotations: { ...annotations, openWorldHint: true },
  }, input => execute(() => refreshHosts(service, settings(), pages, input)));
  return server;
}
