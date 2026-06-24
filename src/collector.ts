import type * as vscode from 'vscode';

import { parseNpuSmiInfo } from './parsers/npuSmi.js';
import { parsePrometheusMetrics } from './parsers/prometheus.js';
import { SshExecutionError } from './sshRunner.js';
import type { SshRunner } from './sshRunner.js';
import type {
  HostSnapshot,
  HostState,
  MonitorSettings,
  ScanResult,
  SshHost,
} from './types.js';

const SOURCE_MARKER = '__NPU_MONITOR_SOURCE__';
const DATA_BEGIN = '__NPU_MONITOR_DATA_BEGIN__';
const DATA_END = '__NPU_MONITOR_DATA_END__';

export function buildRemoteScanCommand(settings: MonitorSettings): string {
  const probeTimeout = Math.max(1, Math.floor(settings.exporterProbeTimeoutSeconds));
  const npuSmiTimeout = Math.max(1, Math.floor(settings.npuSmiTimeoutSeconds));
  const lines = [
    'export LC_ALL=C',
    'exporter_lines="$(ps -eo pid=,comm=,args= 2>/dev/null | awk \'$2=="npu-exporter" || $2=="npu_exporter"\')"',
    'npu_smi_path="$(command -v npu-smi 2>/dev/null || true)"',
    'printf "__NPU_MONITOR_CAPS_BEGIN__\\n%s\\n__NPU_MONITOR_NPU_SMI__%s\\n__NPU_MONITOR_CAPS_END__\\n" "$exporter_lines" "$npu_smi_path"',
    'endpoints="$(printf \'%s\\n\' "$exporter_lines" | awk \'{ ip="127.0.0.1"; port=""; for(i=3;i<=NF;i++){ token=$i; if(token ~ /^--?ip=/){ sub(/^--?ip=/,"",token); ip=token } else if((token=="-ip" || token=="--ip") && i<NF){ ip=$(i+1) } if(token ~ /^--?port=/){ sub(/^--?port=/,"",token); port=token } else if((token=="-port" || token=="--port") && i<NF){ port=$(i+1) } } if(port ~ /^[0-9]+$/ && port>0 && port<65536){ priority=2; connect_ip=ip; if(ip=="127.0.0.1" || ip=="localhost"){ priority=0 } else if(ip=="0.0.0.0" || ip=="::" || ip=="*"){ priority=1; connect_ip="127.0.0.1" } print priority "|" connect_ip "|" port } }\' | sort -t"|" -k1,1n -u | head -n 2)"',
    'if [ -n "$endpoints" ] && command -v curl >/dev/null 2>&1; then',
    '  probe_started="$(date +%s)"',
    '  for endpoint in $endpoints; do',
    '    now="$(date +%s)"',
    '    remaining=$(( ' + probeTimeout + ' - now + probe_started ))',
    '    if [ "$remaining" -le 0 ]; then break; fi',
    '    rest="${endpoint#*|}"; connect_ip="${rest%%|*}"; port="${rest##*|}"',
    '    url="http://${connect_ip}:${port}/metrics"',
    '    metrics="$(curl -fsS --connect-timeout 1 --max-time "$remaining" "$url" 2>/dev/null || true)"',
    '    if printf \'%s\\n\' "$metrics" | grep -q "^npu_chip_info_health_status{" && printf \'%s\\n\' "$metrics" | grep -Eq "^npu_chip_info_(overall_)?utilization{" && printf \'%s\\n\' "$metrics" | grep -q "^npu_chip_info_process_info_num{"; then',
    '      printf "' + SOURCE_MARKER + 'exporter|%s\\n' + DATA_BEGIN + '\\n%s\\n' + DATA_END + '\\n" "$url" "$metrics"',
    '      exit 0',
    '    fi',
    '  done',
    'fi',
    'if [ -n "$npu_smi_path" ]; then',
    '  if command -v timeout >/dev/null 2>&1; then',
    '    npu_output="$(timeout ' + npuSmiTimeout + 's "$npu_smi_path" info 2>&1 || true)"',
    '  else',
    '    npu_output="$("$npu_smi_path" info 2>&1 || true)"',
    '  fi',
    '  if printf \'%s\\n\' "$npu_output" | grep -q "npu-smi"; then',
    '    printf "' + SOURCE_MARKER + 'npu-smi\\n' + DATA_BEGIN + '\\n%s\\n' + DATA_END + '\\n" "$npu_output"',
    '    exit 0',
    '  fi',
    'fi',
    'printf "' + SOURCE_MARKER + 'none\\n' + DATA_BEGIN + '\\nNo usable NPU-Exporter or npu-smi was found.\\n' + DATA_END + '\\n"',
  ];
  return lines.join('\n');
}

