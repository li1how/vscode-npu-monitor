import type { NpuDevice, NpuProcess } from '../types.js';

interface PrometheusSample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

function parseLabels(text: string): Record<string, string> {
  const labels: Record<string, string> = {};
  let index = 0;
  while (index < text.length) {
    while (text[index] === ' ' || text[index] === ',') {
      index += 1;
    }
    const keyStart = index;
    while (index < text.length && /[a-zA-Z0-9_]/.test(text[index] ?? '')) {
      index += 1;
    }
    const key = text.slice(keyStart, index);
    if (!key || text[index] !== '=') {
      break;
    }
    index += 1;
    if (text[index] !== '"') {
      break;
    }
    index += 1;
    let value = '';
    while (index < text.length) {
      const char = text[index];
      index += 1;
      if (char === '"') {
        break;
      }
      if (char === '\\') {
        const escaped = text[index];
        index += 1;
        value += escaped === 'n' ? '\n' : escaped ?? '';
      } else {
        value += char;
      }
    }
    labels[key] = value;
  }
  return labels;
}

function parseSample(line: string): PrometheusSample | undefined {
  const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?\s+([^\s]+)(?:\s+\d+)?$/.exec(line);
  if (!match) {
    return undefined;
  }
  const value = Number(match[3]);
  if (!Number.isFinite(value)) {
    return undefined;
  }
  return {
    name: match[1] ?? '',
    labels: match[2] ? parseLabels(match[2]) : {},
    value,
  };
}

type DeviceBuilder = NpuDevice;

function getDevice(
  devices: Map<string, DeviceBuilder>,
  sample: PrometheusSample,
): DeviceBuilder | undefined {
  const id = sample.labels.id;
  if (!id) {
    return undefined;
  }
  let device = devices.get(id);
  if (!device) {
    device = {
      id,
      model: sample.labels.model_name,
      health: 'UNKNOWN',
      busId: sample.labels.pcie_bus_info,
      processes: [],
    };
    devices.set(id, device);
  }
  return device;
}

function processFromSample(sample: PrometheusSample): NpuProcess | undefined {
  const pid = sample.labels.process_id;
  if (!pid) {
    return undefined;
  }
  return {
    pid,
    name: sample.labels.process_name || sample.labels.container_name || undefined,
    memoryMb: sample.value,
  };
}

export function parsePrometheusMetrics(text: string): {
  devices: NpuDevice[];
  partial: boolean;
} {
  const devices = new Map<string, DeviceBuilder>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const sample = parseSample(line);
    if (!sample || !sample.name.startsWith('npu_chip_info_')) {
      continue;
    }
    const device = getDevice(devices, sample);
    if (!device) {
      continue;
    }
    switch (sample.name) {
      case 'npu_chip_info_health_status':
        device.health = sample.value === 1 ? 'OK' : 'ERROR';
        break;
      case 'npu_chip_info_overall_utilization':
        device.utilizationPercent = sample.value;
        break;
      case 'npu_chip_info_utilization':
        device.utilizationPercent ??= sample.value;
        break;
      case 'npu_chip_info_hbm_used_memory':
        device.hbmUsedMb = sample.value;
        break;
      case 'npu_chip_info_hbm_total_memory':
        device.hbmTotalMb = sample.value;
        break;
      case 'npu_chip_info_temperature':
        device.temperatureC = sample.value;
        break;
      case 'npu_chip_info_power':
        device.powerW = sample.value;
        break;
      case 'npu_chip_info_process_info_num':
        device.processCount = sample.value;
        break;
      case 'npu_chip_info_process_info': {
        const process = processFromSample(sample);
        if (process) {
          device.processes.push(process);
        }
        break;
      }
    }
  }
  if (devices.size === 0) {
    throw new Error('NPU-Exporter returned no device metrics.');
  }
  const result = [...devices.values()].sort((left, right) =>
    left.id.localeCompare(right.id, undefined, { numeric: true }),
  );
  const partial = result.some(device =>
    device.health === 'UNKNOWN' ||
    device.utilizationPercent === undefined ||
    device.processCount === undefined,
  );
  return { devices: result, partial };
}
