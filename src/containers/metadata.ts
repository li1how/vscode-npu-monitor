import path from 'node:path';

import type { DevContainer } from '../types.js';

export function devContainerDisplayName(container: DevContainer): string {
  if (!container.isDevContainer) {
    return container.name;
  }
  const configured = container.displayName?.trim();
  if (configured) {
    return configured;
  }
  const folder = container.workspaceFolder?.replace(/\\/g, '/').replace(/\/+$/, '');
  return (folder && path.posix.basename(folder)) || 'Dev Container';
}

export function containerWorkspaceFolder(workspace: string | undefined, mounts: unknown): string | undefined {
  if (!workspace?.startsWith('/') || !Array.isArray(mounts)) {
    return undefined;
  }
  const folder = path.posix.normalize(workspace);
  const candidates = mounts.flatMap(mount => {
    if (!mount || mount.type !== 'bind' || typeof mount.source !== 'string' || typeof mount.destination !== 'string' ||
        !mount.source.startsWith('/') || !mount.destination.startsWith('/')) {
      return [];
    }
    const source = path.posix.normalize(mount.source);
    const relative = path.posix.relative(source, folder);
    return relative === '..' || relative.startsWith('../') || path.posix.isAbsolute(relative)
      ? [] : [{ source, destination: path.posix.join(mount.destination, relative) }];
  });
  return candidates.sort((a, b) => b.source.length - a.source.length)[0]?.destination;
}
