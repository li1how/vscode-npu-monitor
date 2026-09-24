import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { filterContainers } from '../containers/filter.js';
import type { MonitorService } from '../monitorService.js';
import { evaluateSnapshot } from '../npu/idle.js';
import type { HostRecord, MonitorSettings } from '../types.js';

export type MonitorReader = Pick<MonitorService,
  'getRecords' | 'getRecord' | 'scanAliases' | 'scanContainerAliases' | 'listHostImages' | 'getIdleHistory' | 'getIdleCandidates'>;

export function hostState(record: HostRecord, settings: MonitorSettings, details: boolean, now = Date.now()) {
  const observation = (collectedAt: number | undefined, stale: boolean) => ({
    collectedAt: collectedAt ?? null,
    ageSeconds: collectedAt === undefined ? null : Math.max(0, now - collectedAt) / 1000,
    stale,
  });
  const npuCollectedAt = record.snapshot?.collectedAt;
  const npuMaxAgeSeconds = settings.pollIntervalSeconds * 2;
  const npuTime = {
    ...observation(npuCollectedAt, record.stale),
    maxAgeSeconds: npuMaxAgeSeconds,
    validUntil: npuCollectedAt === undefined ? null : npuCollectedAt + npuMaxAgeSeconds * 1000,
    outdated: npuCollectedAt === undefined || now < npuCollectedAt ||
      now - npuCollectedAt > npuMaxAgeSeconds * 1000,
  };
  const containerTime = {
    ...observation(record.devContainers?.snapshot?.collectedAt, record.devContainers?.stale ?? false),
    maxAgeSeconds: null,
    validUntil: null,
    outdated: null,
  };
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
    containers: { ...containerTime,
      enabled: settings.devContainersEnabled, state: record.devContainers?.state ?? 'unknown',
      refreshing: record.devContainers?.refreshing ?? false, error: record.devContainers?.error ?? null,
      filterMode: settings.containerFilterMode, workspacePaths: settings.containerWorkspacePaths,
      count: containers.length, ...(details ? { items: containers } : {}) },
  };
}

export function createMonitorMcp(service: MonitorReader, settings: () => MonitorSettings): McpServer {
  const server = new McpServer({ name: 'npu-monitor', version: '1.0.0' }, {
    instructions: 'Queries read cached snapshots and idle history. NPU snapshots expire after twice the poll interval; container snapshots have no fixed expiry, so check their collectedAt, ageSeconds and stale fields. rank_idle_hosts uses only fresh NPU observations; idle is not a reservation. refresh_hosts refreshes NPU and containers; refresh_containers refreshes only containers. list_host_images queries read-only Docker image metadata. Neither reserves resources or changes subscriptions. Initialization and execution belong to external tools.',
  });
  const result = (data: Record<string, unknown>) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(data) }], structuredContent: data,
  });
  const annotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  const withHistory = (record: HostRecord, details: boolean) => {
    const history = service.getIdleHistory(record.host.alias);
    return {
      ...hostState(record, settings(), details),
      idleHistory: details ? history : {
        alias: history.alias,
        retentionDays: history.retentionDays,
        cards: history.cards.map(({ id, state, observedAt, idleSince }) =>
          ({ id, state, observedAt, idleSince })),
      },
    };
  };
  server.registerTool('list_hosts', { description: 'List cached host summaries; no SSH queries.', annotations },
    () => result({ hosts: service.getRecords().map(r => withHistory(r, false)) }));
  server.registerTool('get_host_state', {
    description: 'Read cached NPU, process and filtered container details for one SSH alias.',
    inputSchema: { host: z.string().min(1) }, annotations,
  }, ({ host }) => {
    const record = service.getRecord(host);
    if (!record) throw new Error('Unknown SSH host');
    return result(withHistory(record, true));
  });
  server.registerTool('get_idle_history', {
    description: 'Read cached per-NPU idle history for one SSH alias; no SSH query.',
    inputSchema: { host: z.string().min(1) }, annotations,
  }, ({ host }) => {
    if (!service.getRecord(host)) throw new Error('Unknown SSH host');
    return result({ history: service.getIdleHistory(host) });
  });
  server.registerTool('rank_idle_hosts', {
    description: 'Rank recently observed idle hosts by continuous idle duration; no SSH query.',
    annotations,
  }, () => result({ candidates: service.getIdleCandidates() }));
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
      return record ? withHistory(record, true) : { host: alias, error: 'Host removed' };
    }) });
  });
  server.registerTool('refresh_containers', {
    description: 'Refresh only Dev Container metadata for selected SSH aliases; NPU snapshots are unchanged.',
    inputSchema: { hosts: z.array(z.string().min(1)).min(1).max(100) },
    annotations: { ...annotations, openWorldHint: true },
  }, async ({ hosts }) => {
    const aliases = [...new Set(hosts)];
    if (aliases.some(alias => !service.getRecord(alias) || service.getRecord(alias)?.state === 'missingConfig')) {
      throw new Error('Unknown or unavailable SSH host');
    }
    await service.scanContainerAliases(aliases);
    return result({ hosts: aliases.map(alias => {
      const record = service.getRecord(alias);
      return record ? withHistory(record, true) : { host: alias, error: 'Host removed' };
    }) });
  });
  server.registerTool('list_host_images', {
    description: 'Query at most 20 vLLM-Ascend Docker image candidates on one SSH host; read-only.',
    inputSchema: { host: z.string().min(1) },
    annotations: { ...annotations, openWorldHint: true },
  }, async ({ host }) => {
    if (!service.getRecord(host) || service.getRecord(host)?.state === 'missingConfig') {
      throw new Error('Unknown or unavailable SSH host');
    }
    return result(await service.listHostImages(host));
  });
  return server;
}
