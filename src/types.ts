export type DataSource = 'exporter' | 'npu-smi';

export type HostState =
  | 'unknown'
  | 'refreshing'
  | 'idle'
  | 'busy'
  | 'partial'
  | 'unhealthy'
  | 'unreachable'
  | 'timeout'
  | 'authError'
  | 'hostKeyError'
  | 'unsupported'
  | 'error'
  | 'missingConfig';

export interface SshHost {
  alias: string;
  hostname: string;
  user?: string;
  port?: number;
  identityFiles: string[];
  proxyJump?: string;
  configPath: string;
  knownHostsPath?: string;
  useAlias: boolean;
}

export interface NpuProcess {
  pid: string;
  name?: string;
  memoryMb?: number;
}

export interface NpuDevice {
  id: string;
  model?: string;
  health: 'OK' | 'ERROR' | 'UNKNOWN';
  utilizationPercent?: number;
  hbmUsedMb?: number;
  hbmTotalMb?: number;
  temperatureC?: number;
  powerW?: number;
  busId?: string;
  processCount?: number;
  processes: NpuProcess[];
}

export interface HostSnapshot {
  source: DataSource;
  endpoint?: string;
  devices: NpuDevice[];
  partial: boolean;
  collectedAt: number;
  durationMs: number;
}

export interface HostRecord {
  host: SshHost;
  state: HostState;
  snapshot?: HostSnapshot;
  refreshing: boolean;
  subscribed: boolean;
  idleStreak: number;
  idleNotified: boolean;
  stale: boolean;
  error?: string;
}

export interface MonitorSettings {
  sshConfigPath: string;
  knownHostsPath: string;
  sshExecutablePath: string;
  connectTimeoutSeconds: number;
  exporterProbeTimeoutSeconds: number;
  npuSmiTimeoutSeconds: number;
  maxConcurrentHosts: number;
  excludedHosts: string[];
  pollIntervalSeconds: number;
  idleScope: 'allCards' | 'anyCard';
  idleRequireNoProcesses: boolean;
  idleUtilizationThresholdPercent: number;
  idleConsecutiveChecks: number;
}

export interface ScanResult {
  snapshot?: HostSnapshot;
  state: HostState;
  error?: string;
}
