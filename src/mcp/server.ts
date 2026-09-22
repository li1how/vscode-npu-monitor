import { timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import type { MonitorSettings } from '../types.js';
import { createMonitorMcp, type MonitorReader } from './tools.js';

export class MonitorHttpServer {
  private server?: Server;
  private readonly connections = new Set<() => Promise<void>>();

  public constructor(private readonly service: MonitorReader, private readonly settings: () => MonitorSettings) {}

  public async start(port: number, token: string): Promise<void> {
    if (!token) throw new Error('Missing MCP token');
    const server = createServer((req, res) => {
      const reject = (status: number): void => { res.writeHead(status); res.end(); };
      const host = req.headers.host;
      const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
      if (!host || !allowedHosts.includes(host)) return reject(403);
      if (req.headers.origin && !allowedHosts.map(h => 'http://' + h).includes(req.headers.origin)) return reject(403);
      const actual = Buffer.from(req.headers.authorization ?? '');
      const expected = Buffer.from('Bearer ' + token);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return reject(401);
      if (req.url !== '/mcp') return reject(404);
      if (req.method !== 'POST') return reject(405);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      const mcp = createMonitorMcp(this.service, this.settings);
      const close = async (): Promise<void> => { this.connections.delete(close); await mcp.close(); };
      this.connections.add(close);
      res.on('close', () => { void close(); });
      void mcp.connect(transport).then(() => transport.handleRequest(req, res)).catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
        void close();
      });
    });
    server.requestTimeout = 30_000;
    server.headersTimeout = 10_000;
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
    });
  }

  public async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    await Promise.allSettled([...this.connections].map(close => close()));
    if (server) await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
  }
}
