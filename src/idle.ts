import type {
  HostSnapshot,
  HostState,
  MonitorSettings,
  NpuDevice,
} from './types.js';

export function isDeviceIdle(device: NpuDevice, settings: MonitorSettings): boolean {
  if (device.health !== 'OK' || device.utilizationPercent === undefined) {
    return false;
  }
  if (device.utilizationPercent > settings.idleUtilizationThresholdPercent) {
    return false;
  }
  const processCount = device.processCount ?? device.processes.length;
  return !settings.idleRequireNoProcesses || processCount === 0;
}

export function evaluateSnapshot(
  snapshot: HostSnapshot,
  settings: MonitorSettings,
): { state: HostState; idleDevices: number } {
  if (snapshot.partial || snapshot.devices.length === 0) {
    return { state: 'partial', idleDevices: 0 };
  }
  if (snapshot.devices.some(device => device.health !== 'OK')) {
    return { state: 'unhealthy', idleDevices: 0 };
  }
  const idleDevices = snapshot.devices.filter(device => isDeviceIdle(device, settings)).length;
  const idle = settings.idleScope === 'allCards'
    ? idleDevices === snapshot.devices.length
    : idleDevices > 0;
  return { state: idle ? 'idle' : 'busy', idleDevices };
}
