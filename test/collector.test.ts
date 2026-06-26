import { describe, expect, it } from 'vitest';

import { NpuCollector } from '../src/collector.js';
import { SshExecutionError } from '../src/sshRunner.js';
import type { MonitorSettings, SshHost } from '../src/types.js';

const settings: MonitorSettings = {
  sshConfigPath: '',
  remoteSshConfigFile: '',
  knownHostsPath: '',
  sshExecutablePath: '',
  connectTimeoutSeconds: 8,
  exporterProbeTimeoutSeconds: 2,
  npuSmiTimeoutSeconds: 10,
  maxConcurrentHosts: 6,
  excludedHosts: [],
  pollIntervalSeconds: 60,
  idleScope: 'allCards',
  idleRequireNoProcesses: true,
  idleUtilizationThresholdPercent: 1,
  idleConsecutiveChecks: 1,
};

const host: SshHost = {
  alias: 'alpha',
  hostname: '10.0.0.1',
  user: 'root',
  port: 22,
  identityFiles: [],
  configPath: '/tmp/config',
  useAlias: false,
};

const NpuSmiFixture = [
  '+------------------------------------------------------------------------------------------------------------------+',
  '| npu-smi 25.6.rc1.b143                            Version: 25.6.rc1.b143                                          |',
  '+--------+------------------+---------------+----------------------------------------------------------------------+',
  '| NPU ID | Name             | Health        | Power(W)              Temp(C)                  Hugepages-Usage(page) |',
  '|        |                  | Bus-Id        | NPU Util(%)           Memory-Usage(MB)         HBM-Usage(MB)         |',
  '+========+==================+===============+======================================================================+',
  '| 0      | Ascend910        | OK            | 100.0                 40                       0     / 0             |',
  '|        |                  | NA            | 5                     0     / 0                4096 / 65536          |',
  '+========+==================+===============+======================================================================+',
  '| NPU ID                    | Process id    | Process name       | Process memory(MB)    | Process id in container |',
  '+========+==================+===============+======================================================================+',
].join('\n');

const ExporterFixture = [
  'npu_chip_info_health_status{id="0",model_name="Ascend910"} 1',
  'npu_chip_info_overall_utilization{id="0",model_name="Ascend910"} 0',
  'npu_chip_info_hbm_used_memory{id="0",model_name="Ascend910"} 1024',
  'npu_chip_info_hbm_total_memory{id="0",model_name="Ascend910"} 65536',
  'npu_chip_info_process_info_num{id="0",model_name="Ascend910"} 0',
].join('\n');

function makeRunner(responses: Array<{ stdout: string } | Error>): {
  run: () => Promise<{ stdout: string; stderr: string }>;
  callCount: number;
} {
  let callCount = 0;
  return {
    get callCount() { return callCount; },
    async run(): Promise<{ stdout: string; stderr: string }> {
      const response = responses[callCount];
      callCount += 1;
      if (!response) {
        throw new Error('Unexpected runner call');
      }
      if (response instanceof Error) {
        throw response;
      }
      return { stdout: response.stdout, stderr: '' };
    },
  };
}

function wrapInEnvelope(source: string, data: string): string {
  return [
    '__NPU_MONITOR_CAPS_BEGIN__',
    '__NPU_MONITOR_CAPS_END__',
    `__NPU_MONITOR_SOURCE__${source}`,
    '__NPU_MONITOR_DATA_BEGIN__',
    data,
    '__NPU_MONITOR_DATA_END__',
  ].join('\n');
}

