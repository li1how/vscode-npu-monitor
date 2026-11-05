import { pathToFileURL } from 'node:url';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const scriptPath = path.join(process.cwd(), 'scripts/generate-release-notes.mjs');

type ReleaseNotesModule = {
  isReleasePrepareSubject: (subject: string) => boolean;
  isDependabotBumpSubject: (subject: string) => boolean;
  filterReleaseSubjects: (subjects: string[]) => string[];
  findPreviousTag: (tags: string[], currentTag: string) => string | undefined;
  buildReleaseNotesPrompt: (input: {
    version: string;
    previousVersion?: string;
    repository: string;
    subjects: string[];
  }) => { system: string; user: string };
  normalizeModelReleaseNotes: (
    content: string,
    meta: { version: string; previousVersion?: string; repository: string },
  ) => string;
  generateReleaseNotes: (options: {
    version: string;
    repository: string;
    previousVersion?: string;
    subjects: string[];
    apiKey: string;
    fetchImpl: typeof fetch;
  }) => Promise<string>;
  parseCliArgs: (
    argv: string[],
    env?: NodeJS.ProcessEnv,
  ) => { apiKey: string; version: string };
};

async function loadModule(): Promise<ReleaseNotesModule> {
  return (await import(pathToFileURL(scriptPath).href)) as ReleaseNotesModule;
}

const v025Subjects = [
  'Bump vite from 8.3.0 to 8.3.4 (#19)',
  'Bump hono from 4.13.8 to 4.13.13 (#20)',
  'Bump @modelcontextprotocol/sdk from 1.31.0 to 1.32.0 (#21)',
  'Bump markdown-it from 14.3.2 to 14.3.3 (#22)',
  'Bump fast-uri from 3.1.8 to 3.1.9 (#24)',
  'Bump undici from 7.29.1 to 7.30.1 (#25)',
  'Bump body-parser from 2.3.0 to 2.4.0 (#26)',
  'Bump @vitest/mocker and vitest (#23)',
  'Bump ip-address from 10.7.2 to 10.7.5 (#27)',
  'Bump zod from 4.6.5 to 4.6.7 (#28)',
  'Bump @hono/node-server from 2.1.1 to 2.1.6 (#29)',
  'Bump @azure/msal-node and @azure/identity (#31)',
  '[Fix] Read both known_hosts locations',
  '[Release] Prepare v0.2.5',
];

describe('generate-release-notes', () => {
  it('filters release-prep commits and detects dependabot bumps', async () => {
    const mod = await loadModule();
    expect(mod.isReleasePrepareSubject('[Release] Prepare v0.2.5')).toBe(true);
    expect(mod.isDependabotBumpSubject('Bump vite from 8.3.0 to 8.3.4 (#19)')).toBe(
      true,
    );
    expect(mod.filterReleaseSubjects(v025Subjects)).not.toContain(
      '[Release] Prepare v0.2.5',
    );
    expect(mod.findPreviousTag(['v0.2.5', 'v0.2.4', 'v0.2.3'], 'v0.2.5')).toBe(
      'v0.2.4',
    );
  });

  it('builds a prompt from commits between tags', async () => {
    const mod = await loadModule();
    const prompt = mod.buildReleaseNotesPrompt({
      version: '0.2.5',
      previousVersion: '0.2.4',
      repository: 'li1how/vscode-npu-monitor',
      subjects: v025Subjects,
    });

    expect(prompt.system).toContain('Collapse ALL Dependabot');
    expect(prompt.user).toContain('[Fix] Read both known_hosts locations');
    expect(prompt.user).not.toContain('[Release] Prepare v0.2.5');
    expect(prompt.user).toContain(
      'https://github.com/li1how/vscode-npu-monitor/compare/v0.2.4...v0.2.5',
    );
  });

  it('normalizes model markdown and appends changelog link if missing', async () => {
    const mod = await loadModule();
    const notes = mod.normalizeModelReleaseNotes(
      '## What\'s Changed\n\n* 🔑 Read both known_hosts locations\n* 🛠️ Update vite to 8.3.4\n',
      {
        version: '0.2.5',
        previousVersion: '0.2.4',
        repository: 'li1how/vscode-npu-monitor',
      },
    );

    expect(notes).toContain('**Full Changelog**: https://github.com/li1how/vscode-npu-monitor/compare/v0.2.4...v0.2.5');
  });

  it('calls the LLM and writes emoji-style notes', async () => {
    const mod = await loadModule();
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: `## What's Changed

* 🔑 Read both known_hosts locations
* 🛠️ Update vite to 8.3.4, hono to 4.13.13, @modelcontextprotocol/sdk to 1.32.0, markdown-it to 14.3.3, fast-uri to 3.1.9, undici to 7.30.1, body-parser to 2.4.0, @vitest/mocker and vitest, ip-address to 10.7.5, zod to 4.6.7, @hono/node-server to 2.1.6, and @azure/msal-node and @azure/identity

**Full Changelog**: https://github.com/li1how/vscode-npu-monitor/compare/v0.2.4...v0.2.5
`,
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );

    const notes = await mod.generateReleaseNotes({
      version: '0.2.5',
      previousVersion: '0.2.4',
      repository: 'li1how/vscode-npu-monitor',
      subjects: v025Subjects,
      apiKey: 'test-key',
      fetchImpl,
    });

    expect(notes).toContain('* 🔑 Read both known_hosts locations');
    expect(notes).toContain('* 🛠️ Update vite to 8.3.4');
    expect(notes).not.toContain('[Release] Prepare');
  });

  it('requires an API key in CLI args', async () => {
    const mod = await loadModule();
    expect(() =>
      mod.parseCliArgs(['--version', '0.2.5', '--repository', 'li1how/vscode-npu-monitor'], {}),
    ).toThrow(/OPENAI_API_KEY/);
  });
});
