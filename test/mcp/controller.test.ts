import type * as vscode from 'vscode';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { McpController } from '../../src/mcp/controller.js';
import { NpuTreeProvider } from '../../src/ui/treeProvider.js';
import { McpNode } from '../../src/ui/nodes.js';
import type { MonitorService } from '../../src/monitorService.js';
import { clipboardFailures, clipboardWrites, configurationValues, errorMessages, resetVscodeMock, window, EventEmitter } from '../mocks/vscode.js';

const http = vi.hoisted(() => ({ start: vi.fn(async () => {}), stop: vi.fn(async () => {}) }));
vi.mock('../../src/mcp/server.js', () => ({ MonitorHttpServer: class { start = http.start; stop = http.stop; } }));
const service = { getRecords: () => [], getRecord: () => undefined, scanAliases: vi.fn(async () => {}), getIdleHistory: (alias: string) => ({ alias, retentionDays: 7, cards: [] }), getIdleCandidates: () => [], onDidChange: new EventEmitter<void>().event };
const secrets = new Map<string, string>();
function controller() {
  return new McpController({ secrets: { get: async (k: string) => secrets.get(k), store: async (k: string, v: string) => { secrets.set(k, v); } } } as unknown as vscode.ExtensionContext,
    service, { error: vi.fn(), show: vi.fn() } as unknown as vscode.LogOutputChannel);
}
afterEach(() => { resetVscodeMock(); http.start.mockReset(); http.stop.mockReset(); secrets.clear(); });

describe('MCP panel and lifecycle', () => {
  it('starts disabled, restarts serially and reuses its secret', async () => {
    const c = controller(); await c.configure(); expect(http.start).not.toHaveBeenCalled();
    configurationValues.set('npuMonitor.mcp.enabled', true);
    await Promise.all([c.configure(), c.configure()]);
    expect(http.start).toHaveBeenCalledTimes(2);
    expect(http.start.mock.calls[0]).toEqual(http.start.mock.calls[1]);
    expect(c.state).toBe('Running');
    configurationValues.set('npuMonitor.mcp.enabled', false); await c.configure();
    expect(c.state).toBe('Disabled'); c.dispose();
  });
  it('shows an occupied port without disrupting the monitor', async () => {
    configurationValues.set('npuMonitor.mcp.enabled', true);
    http.start.mockRejectedValueOnce(Object.assign(new Error('hidden'), { code: 'EADDRINUSE' }));
    const c = controller(); await c.configure();
    expect(c.state).toBe('MCP port is already in use');
    const provider = new NpuTreeProvider(service as unknown as MonitorService, c);
    const node = provider.getChildren()[0]; expect(node).toBeInstanceOf(McpNode);
    const item = provider.getTreeItem(node!);
    expect(item.id).toBe('npu-monitor:mcp');
    expect(item.command?.command).toBe('npuMonitor.mcpMenu');
    expect(provider.getChildren(node)).toEqual([]);
    expect(c.tooltip).not.toContain('hidden'); provider.dispose(); c.dispose();
  });
  it('copies dotenv values only on request and handles clipboard failure', async () => {
    configurationValues.set('npuMonitor.mcp.enabled', true);
    const c = controller(); await c.configure();
    window.quickPickAction = 'copy'; await c.showMenu();
    expect(clipboardWrites[0]).toMatch(/^NPU_MONITOR_MCP_URL='http:\/\/127.0.0.1:49160\/mcp'\nNPU_MONITOR_MCP_TOKEN='[0-9a-f]{64}'\n$/);
    expect(c.tooltip).not.toContain(secrets.get('npuMonitor.mcp.token'));
    clipboardFailures.push(new Error('denied')); await c.showMenu();
    expect(errorMessages).toContain('Unable to update or copy MCP settings.'); c.dispose();
  });
});
