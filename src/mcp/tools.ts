import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { filterContainers } from '../containers/filter.js';
import type { MonitorService } from '../monitorService.js';
import { evaluateSnapshot } from '../npu/idle.js';
import type { HostRecord, MonitorSettings } from '../types.js';

export type MonitorReader = Pick<MonitorService, 'getRecords' | 'getRecord' | 'scanAliases'>;

export function hostState(record: HostRecord, settings: MonitorSettings, details: boolean, now = Date.now()) {
  const freshness = (collectedAt: number | undefined, stale: boolean) => ({
    collectedAt: collectedAt ?? null,
    ageSeconds: collectedAt === undefined ? null : Math.max(0, now - collectedAt) / 1000,
    stale,
    outdated: collectedAt === undefined || now - collectedAt > settings.pollIntervalSeconds * 2000,
  });
  const npuTime = freshness(record.snapshot?.collectedAt, record.stale);
  const containers = settings.devContainersEnabled
    ? filterContainers(record.devContainers?.snapshot?.containers ?? [], settings) : [];
  const valid = !npuTime.stale && !npuTime.outdated &&
    ['idle', 'busy'].includes(record.state) && record.snapshot && !record.snapshot.partial;
  const idle = valid ? evaluateSnapshot(record.snapshot!, settings) : null;
  return {
    host: { alias: record.host.alias, hostname: record.host.hostname,
      user: record.host.user ?? null, port: record.host.port ?? 22, sshConfig: record.host.configPath },
    subscribed: record.subscribed,
    npu: { ...npuTime, state: record.state, refreshing: record.refreshing,
      error: record.error ?? null, idle: idle ? idle.state === 'idle' : null,
      idleDevices: idle?.idleDevices ?? null, deviceCount: record.snapshot?.devices.length ?? null,
      ...(details ? { devices: record.snapshot?.devices ?? [] } : {}) },
    containers: { ...freshness(record.devContainers?.snapshot?.collectedAt, record.devContainers?.stale ?? false),
      enabled: settings.devContainersEnabled, state: record.devContainers?.state ?? 'unknown',
      refreshing: record.devContainers?.refreshing ?? false, error: record.devContainers?.error ?? null,
      filterMode: settings.containerFilterMode, workspacePaths: settings.containerWorkspacePaths,
      count: containers.length, ...(details ? { items: containers } : {}) },
  };
}

export function createMonitorMcp(service: MonitorReader, settings: () => MonitorSettings): McpServer {
  const server = new McpServer({ name: 'npu-monitor', version: '1.0.0' }, {
    instructions: 'Queries read cached snapshots. Check collectedAt, stale and outdated before choosing a host. Idle is not a reservation. refresh_hosts explicitly refreshes selected SSH aliases without changing subscriptions. Initialization and execution belong to external tools.',
  });
  const result = (data: Record<string, unknown>) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(data) }], structuredContent: data,
  });
  const annotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  server.registerTool('list_hosts', { description: 'List cached host summaries; no SSH queries.', annotations },
    () => result({ hosts: service.getRecords().map(r => hostState(r, settings(), false)) }));
  server.registerTool('get_host_state', {
    description: 'Read cached NPU, process and filtered container details for one SSH alias.',
    inputSchema: { host: z.string().min(1) }, annotations,
  }, ({ host }) => {
    const record = service.getRecord(host);
    if (!record) throw new Error('Unknown SSH host');
    return result(hostState(record, settings(), true));
  });
  server.registerTool('refresh_hosts', {
    description: 'Refresh explicitly named SSH hosts and return snapshots; does not subscribe hosts.',
    inputSchema: { hosts: z.array(z.string().min(1)).min(1).max(100) },
    annotations: { ...annotations, openWorldHint: true },
  }, async ({ hosts }) => {
    const aliases = [...new Set(hosts)];
    if (aliases.some(alias => !service.getRecord(alias) || service.getRecord(alias)?.state === 'missingConfig')) {
      throw new Error('Unknown or unavailable SSH host');
    }
    await service.scanAliases(aliases);
    return result({ hosts: aliases.map(alias => {
      const record = service.getRecord(alias);
      return record ? hostState(record, settings(), true) : { host: alias, error: 'Host removed' };
    }) });
  });
  return server;
}
