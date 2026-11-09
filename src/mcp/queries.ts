import { filterContainers } from '../containers/filter.js';
import { currentNpuState } from '../npu/current.js';
import { npuMaxAgeMs } from '../npu/freshness.js';
import { normalizeNpuModel } from '../npu/model.js';
import type { DevContainer, HostRecord, HostState, MonitorSettings, NpuDevice, NpuProcess } from '../types.js';
import { bounded, QueryError, type QueryResult, type SnapshotPages } from './results.js';
import type { MonitorMcpService, MonitorReader } from './types.js';

export const SECTIONS = ['summary', 'devices', 'processes', 'containers', 'container', 'connection'] as const;
export type Section = typeof SECTIONS[number];
export interface PageInput { limit: number; cursor?: string }
export interface HostQuery extends PageInput {
  query?: string; model?: string; minIdleCards?: number; minIdleSeconds?: number;
  state?: HostState; favorite?: boolean; subscribed?: boolean;
  sort: 'name' | 'idleCards' | 'idleDuration';
}
export interface InspectQuery extends PageInput {
  host: string; section: Section; deviceId?: string; query?: string; containerId?: string;
}

export function queryKey<T extends PageInput>(tool: string, input: T): string {
  const conditions = Object.entries(input).filter(([key]) => key !== 'cursor' && key !== 'limit')
    .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify([tool, conditions]);
}

function observation(collectedAt: number | undefined, stale: boolean, now: number, ttl?: number) {
  return {
    collectedAt: collectedAt ?? null, stale,
    ageSeconds: collectedAt === undefined ? null : Math.max(0, now - collectedAt) / 1000,
    validUntil: collectedAt === undefined || ttl === undefined ? null : collectedAt + ttl,
    outdated: ttl === undefined ? null : collectedAt === undefined || now < collectedAt || now - collectedAt > ttl,
  };
}

export function visibleContainers(record: HostRecord, settings: MonitorSettings): DevContainer[] {
  return settings.devContainersEnabled ? filterContainers(record.devContainers?.snapshot?.containers ?? [], settings) : [];
}

export function freshness(record: HostRecord, settings: MonitorSettings, now: number) {
  return {
    npu: observation(record.snapshot?.collectedAt, record.stale, now, npuMaxAgeMs(settings)),
    containers: observation(record.devContainers?.snapshot?.collectedAt, record.devContainers?.stale ?? false, now),
  };
}

export function hostSummary(service: MonitorReader, record: HostRecord, settings: MonitorSettings, now: number) {
  const current = currentNpuState(record, service.getIdleHistory(record.host.alias, now, false), settings, now);
  const models = [...new Set(record.snapshot?.devices.flatMap(device => {
    const model = normalizeNpuModel(device.model);
    return model ? [model] : [];
  }) ?? [])].sort();
  return {
    host: record.host.alias,
    models: models.slice(0, 50), modelCount: models.length,
    favorite: service.getHostPreference(record.host.alias).favorite, subscribed: record.subscribed,
    npu: { state: record.state, refreshing: record.refreshing, deviceCount: record.snapshot?.devices.length ?? null,
      idleDevices: current.idleCount, longestIdleSeconds: current.longestIdleMs === null ? null : current.longestIdleMs / 1000 },
    containers: { enabled: settings.devContainersEnabled, state: record.devContainers?.state ?? 'unknown',
      refreshing: record.devContainers?.refreshing ?? false, count: visibleContainers(record, settings).length },
    freshness: freshness(record, settings, now),
  };
}

function match(query: string, values: Array<string | undefined>): boolean {
  const text = values.filter(Boolean).join('\n').toLowerCase();
  return query.trim().toLowerCase().split(/\s+/).every(word => text.includes(word));
}

function containerFields(container: DevContainer): Array<string | undefined> {
  return [container.name, container.displayName, container.image, container.workspaceFolder, container.containerWorkspaceFolder];
}

function natural(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true });
}

