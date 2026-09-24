import { request } from 'node:http';
import { createServer } from 'node:net';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MonitorHttpServer } from '../../src/mcp/server.js';
import { hostState } from '../../src/mcp/tools.js';
import { getSettings } from '../../src/settings.js';
import type { HostRecord } from '../../src/types.js';
import { configurationValues, resetVscodeMock } from '../mocks/vscode.js';

// Use direct loopback HTTP regardless of developer proxy environment.
const localFetch: typeof fetch = async (input, init) => new Promise((resolve, reject) => {
  const req = request(String(input), {
    agent: false, method: init?.method ?? 'GET', headers: Object.fromEntries(new Headers(init?.headers).entries()),
  }, res => {
    const chunks: Buffer[] = [];
    res.on('data', chunk => chunks.push(Buffer.from(chunk)));
    res.on('end', () => resolve(new Response(res.statusCode === 202 || res.statusCode === 204 ? null : Buffer.concat(chunks), {
      status: res.statusCode, headers: res.headers as Record<string, string>,
    })));
  });
  req.on('error', reject);
  req.end(init?.body);
});

const token = 'a'.repeat(64);
const record: HostRecord = {
  host: { alias: 'node(A3)', hostname: '10.0.0.1', configPath: '/tmp/ssh config',
    identityFiles: ['/secret/key'], useAlias: true },
  state: 'idle', subscribed: true, refreshing: false, stale: false, idleStreak: 1, idleNotified: false,
  snapshot: { source: 'npu-smi', collectedAt: Date.now(), durationMs: 1, partial: false,
    devices: [{ id: '0', health: 'OK', utilizationPercent: 0, processes: [] }] },
  devContainers: { state: 'ready', refreshing: false, stale: false,
    snapshot: { collectedAt: Date.now(), durationMs: 1, containers: [
      { id: 'f'.repeat(64), isDevContainer: true, name: 'dev', state: 'running', image: 'test', createdAt: '', workspaceFolder: '/work/me' },
      { id: 'e'.repeat(64), isDevContainer: false, name: 'other', state: 'exited', image: 'test', createdAt: '' },
    ] } },
};
const service = { getRecords: () => [record], getRecord: (alias: string) => alias === record.host.alias ? record : undefined,
  scanAliases: vi.fn(async () => {}),
  scanContainerAliases: vi.fn(async () => {}),
  listHostImages: vi.fn(async (host: string) => ({ host, collectedAt: Date.now(), state: 'ready', images: [] })),
  getIdleHistory: (alias: string) => ({ alias, retentionDays: 7, cards: [] }),
  getIdleCandidates: () => [{ alias: record.host.alias, durationMs: 60000, idleDevices: 1,
    deviceCount: 1, deviceId: '0', observedAt: record.snapshot!.collectedAt,
    collectedAt: record.snapshot!.collectedAt, ageSeconds: 0, maxAgeSeconds: 360,
    validUntil: record.snapshot!.collectedAt + 360000, outdated: false as const }],
};
const servers: MonitorHttpServer[] = [];
const clients: Client[] = [];
async function freePort() {
  const s = createServer();
  await new Promise<void>(r => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>(r => s.close(() => r()));
  return port;
}
async function setup() {
  const port = await freePort();
  const server = new MonitorHttpServer(service, getSettings);
  servers.push(server);
  await server.start(port, token);
  return { port, url: `http://127.0.0.1:${port}/mcp`, server };
}
async function connect(url: string) {
  const client = new Client({ name: 'test', version: '1' });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { fetch: localFetch, requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}
afterEach(async () => {
  await Promise.all(clients.splice(0).map(c => c.close()));
  await Promise.all(servers.splice(0).map(s => s.stop()));
  service.scanAliases.mockClear(); service.scanContainerAliases.mockClear();
  service.listHostImages.mockClear(); resetVscodeMock();
});

describe('MCP snapshots', () => {
  it('filters cached data, keeps complete IDs and excludes SSH secrets', () => {
    const data = hostState(record, getSettings(), true);
    expect(data.containers.count).toBe(1);
    expect(data.npu.idle).toBe(true);
    expect(JSON.stringify(data)).not.toContain('/secret');
    configurationValues.set('npuMonitor.containers.filterMode', 'all');
    expect(hostState(record, getSettings(), true).containers.count).toBe(2);
    configurationValues.set('npuMonitor.containers.filterMode', 'workspacePaths');
    configurationValues.set('npuMonitor.containers.workspacePaths', ['/elsewhere']);
    expect(hostState(record, getSettings(), true).containers.count).toBe(0);
    expect(service.scanAliases).not.toHaveBeenCalled();
  });
  it('reports separate NPU expiry and container observation age without a container TTL', () => {
    const settings = getSettings();
    const collectedAt = record.snapshot!.collectedAt;
    const atBoundary = hostState(record, settings, false, collectedAt + 360000);
    expect(atBoundary.npu).toMatchObject({ maxAgeSeconds: 360, validUntil: collectedAt + 360000,
      outdated: false });
    const expired = hostState(record, settings, false, collectedAt + 360001);
    expect(expired.npu).toMatchObject({ outdated: true, idle: null });
    expect(expired.containers).toMatchObject({ maxAgeSeconds: null, validUntil: null,
      outdated: null, stale: false });
    expect(expired.containers.ageSeconds).toBeGreaterThan(300);
    const failed = hostState({ ...record, devContainers: { ...record.devContainers!,
      state: 'timeout', stale: true } }, settings, false, collectedAt + 360001);
    expect(failed.containers).toMatchObject({ stale: true, outdated: null });
    expect(hostState({ ...record, devContainers: undefined }, settings, false, collectedAt).containers)
      .toMatchObject({ collectedAt: null, ageSeconds: null, validUntil: null, outdated: null });
  });
  it('does not infer idle from expired, partial or failed data', () => {
    expect(hostState(record, getSettings(), false, record.snapshot!.collectedAt + 360001).npu.idle).toBeNull();
    for (const patch of [{ stale: true }, { state: 'error' as const }, { snapshot: undefined }]) {
      expect(hostState({ ...record, ...patch }, getSettings(), false).npu.idle).toBeNull();
    }
    expect(hostState({ ...record, snapshot: { ...record.snapshot!, partial: true } }, getSettings(), false).npu.idle).toBeNull();
  });
});

describe('HTTP MCP', () => {
  it('initializes two clients and queries caches without SSH; refreshes deduplicated aliases', async () => {
    const { url } = await setup();
    const [a, b] = await Promise.all([connect(url), connect(url)]);
    expect((await a.listTools()).tools.map(t => t.name)).toEqual(['list_hosts', 'get_host_state', 'get_idle_history', 'rank_idle_hosts', 'refresh_hosts', 'refresh_containers', 'list_host_images']);
    const results = await Promise.all([a.callTool({ name: 'list_hosts' }), b.callTool({ name: 'get_host_state', arguments: { host: record.host.alias } })]);
    expect(results.every(r => !r.isError)).toBe(true);
    expect(results[0]?.structuredContent).toMatchObject({ hosts: [{ npu: { maxAgeSeconds: 360 },
      containers: { validUntil: null, outdated: null } }] });
    expect(results[1]?.structuredContent).toMatchObject({ npu: { maxAgeSeconds: 360 },
      containers: { validUntil: null, outdated: null } });
    expect(service.scanAliases).not.toHaveBeenCalled();
    expect((await a.callTool({ name: 'refresh_hosts', arguments: { hosts: ['missing'] } })).isError).toBe(true);
    expect((await a.callTool({ name: 'refresh_hosts', arguments: { hosts: [] } })).isError).toBe(true);
    expect(service.scanAliases).not.toHaveBeenCalled();
    const rank = await a.callTool({ name: 'rank_idle_hosts' });
    expect(rank.structuredContent).toMatchObject({ candidates: [{ alias: record.host.alias,
      deviceId: '0', maxAgeSeconds: 360, validUntil: record.snapshot!.collectedAt + 360000,
      outdated: false }] });
    const history = await b.callTool({ name: 'get_idle_history', arguments: { host: record.host.alias } });
    expect(history.structuredContent).toMatchObject({ history: { alias: record.host.alias, cards: [] } });
    expect(service.scanAliases).not.toHaveBeenCalled();
    const refreshed = await a.callTool({ name: 'refresh_hosts', arguments: { hosts: [record.host.alias, record.host.alias] } });
    expect(refreshed.structuredContent).toMatchObject({ hosts: [{ npu: { maxAgeSeconds: 360 },
      containers: { validUntil: null, outdated: null } }] });
    expect(service.scanAliases).toHaveBeenCalledExactlyOnceWith([record.host.alias]);
    const npuTime = record.snapshot?.collectedAt;
    await a.callTool({ name: 'refresh_containers', arguments: { hosts: [record.host.alias, record.host.alias] } });
    expect(service.scanContainerAliases).toHaveBeenCalledExactlyOnceWith([record.host.alias]);
    expect(record.snapshot?.collectedAt).toBe(npuTime);
    expect((await b.callTool({ name: 'list_host_images', arguments: { host: record.host.alias } })).structuredContent)
      .toMatchObject({ host: record.host.alias, images: [] });
    expect(service.listHostImages).toHaveBeenCalledExactlyOnceWith(record.host.alias);
  });
  it('rejects unauthorized, foreign origin/host, invalid paths and malformed requests', async () => {
    const { url } = await setup();
    expect((await localFetch(url, { method: 'POST' })).status).toBe(401);
    const headers = { Authorization: `Bearer ${token}` };
    expect((await localFetch(url, { method: 'POST', headers: { ...headers, Origin: 'https://evil.example' } })).status).toBe(403);
    expect((await localFetch(url, { method: 'POST', headers: { ...headers, Host: 'evil.example' } })).status).toBe(403);
    expect((await localFetch(url + '/bad', { method: 'POST', headers })).status).toBe(404);
    expect((await localFetch(url, { headers })).status).toBe(405);
    expect((await localFetch(url, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: '{' })).status).toBe(400);
  });
  it('reports occupied ports and releases listeners for restart', async () => {
    const { port, server } = await setup();
    const second = new MonitorHttpServer(service, getSettings); servers.push(second);
    await expect(second.start(port, token)).rejects.toMatchObject({ code: 'EADDRINUSE' });
    await server.stop();
    await second.start(port, token);
  });
});
