import path from 'node:path';

import type { DevContainer, MonitorSettings } from '../types.js';

type FilterSettings = Pick<MonitorSettings, 'containerFilterMode' | 'containerWorkspacePaths'>;

function absoluteWorkspacePath(value: string | undefined): string | undefined {
  if (!value?.startsWith('/') || value.includes('\0')) return undefined;
  return path.posix.normalize(value).replace(/\/+$/, '') || '/';
}

export function invalidWorkspacePathCount(settings: FilterSettings): number {
  return settings.containerFilterMode === 'workspacePaths'
    ? settings.containerWorkspacePaths.filter(value => !absoluteWorkspacePath(value)).length : 0;
}

export function filterContainers(containers: DevContainer[], settings: FilterSettings): DevContainer[] {
  if (settings.containerFilterMode === 'all') {
    return containers;
  }
  const devContainers = containers.filter(container => container.isDevContainer);
  if (settings.containerFilterMode !== 'workspacePaths' || !settings.containerWorkspacePaths.length) {
    return devContainers;
  }
  const paths = settings.containerWorkspacePaths.map(absoluteWorkspacePath)
    .filter((value): value is string => value !== undefined);
  return devContainers.filter(container => {
    const workspace = absoluteWorkspacePath(container.workspaceFolder);
    return workspace !== undefined && paths.some(root =>
      workspace === root || workspace.startsWith(root === '/' ? root : root + '/'));
  });
}