export function queryHosts(service: MonitorReader, settings: MonitorSettings, pages: SnapshotPages, input: HostQuery) {
  return pages.page(queryKey('query_hosts', input), input.limit, input.cursor, asOf => {
    const rows = service.getRecords().flatMap(record => {
      const summary = hostSummary(service, record, settings, asOf);
      const preference = service.getHostPreference(record.host.alias);
      if (input.state !== undefined && record.state !== input.state ||
          input.favorite !== undefined && preference.favorite !== input.favorite ||
          input.subscribed !== undefined && record.subscribed !== input.subscribed ||
          input.model !== undefined && !record.snapshot?.devices.some(device =>
            normalizeNpuModel(device.model)?.toLowerCase() === input.model!.trim().toLowerCase()) ||
          input.minIdleCards !== undefined && (summary.npu.idleDevices === null || summary.npu.idleDevices < input.minIdleCards) ||
          input.minIdleSeconds !== undefined && (summary.npu.longestIdleSeconds === null || summary.npu.longestIdleSeconds < input.minIdleSeconds)) return [];
      const matchedBy: string[] = [];
      let containerMatch: { id: string; name: string; matchedBy: string } | undefined;
      if (input.query) {
        const nodeFields = [record.host.alias, record.host.hostname, preference.note];
        if (match(input.query, nodeFields)) matchedBy.push('host');
        else {
          const container = visibleContainers(record, settings).find(item => match(input.query!, [...nodeFields, ...containerFields(item)]));
          if (!container) return [];
          matchedBy.push('container');
          containerMatch = { id: container.id, name: container.displayName ?? container.name, matchedBy: 'name/image/workspace' };
        }
      }
      for (const field of ['model', 'minIdleCards', 'minIdleSeconds', 'state', 'favorite', 'subscribed'] as const) {
        if (input[field] !== undefined) matchedBy.push(field);
      }
      return [{ ...summary, matchedBy, ...(containerMatch ? { containerMatch } : {}) }];
    }).sort((a, b) => {
      if (input.sort !== 'name') {
        const field = input.sort === 'idleCards' ? 'idleDevices' : 'longestIdleSeconds';
        const difference = (b.npu[field] ?? -1) - (a.npu[field] ?? -1);
        if (difference) return difference;
      }
      return natural(a.host, b.host);
    });
    return { data: { totalHosts: service.getRecords().length }, rows, field: 'hosts' };
  });
}

export function overview(service: MonitorReader, settings: MonitorSettings, pages: SnapshotPages, input: PageInput) {
  return pages.page(queryKey('get_overview', input), input.limit, input.cursor, asOf => {
    const records = service.getRecords();
    const models = new Map<string | null, { model: string | null; hosts: number; devices: number }>();
    const npu = { deviceCount: 0, observedHosts: 0, freshHosts: 0, idleHosts: 0, idleDevices: 0, confirmedBusyHosts: 0, unknownHosts: 0, errorHosts: 0 };
    const containers = { enabled: settings.devContainersEnabled, observedHosts: 0, staleHosts: 0, errorHosts: 0, count: 0 };
    for (const record of records) {
      const summary = hostSummary(service, record, settings, asOf);
      npu.deviceCount += record.snapshot?.devices.length ?? 0;
      if (record.snapshot) npu.observedHosts++;
      if (record.snapshot && !summary.freshness.npu.outdated && !summary.freshness.npu.stale) npu.freshHosts++;
      if (summary.npu.idleDevices === null) npu.unknownHosts++;
      else if (summary.npu.idleDevices > 0) { npu.idleHosts++; npu.idleDevices += summary.npu.idleDevices; }
      else npu.confirmedBusyHosts++;
      if (!['idle', 'busy', 'unknown', 'refreshing'].includes(record.state)) npu.errorHosts++;
      const counts = new Map<string | null, number>();
      for (const device of record.snapshot?.devices ?? []) {
        const model = normalizeNpuModel(device.model) ?? null;
        counts.set(model, (counts.get(model) ?? 0) + 1);
      }
      for (const [model, count] of counts) {
        const entry = models.get(model) ?? { model, hosts: 0, devices: 0 };
        entry.hosts++; entry.devices += count; models.set(model, entry);
      }
      if (settings.devContainersEnabled) {
        if (record.devContainers?.snapshot) containers.observedHosts++;
        if (record.devContainers?.stale) containers.staleHosts++;
        if (record.devContainers && !['ready', 'unknown', 'refreshing'].includes(record.devContainers.state)) containers.errorHosts++;
        containers.count += summary.containers.count;
      }
    }
    return { data: { totalHosts: records.length, npu, containers }, field: 'models',
      rows: [...models.values()].sort((a, b) => natural(a.model ?? '', b.model ?? '')) };
  });
}

function requireHost(service: MonitorReader, host: string): HostRecord {
  const record = service.getRecord(host);
  if (!record) throw new QueryError('UNKNOWN_HOST', 'Unknown SSH alias.');
  return record;
}

type InspectionFreshness = ReturnType<typeof freshness>['npu'];
type InspectionData = {
  summary: { summary: ReturnType<typeof hostSummary> & {
    note: string; npuError: string | null; containerError: string | null; sections: Section[];
  } };
  connection: { host: string; connection: { alias: string; hostname: string; user: string | null; port: number; sshConfig: string } };
  container: { host: string; freshness: InspectionFreshness; container: DevContainer };
  devices: { host: string; freshness: InspectionFreshness;
    devices: Array<Omit<NpuDevice, 'processes' | 'model'> & { model: string | null; processCount: number }> };
  processes: { host: string; freshness: InspectionFreshness; processes: Array<NpuProcess & { deviceId: string }> };
  containers: { host: string; freshness: InspectionFreshness;
    containers: Array<Pick<DevContainer, 'id' | 'name' | 'state' | 'image'> & { displayName: string | null }> };
};

