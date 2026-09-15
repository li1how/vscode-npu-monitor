import path from 'node:path';

import type * as vscode from 'vscode';

import { SshExecutionError } from '../ssh/runner.js';
import type { SshRunner } from '../ssh/runner.js';
import type {
  DevContainer, DevContainerScanResult, DevContainerState, MonitorSettings, SshHost,
} from '../types.js';
import { containerWorkspaceFolder, devContainerDisplayName, isValidWorkspaceFileName } from './metadata.js';

const STATUS = '__NPU_MONITOR_DOCKER_STATUS__';
const BEGIN = '__NPU_MONITOR_DOCKER_BEGIN__';
const END = '__NPU_MONITOR_DOCKER_END__';
const WORKSPACE_FILE = '__NPU_MONITOR_WORKSPACE_FILE__';

// Only selected fields leave the host; never serialize Config.Env or all labels.
const INSPECT_FORMAT = '{"id":{{json .Id}},"name":{{json .Name}},' +
  '"image":{{json .Config.Image}},"state":{{json .State.Status}},' +
  '"createdAt":{{json .Created}},"startedAt":{{json .State.StartedAt}},' +
  '"workspaceFolder":{{json (index .Config.Labels "devcontainer.local_folder")}},' +
  '"legacyFolder":{{json (index .Config.Labels "vsch.local.folder")}},' +
  '"configFile":{{json (index .Config.Labels "devcontainer.config_file")}},' +
  '"mounts":[{{range $i,$m := .Mounts}}{{if $i}},{{end}}' +
  '{"type":{{json $m.Type}},"source":{{json $m.Source}},"destination":{{json $m.Destination}}}{{end}}]}';
const LIST_FORMAT = '{{.ID}}';
const WORKSPACE_FORMAT = '{{if index .Config.Labels "devcontainer.local_folder"}}' +
  '{{index .Config.Labels "devcontainer.local_folder"}}{{else}}' +
  '{{index .Config.Labels "vsch.local.folder"}}{{end}}';

// Runs on the SSH host. Read only the labeled configuration, and send only its
// top-level name back; comments and trailing commas are accepted without eval.
export const RESOLVE_DEV_CONTAINER_NAMES = String.raw`
import json, os, re, stat, sys
from urllib.parse import urlsplit, unquote

cache = {}
limit = 65536
tokens = re.compile(r'"(?:[^"\\]|\\.)*"|//[^\r\n]*|/\*[\s\S]*?\*/')
commas = re.compile(r'"(?:[^"\\]|\\.)*"|,(?=\s*[}\]])')

def configured_name(filename):
    if not isinstance(filename, str) or not filename:
        return None
    if filename in cache:
        return cache[filename]
    cache[filename] = None
    local_path = filename
    if filename.startswith('file:'):
        uri = urlsplit(filename)
        if uri.netloc not in ('', 'localhost'):
            return None
        local_path = unquote(uri.path)
    if not os.path.isabs(local_path):
        return None
    try:
        with os.fdopen(os.open(local_path, os.O_RDONLY | os.O_NONBLOCK),
                       'rb') as stream:
            if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                return None
            content = stream.read(limit + 1)
        if len(content) > limit:
            return None
        content = content.decode('utf-8-sig')
        content = tokens.sub(lambda m: ' ' if m.group().startswith('/') else m.group(), content)
        content = commas.sub(lambda m: '' if m.group() == ',' else m.group(), content)
        config = json.loads(content)
        name = config.get('name') if isinstance(config, dict) else None
        if isinstance(name, str) and name.strip():
            cache[filename] = name.strip()
    except (OSError, ValueError, UnicodeError, RecursionError):
        pass
    return cache[filename]

for line in sys.stdin:
    try:
        item = json.loads(line)
        if isinstance(item, dict) and isinstance(item.get('id'), str):
            name = configured_name(item.get('configFile'))
            if name:
                item['configuredName'] = name
            print(json.dumps(item, ensure_ascii=True))
        else:
            sys.stdout.write(line)
    except (ValueError, RecursionError):
        sys.stdout.write(line)
`.trim();

function shellSingleQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

export function buildDevContainerScanCommand(workspaceFileName = ''): string {
  const nameResolver = "'" + RESOLVE_DEV_CONTAINER_NAMES.replace(/'/g, "'\\''") + "'";
  const workspaceFile = shellSingleQuote(isValidWorkspaceFileName(workspaceFileName) ? workspaceFileName : '');
  return [
    'export LC_ALL=C',
    `workspace_file=${workspaceFile}`,
    'if ! command -v docker >/dev/null 2>&1; then',
    `  printf '${STATUS}missingDocker\\n${BEGIN}\\n${END}\\n'`,
    '  exit 0',
    'fi',
    `listing="$(docker ps -a --no-trunc --format '${LIST_FORMAT}' 2>&1)"`,
    'list_status=$?',
    'if [ "$list_status" -ne 0 ]; then',
    `  printf '${STATUS}error\\n${BEGIN}\\n%s\\n${END}\\n' "$listing"`,
    '  exit 0',
    'fi',
    // Validate IDs before word splitting, without executing remote output as code.
    'set --',
    'for id in $listing; do',
    '  case "$id" in *[!0-9a-f]*|"")',
    `    printf '${STATUS}error\\n${BEGIN}\\nInvalid container ID in Docker listing.\\n${END}\\n'; exit 0 ;;`,
    '  esac',
    '  if [ "${#id}" -ne 64 ]; then',
    `    printf '${STATUS}error\\n${BEGIN}\\nInvalid container ID in Docker listing.\\n${END}\\n'; exit 0`,
    '  fi',
    '  set -- "$@" "$id"',
    'done',
    `printf '${STATUS}inspect\\n${BEGIN}\\n'`,
    'if [ "$#" -gt 0 ]; then',
    `  inspection="$(docker inspect --type container --format '${INSPECT_FORMAT}' "$@" 2>&1)"`,
    '  inspect_status=$?',
    '  if command -v python3 >/dev/null 2>&1; then',
    `    named="$(printf '%s\\n' "$inspection" | python3 -I -S -c ${nameResolver})"`,
    '    if [ "$?" -eq 0 ]; then inspection="$named"; fi',
    '  fi',
    '  printf \'%s\\n\' "$inspection"',
    '  if [ -n "$workspace_file" ]; then',
    '    for id in "$@"; do',
    `      workspace="$(docker inspect --type container --format '${WORKSPACE_FORMAT}' "$id" 2>/dev/null)" || continue`,
    `      if [ -n "$workspace" ] && [ -f "$workspace/$workspace_file" ]; then`,
    `        printf '${WORKSPACE_FILE}%s\\n' "$id"`,
    '      fi',
    '    done',
    '  fi',
    'else',
    '  inspect_status=0',
    'fi',
    `printf '\\n${END}\\n%s\\n' "$inspect_status"`,
    'exit 0',
  ].join('\n');
}

function errorState(message: string): DevContainerState {
  if (/permission denied|access denied|operation not permitted/i.test(message)) {
    return 'permissionDenied';
  }
  if (/cannot connect|is the docker daemon running|error during connect|connection refused/i.test(message)) {
    return 'daemonUnavailable';
  }
  return 'error';
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function parseDevContainerOutput(stdout: string, workspaceFileName = ''): DevContainerScanResult {
  const lines = stdout.split(/\r?\n/);
  const status = lines.find(line => line.startsWith(STATUS))?.slice(STATUS.length);
  const begin = lines.indexOf(BEGIN);
  const end = lines.indexOf(END, begin + 1);
  if (!status || begin < 0 || end <= begin) {
    throw new Error('Incomplete Dev Container scan output.');
  }
  const data = lines.slice(begin + 1, end).filter(line => line.trim());
  const workspaceFileContainers = new Set<string>();
  for (const line of data.filter(value => value.startsWith(WORKSPACE_FILE))) {
    const id = line.slice(WORKSPACE_FILE.length);
    if (!/^[a-f0-9]{64}$/.test(id)) {
      throw new Error('Invalid workspace file scan output.');
    }
    workspaceFileContainers.add(id);
  }
  if (status === 'missingDocker') {
    return { state: 'missingDocker' };
  }
  if (status === 'error') {
    const error = data.join('\n');
    return { state: errorState(error), error };
  }
  if (status !== 'inspect' || !/^\d+$/.test(lines[end + 1] ?? '')) {
    throw new Error('Invalid Dev Container scan status.');
  }

  const containers = new Map<string, DevContainer>();
  const errors: string[] = [];
  let removed = false;
  for (const line of data) {
    if (line.startsWith(WORKSPACE_FILE)) {
      continue;
    }
    // A container may disappear between list and inspect. Other errors remain errors.
    if (/^(?:Error:|Error response from daemon:) No such (?:object|container): [a-f0-9]{64}$/.test(line)) {
      removed = true;
      continue;
    }
    if (!line.startsWith('{')) {
      errors.push(line);
      continue;
    }
    const value = JSON.parse(line) as Record<string, unknown>;
    if (!value || typeof value.id !== 'string' || !/^[a-f0-9]{64}$/.test(value.id) ||
        !['name', 'image', 'state', 'createdAt'].every(key => typeof value[key] === 'string')) {
      throw new Error('Invalid Dev Container metadata.');
    }
    const workspaceFolder = optionalString(value.workspaceFolder) ?? optionalString(value.legacyFolder);
    const configFile = optionalString(value.configFile);
    const mappedWorkspace = containerWorkspaceFolder(workspaceFolder, value.mounts);
    containers.set(value.id, {
      id: value.id,
      isDevContainer: Boolean(workspaceFolder || configFile),
      name: (value.name as string).replace(/^\//, ''),
      displayName: optionalString(value.configuredName)?.trim() || undefined,
      image: value.image as string,
      state: value.state as string,
      createdAt: value.createdAt as string,
      startedAt: typeof value.startedAt === 'string' && !value.startedAt.startsWith('0001-')
        ? optionalString(value.startedAt) : undefined,
      workspaceFolder,
      containerWorkspaceFolder: mappedWorkspace,
      containerWorkspaceFile: mappedWorkspace && workspaceFileName &&
        isValidWorkspaceFileName(workspaceFileName) && workspaceFileContainers.has(value.id)
        ? path.posix.join(mappedWorkspace, workspaceFileName) : undefined,
      configFile,
    });
  }
  if (errors.length > 0 || (lines[end + 1] !== '0' && !removed)) {
    const error = errors.join('\n') || 'Docker inspect failed.';
    return { state: errorState(error), error };
  }
  return {
    state: 'ready',
    snapshot: {
      containers: [...containers.values()].sort((a, b) =>
        devContainerDisplayName(a).localeCompare(devContainerDisplayName(b)) || a.id.localeCompare(b.id)),
      collectedAt: Date.now(),
      durationMs: 0,
    },
  };
}

export class DevContainerCollector {
  public constructor(private readonly runner: SshRunner, private readonly settings: MonitorSettings) {}

  public async scan(host: SshHost, token?: vscode.CancellationToken): Promise<DevContainerScanResult> {
    const startedAt = Date.now();
    try {
      const result = await this.runner.run(host, buildDevContainerScanCommand(this.settings.containerWorkspaceFile),
        (this.settings.connectTimeoutSeconds + this.settings.devContainersTimeoutSeconds) * 1000, token);
      const parsed = parseDevContainerOutput(result.stdout, this.settings.containerWorkspaceFile);
      if (parsed.snapshot) {
        parsed.snapshot.durationMs = Date.now() - startedAt;
      }
      return parsed;
    } catch (error) {
      return {
        state: error instanceof SshExecutionError ? error.kind : 'error',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
