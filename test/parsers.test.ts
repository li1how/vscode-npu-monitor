import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseNpuSmiInfo } from '../src/parsers/npuSmi.js';
import { parsePrometheusMetrics } from '../src/parsers/prometheus.js';

function fixture(name: string): string {
  return readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
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
});
