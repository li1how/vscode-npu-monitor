import type { NpuDevice, NpuProcess } from '../types.js';

interface PendingDevice {
  id: string;
  model?: string;
  health: NpuDevice['health'];
  powerW?: number;
  temperatureC?: number;
}

function numberValue(value: string | undefined): number | undefined {
  if (!value || value === '-') {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizedHealth(value: string | undefined): NpuDevice['health'] {
  if (value === 'OK') {
    return 'OK';
  }
  return value ? 'ERROR' : 'UNKNOWN';
}

function tableCells(line: string): string[] {
  if (!line.trimStart().startsWith('|')) {
    return [];
  }
  return line.split('|').slice(1, -1).map(cell => cell.trim());
}

function parseTrailingMetrics(text: string): {
  utilizationPercent?: number;
  hbmUsedMb?: number;
  hbmTotalMb?: number;
} {
  const matches = [...text.matchAll(/(-?\d+(?:\.\d+)?)\s*(?:\/\s*(-?\d+(?:\.\d+)?))?/g)];
  if (matches.length === 0) {
    return {};
  }
  const utilizationPercent = numberValue(matches[0]?.[1]);
  const last = matches.at(-1);
  return {
    utilizationPercent,
    hbmUsedMb: numberValue(last?.[1]),
    hbmTotalMb: numberValue(last?.[2]),
  };
}

function parseA5Devices(lines: string[], processHeaderIndex: number): NpuDevice[] {
  const devices: NpuDevice[] = [];
  let pending: PendingDevice | undefined;
  for (const line of lines.slice(0, processHeaderIndex)) {
    const cells = tableCells(line);
    if (cells.length !== 4) {
      continue;
    }
    if (/^\d+$/.test(cells[0] ?? '') && cells[1] && cells[1] !== 'Name') {
      const summary = (cells[3] ?? '').match(/^(-|\d+(?:\.\d+)?)\s+(-|\d+(?:\.\d+)?)/);
      pending = {
        id: cells[0] ?? '',
        model: cells[1],
        health: normalizedHealth(cells[2]),
        powerW: numberValue(summary?.[1]),
        temperatureC: numberValue(summary?.[2]),
      };
      continue;
    }
    if (pending && cells[0] === '' && cells[1] === '') {
      const metrics = parseTrailingMetrics(cells[3] ?? '');
      devices.push({
        ...pending,
        busId: cells[2] || undefined,
        ...metrics,
        processes: [],
      });
      pending = undefined;
    }
  }
  return devices;
}

function parseA3Devices(lines: string[], processHeaderIndex: number): NpuDevice[] {
  const devices: NpuDevice[] = [];
  let pending: PendingDevice | undefined;
  for (const line of lines.slice(0, processHeaderIndex)) {
    const cells = tableCells(line);
    if (cells.length !== 3) {
      continue;
    }
    const first = cells[0] ?? '';
    const summaryMatch = /^(\d+)\s+(\S+)$/.exec(first);
    if (summaryMatch && cells[1] && !/^\d+$/.test(summaryMatch[2] ?? '')) {
      const summary = (cells[2] ?? '').match(/^(-|\d+(?:\.\d+)?)\s+(-|\d+(?:\.\d+)?)/);
      pending = {
        id: summaryMatch[1] ?? '',
        model: summaryMatch[2],
        health: normalizedHealth(cells[1]),
        powerW: numberValue(summary?.[1]),
        temperatureC: numberValue(summary?.[2]),
      };
      continue;
    }
    const chipMatch = /^(\d+)\s+(\d+)$/.exec(first);
    if (pending && chipMatch) {
      const metrics = parseTrailingMetrics(cells[2] ?? '');
      devices.push({
        ...pending,
        id: chipMatch[2] ?? pending.id,
        busId: cells[1] || undefined,
        ...metrics,
        processes: [],
      });
      pending = undefined;
    }
  }
  return devices;
}

function attachProcesses(
  lines: string[],
  processHeaderIndex: number,
  devices: NpuDevice[],
): void {
  const byId = new Map(devices.map(device => [device.id, device]));
  for (const line of lines.slice(processHeaderIndex + 1)) {
    if (/No running processes found/.test(line)) {
      continue;
    }
    const cells = tableCells(line);
    if (cells.length < 4 || !/^\d+(?:\s+\d+)?$/.test(cells[0] ?? '')) {
      continue;
    }
    const idParts = (cells[0] ?? '').split(/\s+/);
    const id = idParts.at(-1) ?? '';
    const pid = cells[1] ?? '';
    if (!/^\d+$/.test(pid)) {
      continue;
    }
    const process: NpuProcess = {
      pid,
      name: cells[2] || undefined,
      memoryMb: numberValue(cells[3]),
    };
    (byId.get(id) ?? byId.get(idParts[0] ?? ''))?.processes.push(process);
  }
}

export function parseNpuSmiInfo(text: string): {
  devices: NpuDevice[];
  partial: boolean;
} {
  const lines = text.split(/\r?\n/);
  const processHeaderIndex = lines.findIndex(line => /Process id/.test(line));
  const tableEnd = processHeaderIndex >= 0 ? processHeaderIndex : lines.length;
  const isA5 = lines.some(line => /\|\s*NPU ID\s*\|\s*Name/.test(line));
  const devices = isA5
    ? parseA5Devices(lines, tableEnd)
    : parseA3Devices(lines, tableEnd);
  if (devices.length === 0) {
    throw new Error('Unable to parse devices from npu-smi info.');
  }
  if (processHeaderIndex >= 0) {
    attachProcesses(lines, processHeaderIndex, devices);
  }
  for (const device of devices) {
    device.processCount = device.processes.length;
  }
  const partial = devices.some(device =>
    device.health === 'UNKNOWN' || device.utilizationPercent === undefined,
  );
  devices.sort((left, right) =>
    left.id.localeCompare(right.id, undefined, { numeric: true }),
  );
  return { devices, partial };
}
