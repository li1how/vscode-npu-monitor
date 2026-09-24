import { SshExecutionError } from '../ssh/runner.js';
import type { SshRunner } from '../ssh/runner.js';
import type { SshHost } from '../types.js';

export interface HostImage {
  id: string;
  tags: string[];
  createdAt: string;
  architecture: string;
  os: string;
}

const ID = /^sha256:[a-f0-9]{64}$/;
const MAX_IMAGES = 20;
const LIST = "docker image ls --filter 'reference=*vllm*ascend*' --no-trunc --format '{{json .}}'";
const FORMAT = '{"id":{{json .Id}},"tags":{{json .RepoTags}},' +
  '"createdAt":{{json .Created}},"architecture":{{json .Architecture}},"os":{{json .Os}}}';

export class ImageCollector {
  public constructor(private readonly runner: SshRunner) {}

  public async list(host: SshHost): Promise<{ host: string; collectedAt: number; state: string; images: HostImage[]; error?: string }> {
    try {
      const listing = await this.runner.run(host, LIST, 15000);
      const ids: string[] = [];
      for (const line of listing.stdout.split(/\r?\n/).filter(Boolean)) {
        const row = JSON.parse(line) as Record<string, unknown>;
        if (typeof row.Repository !== 'string' || !/vllm[-_]ascend/i.test(row.Repository)) continue;
        if (typeof row.ID !== 'string' || !ID.test(row.ID)) throw new Error('Invalid Docker image ID');
        if (!ids.includes(row.ID)) ids.push(row.ID);
        if (ids.length >= MAX_IMAGES) break;
      }
      if (ids.length === 0) return { host: host.alias, collectedAt: Date.now(), state: 'ready', images: [] };
      // IDs are validated before interpolation; this command only reads selected Docker metadata.
      const command = `docker image inspect --format '${FORMAT}' ${ids.join(' ')}`;
      const inspection = await this.runner.run(host, command, 15000);
      const images = inspection.stdout.split(/\r?\n/).filter(Boolean).map(line => {
        const row = JSON.parse(line) as Record<string, unknown>;
        if (typeof row.id !== 'string' || !ID.test(row.id) || !ids.includes(row.id) ||
            !Array.isArray(row.tags) || !row.tags.every(tag => typeof tag === 'string') ||
            typeof row.createdAt !== 'string' || typeof row.architecture !== 'string' ||
            typeof row.os !== 'string') throw new Error('Invalid Docker image metadata');
        return { id: row.id, tags: row.tags.filter((tag): tag is string => typeof tag === 'string'),
          createdAt: row.createdAt, architecture: row.architecture, os: row.os };
      });
      return { host: host.alias, collectedAt: Date.now(), state: 'ready', images };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const state = error instanceof SshExecutionError && error.kind !== 'error' ? error.kind :
        /not found|command not found/i.test(message) ? 'missingDocker' :
        /permission denied|access denied/i.test(message) ? 'permissionDenied' :
        /cannot connect|daemon.*not running/i.test(message) ? 'daemonUnavailable' : 'error';
      return { host: host.alias, collectedAt: Date.now(), state, images: [], error: message };
    }
  }
}
