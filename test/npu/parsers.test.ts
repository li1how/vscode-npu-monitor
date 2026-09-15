import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseNpuSmiInfo } from '../../src/npu/parsers/npuSmi.js';
import { parsePrometheusMetrics } from '../../src/npu/parsers/prometheus.js';

function fixture(name: string): string {
  return readFileSync(path.join(__dirname, '..', 'fixtures', name), 'utf8');
}

describe('NPU status parsers', () => {
  it('parses A5 npu-smi devices and processes', () => {
    const result = parseNpuSmiInfo(fixture('npu-smi-a5.txt'));
    expect(result.partial).toBe(false);
    expect(result.devices).toHaveLength(2);
    expect(result.devices[0]).toMatchObject({
      id: '0',
      model: 'Ascend950DT',
      health: 'OK',
      utilizationPercent: 0,
      hbmUsedMb: 90129,
      hbmTotalMb: 98304,
      processCount: 1,
    });
    expect(result.devices[0]?.processes[0]).toMatchObject({
      pid: '305192',
      name: 'VLLMWorker_DP',
      memoryMb: 84315,
    });
  });

  it('parses A3 npu-smi physical chips', () => {
    const result = parseNpuSmiInfo(fixture('npu-smi-a3.txt'));
    expect(result.partial).toBe(false);
    expect(result.devices).toHaveLength(2);
    expect(result.devices[0]).toMatchObject({
      id: '0',
      model: 'Ascend910',
      health: 'OK',
      utilizationPercent: 0,
      hbmUsedMb: 3143,
      hbmTotalMb: 65536,
      processCount: 0,
    });
  });

  it('parses second A3 chip with correct id', () => {
    const result = parseNpuSmiInfo(fixture('npu-smi-a3.txt'));
    expect(result.devices[1]).toMatchObject({
      id: '1',
      model: 'Ascend910',
      health: 'OK',
      hbmUsedMb: 2889,
      hbmTotalMb: 65536,
      processCount: 0,
    });
  });

  it('maps A3 processes from NPU and chip coordinates to physical device ids', () => {
    const text = [
      '| NPU   Name                | Health        | Power(W) Temp(C) Hugepages-Usage(page) |',
      '| Chip  Phy-ID              | Bus-Id        | AICore(%) Memory-Usage(MB) HBM-Usage(MB) |',
      '| 0     Ascend910           | OK            | 100 40 0 / 0 |',
      '| 0     0                   | 0000:01:00.0  | 0 0 / 0 10 / 20 |',
      '| 0     Ascend910           | OK            | - 41 0 / 0 |',
      '| 1     1                   | 0000:02:00.0  | 0 0 / 0 10 / 20 |',
      '| 1     Ascend910           | OK            | 100 42 0 / 0 |',
      '| 0     2                   | 0000:03:00.0  | 0 0 / 0 10 / 20 |',
      '| 1     Ascend910           | OK            | - 43 0 / 0 |',
      '| 1     3                   | 0000:04:00.0  | 0 0 / 0 10 / 20 |',
      '| NPU     Chip              | Process id    | Process name | Process memory(MB) |',
      '| 0       0                 | 100           | worker-0     | 11                 |',
      '| 0       1                 | 101           | worker-1     | 12                 |',
      '| 1       0                 | 102           | worker-2     | 13                 |',
      '| 1       1                 | 103           | worker-3     | 14                 |',
    ].join('\n');

    const result = parseNpuSmiInfo(text);

    expect(result.devices.map(device => ({
      id: device.id,
      processIds: device.processes.map(process => process.pid),
    }))).toEqual([
      { id: '0', processIds: ['100'] },
      { id: '1', processIds: ['101'] },
      { id: '2', processIds: ['102'] },
      { id: '3', processIds: ['103'] },
    ]);
  });

  it('throws on unrecognizable npu-smi text', () => {
    expect(() => parseNpuSmiInfo('hello world')).toThrow(
      'Unable to parse devices',
    );
  });

  it('marks npu-smi result as partial when health is missing', () => {
    // A minimal A5-style table where the health column is blank
    const text = [
      '+--------------------------------------------------+',
      '| NPU ID | Name             | Health        | Info |',
      '+========+==================+===============+======+',
      '| 0      | Ascend910        |               | 0    |',
      '|        |                  | NA            | 0 / 0|',
      '+========+==================+===============+======+',
      '| NPU ID                    | Process id    | Process name       | Process memory(MB)    |',
    ].join('\n');
    const result = parseNpuSmiInfo(text);
    expect(result.partial).toBe(true);
  });

  it('parses exporter metrics and authoritative process counts', () => {
    const result = parsePrometheusMetrics(fixture('exporter.prom'));
    expect(result.partial).toBe(false);
    expect(result.devices).toHaveLength(2);
    expect(result.devices[0]?.processCount).toBe(0);
    expect(result.devices[1]?.processCount).toBe(1);
    expect(result.devices[1]?.processes[0]?.pid).toBe('4321');
  });

  it('rejects incomplete exporter output', () => {
    expect(() => parsePrometheusMetrics('not_a_metric 1')).toThrow(
      'no device metrics',
    );
  });

  it('uses npu_chip_info_utilization as a fallback when overall_utilization is absent', () => {
    const text = [
      'npu_chip_info_health_status{id="0"} 1',
      'npu_chip_info_utilization{id="0"} 42',
      'npu_chip_info_process_info_num{id="0"} 0',
    ].join('\n');
    const result = parsePrometheusMetrics(text);
    expect(result.devices[0]?.utilizationPercent).toBe(42);
  });

  it('overall_utilization takes precedence over utilization fallback', () => {
    const text = [
      'npu_chip_info_health_status{id="0"} 1',
      'npu_chip_info_overall_utilization{id="0"} 10',
      'npu_chip_info_utilization{id="0"} 99',
      'npu_chip_info_process_info_num{id="0"} 0',
    ].join('\n');
    const result = parsePrometheusMetrics(text);
    expect(result.devices[0]?.utilizationPercent).toBe(10);
  });

  it('marks exporter result as partial when processCount is missing', () => {
    const text = [
      'npu_chip_info_health_status{id="0"} 1',
      'npu_chip_info_overall_utilization{id="0"} 5',
    ].join('\n');
    const result = parsePrometheusMetrics(text);
    expect(result.partial).toBe(true);
  });

  it('skips comment lines and blank lines in exporter output', () => {
    const text = [
      '# HELP npu_chip_info_health_status Health status',
      '# TYPE npu_chip_info_health_status gauge',
      '',
      'npu_chip_info_health_status{id="0"} 1',
      'npu_chip_info_overall_utilization{id="0"} 3',
      'npu_chip_info_process_info_num{id="0"} 0',
    ].join('\n');
    const result = parsePrometheusMetrics(text);
    expect(result.devices).toHaveLength(1);
    expect(result.partial).toBe(false);
  });

  it('reads process name from container_name label when process_name is absent', () => {
    const text = [
      'npu_chip_info_health_status{id="0"} 1',
      'npu_chip_info_overall_utilization{id="0"} 0',
      'npu_chip_info_process_info_num{id="0"} 1',
      'npu_chip_info_process_info{id="0",process_id="123",container_name="my-container"} 512',
    ].join('\n');
    const result = parsePrometheusMetrics(text);
    expect(result.devices[0]?.processes[0]).toMatchObject({
      pid: '123',
      name: 'my-container',
      memoryMb: 512,
    });
  });

  it('marks device health as ERROR when health_status value is 0', () => {
    const text = [
      'npu_chip_info_health_status{id="0"} 0',
      'npu_chip_info_overall_utilization{id="0"} 0',
      'npu_chip_info_process_info_num{id="0"} 0',
    ].join('\n');
    const result = parsePrometheusMetrics(text);
    expect(result.devices[0]?.health).toBe('ERROR');
    expect(result.partial).toBe(false);
  });
});