function npuSmiOnlyCommand(timeoutSeconds: number): string {
  const timeout = Math.max(1, Math.floor(timeoutSeconds));
  return [
    'export LC_ALL=C',
    'npu_smi_path="$(command -v npu-smi 2>/dev/null || true)"',
    'if [ -n "$npu_smi_path" ]; then',
    '  npu_output="$(timeout ' + timeout + 's "$npu_smi_path" info 2>&1 || true)"',
    '  printf "' + SOURCE_MARKER + 'npu-smi\\n' + DATA_BEGIN + '\\n%s\\n' + DATA_END + '\\n" "$npu_output"',
    'else',
    '  printf "' + SOURCE_MARKER + 'none\\n' + DATA_BEGIN + '\\nnpu-smi was not found.\\n' + DATA_END + '\\n"',
    'fi',
  ].join('\n');
}

interface RemoteEnvelope {
  source: 'exporter' | 'npu-smi' | 'none';
  endpoint?: string;
  data: string;
}

export function parseRemoteEnvelope(stdout: string): RemoteEnvelope {
  const sourceLine = stdout.split(/\r?\n/).find(line => line.startsWith(SOURCE_MARKER));
  if (!sourceLine) {
    throw new Error('Remote scan output did not contain a source marker.');
  }
  const sourceValue = sourceLine.slice(SOURCE_MARKER.length);
  const separator = sourceValue.indexOf('|');
  const sourceText = separator >= 0 ? sourceValue.slice(0, separator) : sourceValue;
  if (sourceText !== 'exporter' && sourceText !== 'npu-smi' && sourceText !== 'none') {
    throw new Error('Remote scan reported an unknown source: ' + sourceText);
  }
  const begin = stdout.indexOf(DATA_BEGIN);
  const end = stdout.indexOf(DATA_END, begin + DATA_BEGIN.length);
  if (begin < 0 || end < 0) {
    throw new Error('Remote scan output did not contain a complete data section.');
  }
  const data = stdout.slice(begin + DATA_BEGIN.length, end)
    .replace(/^\r?\n/, '')
    .trimEnd();
  return {
    source: sourceText,
    endpoint: separator >= 0 ? sourceValue.slice(separator + 1) : undefined,
    data,
  };
}

function stateFromSshError(error: SshExecutionError): HostState {
  return error.kind;
}

export class NpuCollector {
  public constructor(
    private readonly runner: SshRunner,
    private readonly settings: MonitorSettings,
    private readonly log: (message: string) => void,
  ) {}

  public async scan(
    host: SshHost,
    cancellationToken?: vscode.CancellationToken,
  ): Promise<ScanResult> {
    const startedAt = Date.now();
    const totalTimeoutMs = (
      this.settings.connectTimeoutSeconds +
      this.settings.exporterProbeTimeoutSeconds +
      this.settings.npuSmiTimeoutSeconds +
      5
    ) * 1000;
    try {
      const result = await this.runner.run(
        host,
        buildRemoteScanCommand(this.settings),
        totalTimeoutMs,
        cancellationToken,
      );
      let envelope = parseRemoteEnvelope(result.stdout);
      if (envelope.source === 'none') {
        return { state: 'unsupported', error: envelope.data };
      }

      let parsed: ReturnType<typeof parsePrometheusMetrics>;
      if (envelope.source === 'exporter') {
        try {
          parsed = parsePrometheusMetrics(envelope.data);
        } catch (error) {
          this.log(host.alias + ': Exporter parsing failed, falling back to npu-smi: ' +
            (error instanceof Error ? error.message : String(error)));
          const fallback = await this.runner.run(
            host,
            npuSmiOnlyCommand(this.settings.npuSmiTimeoutSeconds),
            (this.settings.connectTimeoutSeconds + this.settings.npuSmiTimeoutSeconds + 3) * 1000,
            cancellationToken,
          );
          envelope = parseRemoteEnvelope(fallback.stdout);
          if (envelope.source !== 'npu-smi') {
            return { state: 'unsupported', error: envelope.data };
          }
          parsed = parseNpuSmiInfo(envelope.data);
        }
      } else {
        parsed = parseNpuSmiInfo(envelope.data);
      }

      const snapshot: HostSnapshot = {
        source: envelope.source,
        endpoint: envelope.endpoint,
        devices: parsed.devices,
        partial: parsed.partial,
        collectedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
      return { snapshot, state: parsed.partial ? 'partial' : 'unknown' };
    } catch (error) {
      if (error instanceof SshExecutionError) {
        return { state: stateFromSshError(error), error: error.message };
      }
      return {
        state: 'error',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