export function inspectHost<Selected extends Section>(
  service: MonitorReader, settings: MonitorSettings, pages: SnapshotPages, input: InspectQuery & { section: Selected },
): QueryResult<InspectionData[Selected]>;
export function inspectHost(service: MonitorReader, settings: MonitorSettings, pages: SnapshotPages, input: InspectQuery): QueryResult {
  if (input.deviceId !== undefined && input.section !== 'processes' ||
      input.query !== undefined && input.section !== 'containers' ||
      input.containerId !== undefined && input.section !== 'container' ||
      input.section === 'container' && !input.containerId) {
    throw new QueryError('INVALID_SECTION_ARGUMENT', 'Use deviceId with processes, query with containers, and containerId with container.');
  }
  if (['summary', 'container', 'connection'].includes(input.section)) {
    if (input.cursor) throw new QueryError('INVALID_CURSOR', 'This section has no continuation.');
    const record = requireHost(service, input.host);
    const asOf = Date.now();
    let data: InspectionData['summary' | 'connection' | 'container'];
    if (input.section === 'summary') {
      data = { summary: { ...hostSummary(service, record, settings, asOf),
        note: service.getHostPreference(input.host).note,
        npuError: record.error ?? null, containerError: record.devContainers?.error ?? null,
        sections: [...SECTIONS] } };
    } else if (input.section === 'connection') {
      data = { host: input.host, connection: { alias: record.host.alias, hostname: record.host.hostname,
        user: record.host.user ?? null, port: record.host.port ?? 22, sshConfig: record.host.configPath } };
    } else {
      const container = visibleContainers(record, settings).find(item => item.id === input.containerId);
      if (!container) throw new QueryError('UNKNOWN_CONTAINER', 'Container is not in the configured visible cache.');
      data = { host: input.host, freshness: freshness(record, settings, asOf).containers, container };
    }
    return bounded({ asOf, data });
  }
  return pages.page(queryKey('inspect_host', input), input.limit, input.cursor, asOf => {
    const record = requireHost(service, input.host);
    let rows: Array<InspectionData['devices']['devices'][number] |
      InspectionData['processes']['processes'][number] | InspectionData['containers']['containers'][number]>;
    if (input.section === 'devices') {
      rows = (record.snapshot?.devices ?? []).map(({ processes, ...device }) => ({ ...device, model: normalizeNpuModel(device.model) ?? null,
        processCount: device.processCount ?? processes.length }));
    } else if (input.section === 'processes') {
      const devices = record.snapshot?.devices ?? [];
      if (input.deviceId !== undefined && !devices.some(device => device.id === input.deviceId)) {
        throw new QueryError('UNKNOWN_CARD', 'Unknown card ID.');
      }
      rows = devices.filter(device => input.deviceId === undefined || device.id === input.deviceId)
        .flatMap(device => device.processes.map(process => ({ deviceId: device.id, ...process })));
    } else {
      rows = visibleContainers(record, settings).filter(container => !input.query || match(input.query, containerFields(container)))
        .map(container => ({ id: container.id, name: container.name, displayName: container.displayName ?? null,
          state: container.state, image: container.image }));
    }
    return { data: { host: input.host, freshness: freshness(record, settings, asOf)[input.section === 'containers' ? 'containers' : 'npu'] },
      field: input.section, rows };
  });
}

export async function refreshHosts(service: MonitorMcpService, settings: MonitorSettings, pages: SnapshotPages,
  input: PageInput & { hosts: string[]; scope: 'npu' | 'containers' | 'both' }) {
  const hosts = [...new Set(input.hosts)];
  const key = queryKey('refresh_hosts', { ...input, hosts });
  if (!input.cursor && hosts.some(host => !service.getRecord(host) || service.getRecord(host)?.state === 'missingConfig')) {
    throw new QueryError('UNKNOWN_HOST', 'Unknown or unavailable SSH alias.');
  }
  if (!input.cursor && input.scope !== 'npu' && !settings.devContainersEnabled) throw new QueryError('CONTAINERS_DISABLED', 'Container monitoring is disabled.');
  if (!input.cursor) await service.refreshAliases(hosts, input.scope);
  return pages.page(key, input.limit, input.cursor, () => {
    if (input.cursor) throw new QueryError('CURSOR_EXPIRED', 'Repeat refresh without a cursor.');
    return {
      data: { scope: input.scope }, field: 'hosts',
      rows: hosts.map(host => {
        const record = service.getRecord(host);
        if (!record) return { host, error: 'Host removed' };
        const outcome = (state: string, collectedAt: number | undefined, stale: boolean) => ({
          state, collectedAt: collectedAt ?? null, success: !stale && ['idle', 'busy', 'partial', 'unhealthy', 'ready'].includes(state),
        });
        return { host,
          ...(input.scope !== 'containers' ? { npu: outcome(record.state, record.snapshot?.collectedAt, record.stale) } : {}),
          ...(input.scope !== 'npu' ? { containers: outcome(record.devContainers?.state ?? 'unknown', record.devContainers?.snapshot?.collectedAt, record.devContainers?.stale ?? false) } : {}),
        };
      }),
    };
  });
}