describe('NpuCollector scan', () => {
  it('returns a snapshot from npu-smi output', async () => {
    const runner = makeRunner([{ stdout: wrapInEnvelope('npu-smi', NpuSmiFixture) }]);
    const collector = new NpuCollector(runner as never, settings, () => { /* noop */ });
    const result = await collector.scan(host);
    expect(result.state).toBe('unknown');
    expect(result.snapshot?.source).toBe('npu-smi');
    expect(result.snapshot?.devices).toHaveLength(1);
    expect(result.snapshot?.devices[0]?.id).toBe('0');
  });

  it('returns a snapshot from exporter output', async () => {
    const runner = makeRunner([{ stdout: wrapInEnvelope('exporter|http://127.0.0.1:8080/metrics', ExporterFixture) }]);
    const collector = new NpuCollector(runner as never, settings, () => { /* noop */ });
    const result = await collector.scan(host);
    expect(result.state).toBe('unknown');
    expect(result.snapshot?.source).toBe('exporter');
    expect(result.snapshot?.endpoint).toBe('http://127.0.0.1:8080/metrics');
    expect(result.snapshot?.devices).toHaveLength(1);
  });

  it('returns unsupported state when source is none', async () => {
    const runner = makeRunner([{ stdout: wrapInEnvelope('none', 'No usable NPU tool found.') }]);
    const collector = new NpuCollector(runner as never, settings, () => { /* noop */ });
    const result = await collector.scan(host);
    expect(result.state).toBe('unsupported');
    expect(result.snapshot).toBeUndefined();
    expect(result.error).toBe('No usable NPU tool found.');
  });

  it('maps SSH timeout error to timeout state', async () => {
    const runner = makeRunner([new SshExecutionError('timeout', 'Connection timed out', '')]);
    const collector = new NpuCollector(runner as never, settings, () => { /* noop */ });
    const result = await collector.scan(host);
    expect(result.state).toBe('timeout');
    expect(result.snapshot).toBeUndefined();
  });

  it('maps SSH auth error to authError state', async () => {
    const runner = makeRunner([new SshExecutionError('authError', 'Permission denied', '')]);
    const collector = new NpuCollector(runner as never, settings, () => { /* noop */ });
    const result = await collector.scan(host);
    expect(result.state).toBe('authError');
  });

  it('maps SSH unreachable error to unreachable state', async () => {
    const runner = makeRunner([new SshExecutionError('unreachable', 'No route to host', '')]);
    const collector = new NpuCollector(runner as never, settings, () => { /* noop */ });
    const result = await collector.scan(host);
    expect(result.state).toBe('unreachable');
  });

  it('returns error state for unexpected exceptions', async () => {
    const runner = makeRunner([new Error('Unexpected failure')]);
    const collector = new NpuCollector(runner as never, settings, () => { /* noop */ });
    const result = await collector.scan(host);
    expect(result.state).toBe('error');
    expect(result.error).toBe('Unexpected failure');
  });

  it('falls back to npu-smi when exporter parsing fails', async () => {
    const badExporterOutput = wrapInEnvelope('exporter|http://127.0.0.1:9200/metrics', 'not valid prometheus');
    const npuSmiFallbackOutput = wrapInEnvelope('npu-smi', NpuSmiFixture);
    const logs: string[] = [];
    const runner = makeRunner([
      { stdout: badExporterOutput },
      { stdout: npuSmiFallbackOutput },
    ]);
    const collector = new NpuCollector(runner as never, settings, msg => logs.push(msg));
    const result = await collector.scan(host);
    expect(result.snapshot?.source).toBe('npu-smi');
    expect(logs.some(l => l.includes('Exporter parsing failed'))).toBe(true);
    expect(runner.callCount).toBe(2);
  });

  it('returns partial state when the parsed snapshot is partial', async () => {
    // A minimal A5-format with unknown health → partial result
    const partialSmi = [
      '+--------+------------------+---------------+------+',
      '| NPU ID | Name             | Health        | Info |',
      '+========+==================+===============+======+',
      '| 0      | Ascend910        |               | 0    |',
      '|        |                  | NA            | 0 / 0|',
      '+========+==================+===============+======+',
      '| NPU ID                    | Process id    | Process name       | Process memory(MB)    |',
    ].join('\n');
    const runner = makeRunner([{ stdout: wrapInEnvelope('npu-smi', partialSmi) }]);
    const collector = new NpuCollector(runner as never, settings, () => { /* noop */ });
    const result = await collector.scan(host);
    expect(result.state).toBe('partial');
    expect(result.snapshot?.partial).toBe(true);
  });
});
