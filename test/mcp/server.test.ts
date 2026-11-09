import { request } from 'node:http';
import { createServer } from 'node:net';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';

import { MonitorHttpServer } from '../../src/mcp/server.js';
import { getSettings } from '../../src/settings.js';
import { resetVscodeMock } from '../mocks/vscode.js';
import { fixture } from './fixtures.js';

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
const { service, records } = fixture();
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
  service.refreshAliases.mockClear();
  records.splice(1); resetVscodeMock();
});

describe('HTTP MCP', () => {
  it('exposes five bounded tools and shares cursor snapshots across clients and HTTP requests', async () => {
    const original = records[0]!;
    for (let index = 2; index <= 15; index++) records.push({ ...original, host: { ...original.host, alias: 'node-' + index } });
    const { url } = await setup();
    const [a, b] = await Promise.all([connect(url), connect(url)]);
    const definitions = (await a.listTools()).tools;
    expect(definitions.map(tool => tool.name)).toEqual(['get_overview', 'query_hosts', 'inspect_host', 'get_history', 'refresh_hosts']);
    expect(definitions.every(tool => tool.outputSchema && tool.inputSchema)).toBe(true);
    const first = await a.callTool({ name: 'query_hosts' });
    expect(first.isError).not.toBe(true);
    expect(Object.keys(first.structuredContent ?? {}).sort()).toEqual(['asOf', 'data', 'page']);
    expect(first.structuredContent).toMatchObject({ page: { total: 15, returned: 10 }, data: { totalHosts: 15 } });
    const cursor = (first.structuredContent as any).page.nextCursor;
    const second = await b.callTool({ name: 'query_hosts', arguments: { cursor } });
    expect(second.structuredContent).toMatchObject({ asOf: (first.structuredContent as any).asOf, page: { total: 15, returned: 5, nextCursor: null } });
    const detail = await b.callTool({ name: 'inspect_host', arguments: { host: original.host.alias, section: 'connection' } });
    expect(detail.structuredContent).toMatchObject({ data: { connection: { alias: original.host.alias, sshConfig: '/tmp/config' } } });
    expect(JSON.stringify(detail)).not.toContain('/secret');
    expect(JSON.parse((detail.content as any)[0].text)).toEqual(detail.structuredContent);
    const unknownDevice = await a.callTool({ name: 'inspect_host', arguments: {
      host: original.host.alias, section: 'processes', deviceId: '999999',
    } });
    expect(unknownDevice.isError).toBe(true);
    expect(unknownDevice.structuredContent).toMatchObject({ error: { code: 'UNKNOWN_CARD' } });
    const idleDevice = await a.callTool({ name: 'inspect_host', arguments: {
      host: original.host.alias, section: 'processes', deviceId: '0',
    } });
    expect(idleDevice.isError).not.toBe(true);
    expect(idleDevice.structuredContent).toMatchObject({ data: { processes: [] }, page: { total: 0 } });
    expect(service.refreshAliases).not.toHaveBeenCalled();
    for (const args of [{ hosts: ['missing'] }, { hosts: [] }, { hosts: Array(21).fill(original.host.alias) }]) {
      expect((await a.callTool({ name: 'refresh_hosts', arguments: args })).isError).toBe(true);
    }
    expect(service.refreshAliases).not.toHaveBeenCalled();
    const refreshed = await a.callTool({ name: 'refresh_hosts', arguments: { hosts: [original.host.alias, original.host.alias] } });
    expect(service.refreshAliases).toHaveBeenCalledExactlyOnceWith([original.host.alias], 'npu');
    expect(refreshed.structuredContent).toMatchObject({ data: { scope: 'npu', hosts: [{ host: original.host.alias, npu: { success: true } }] } });
    expect(JSON.stringify(refreshed)).not.toContain('bins');
    const history = await a.callTool({ name: 'get_history', arguments: { host: original.host.alias } });
    expect(history.structuredContent).toMatchObject({ data: { mode: 'summary' } });
    for (const name of ['list_hosts', 'get_host_state', 'get_idle_history', 'rank_idle_hosts', 'refresh_containers', 'list_host_images']) {
      expect((await a.callTool({ name })).isError).toBe(true);
    }
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
