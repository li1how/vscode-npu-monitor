import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4.1-mini';

/**
 * @param {string} subject
 * @returns {boolean}
 */
export function isReleasePrepareSubject(subject) {
  return /^\[Release\]\s+Prepare\s+v\d+\.\d+\.\d+\b/i.test(subject.trim());
}

/**
 * @param {string} subject
 * @returns {boolean}
 */
export function isDependabotBumpSubject(subject) {
  return /^Bump\b/i.test(subject.trim());
}

/**
 * @param {string} subject
 * @returns {string}
 */
export function cleanCommitSubject(subject) {
  return subject
    .replace(/\s*\(#\d+\)\s*$/, '')
    .replace(/^\[(Fix|Feature|Feat|Chore|CI|Docs|Refactor)\]\s+/i, '')
    .trim();
}

/**
 * @param {string[]} subjects
 * @returns {string[]}
 */
export function filterReleaseSubjects(subjects) {
  return subjects
    .map(subject => subject.trim())
    .filter(Boolean)
    .filter(subject => !isReleasePrepareSubject(subject));
}

/**
 * @param {string} gitLogOutput
 * @returns {string[]}
 */
export function parseGitLogSubjects(gitLogOutput) {
  return gitLogOutput
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
}

/**
 * @param {string[]} tags newest-first, like ['v0.2.5','v0.2.4',...]
 * @param {string} currentTag
 * @returns {string | undefined}
 */
export function findPreviousTag(tags, currentTag) {
  const index = tags.indexOf(currentTag);
  if (index === -1) {
    return undefined;
  }
  return tags[index + 1];
}

/**
 * @param {{
 *   version: string;
 *   previousVersion?: string;
 *   repository: string;
 *   subjects: string[];
 * }} input
 * @returns {{ system: string; user: string }}
 */
export function buildReleaseNotesPrompt(input) {
  const { version, previousVersion, repository, subjects } = input;
  const filtered = filterReleaseSubjects(subjects);
  const compare =
    previousVersion == null
      ? '(omit the Full Changelog line; there is no previous tag)'
      : `https://github.com/${repository}/compare/v${previousVersion}...v${version}`;

  const system = [
    'You write GitHub Release notes for a VS Code extension.',
    'Output ONLY the final markdown body. No preamble, no code fences.',
    'Required format:',
    '## What\'s Changed',
    '',
    '* <emoji> <one-line summary>',
    '* <emoji> <one-line summary>',
    '',
    '**Full Changelog**: <compare-url>',
    '',
    'Rules:',
    '- Use the commit/PR subjects as the source of truth (not CHANGELOG.md).',
    '- List feature/fix bullets first, then a single dependency bullet last.',
    '- Feature and fix items: one emoji bullet each, short readable summary (you may lightly clean the PR title; keep meaning).',
    '- Prefer these emojis when they fit: 🔑 SSH/known_hosts/host keys, 🐛 other fixes, ✨ features, 🔌 MCP, 🖼️ images, 📈 idle/history, 🐳 containers, 📋 copy, 🔄 scan/refresh, 🎛️ UI, 🧰 CI.',
    '- For known_hosts / SSH host-key trust fixes, use 🔑 (not 🐛).',
    '- Collapse ALL Dependabot / "Bump …" dependency updates into exactly one bullet starting with "🛠️ Update …". Prefer "pkg to NEW" (not "from OLD to NEW") when versions are present; for "Bump A and B" without versions, include the package names.',
    '- Skip "[Release] Prepare vX.Y.Z" commits entirely.',
    '- Do not invent changes that are not in the subject list.',
    '- Keep English.',
    '- End with the Full Changelog link exactly as provided when a previous version exists.',
  ].join('\n');

  const user = [
    `Repository: ${repository}`,
    `Release version: v${version}`,
    previousVersion
      ? `Previous version: v${previousVersion}`
      : 'Previous version: (none)',
    `Full Changelog URL: ${compare}`,
    '',
    'Commits / PR subjects since the previous tag (oldest first):',
    filtered.length === 0 ? '(none)' : filtered.map(s => `- ${s}`).join('\n'),
  ].join('\n');

  return { system, user };
}

/**
 * @param {string} content
 * @param {{
 *   version: string;
 *   previousVersion?: string;
 *   repository: string;
 * }} meta
 * @returns {string}
 */
export function normalizeModelReleaseNotes(content, meta) {
  let notes = content.trim();
  notes = notes.replace(/^```(?:markdown|md)?\s*/i, '').replace(/\s*```$/, '');
  notes = notes.trim();

  if (!/^##\s+What's Changed\b/m.test(notes)) {
    throw new Error('Model output is missing "## What\'s Changed"');
  }

  if (meta.previousVersion) {
    const link = `**Full Changelog**: https://github.com/${meta.repository}/compare/v${meta.previousVersion}...v${meta.version}`;
    if (!notes.includes('**Full Changelog**:')) {
      notes = `${notes}\n\n${link}`;
    }
  }

  return `${notes.trim()}\n`;
}

/**
 * @param {{
 *   apiKey: string;
 *   baseUrl?: string;
 *   model?: string;
 *   system: string;
 *   user: string;
 *   fetchImpl?: typeof fetch;
 * }} input
 * @returns {Promise<string>}
 */
export async function requestChatCompletion(input) {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new Error('fetch is not available');
  }

  const baseUrl = (input.baseUrl ?? DEFAULT_OPENAI_BASE_URL).replace(/\/$/, '');
  const model = input.model ?? DEFAULT_MODEL;
  const response = await fetchImpl(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        { role: 'system', content: input.system },
        { role: 'user', content: input.user },
      ],
    }),
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(
      `LLM request failed (${response.status}) against ${baseUrl}: ${raw.slice(0, 500)}`,
    );
  }

  /** @type {{ choices?: Array<{ message?: { content?: string } }> }} */
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error(`LLM response was not JSON: ${raw.slice(0, 200)}`);
  }

  const content = payload.choices?.[0]?.message?.content;
  if (!content || !content.trim()) {
    throw new Error('LLM response contained an empty message');
  }
  return content;
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {string} cwd
 * @returns {string}
 */
export function runGit(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed: ${result.stderr || result.stdout}`,
    );
  }
  return result.stdout;
}

/**
 * @param {{
 *   cwd: string;
 *   version: string;
 *   previousVersion?: string;
 * }} input
 * @returns {{ previousVersion?: string; subjects: string[] }}
 */
export function collectSubjectsBetweenTags(input) {
  const currentTag = `v${input.version}`;
  const tagList = runGit(
    'git',
    ['tag', '-l', 'v*', '--sort=-v:refname'],
    input.cwd,
  )
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

  const previousTag =
    input.previousVersion != null
      ? `v${input.previousVersion}`
      : findPreviousTag(tagList, currentTag);

  const range = previousTag ? `${previousTag}..${currentTag}` : currentTag;
  const log = runGit(
    'git',
    ['log', range, '--reverse', '--format=%s'],
    input.cwd,
  );
  return {
    previousVersion: previousTag ? previousTag.slice(1) : undefined,
    subjects: parseGitLogSubjects(log),
  };
}

/**
 * @param {{
 *   cwd?: string;
 *   version: string;
 *   repository: string;
 *   previousVersion?: string;
 *   subjects?: string[];
 *   apiKey: string;
 *   baseUrl?: string;
 *   model?: string;
 *   outputPath?: string;
 *   fetchImpl?: typeof fetch;
 * }} options
 * @returns {Promise<string>}
 */
export async function generateReleaseNotes(options) {
  const cwd = options.cwd ?? process.cwd();
  let subjects = options.subjects;
  let previousVersion = options.previousVersion;

  if (!subjects) {
    const collected = collectSubjectsBetweenTags({
      cwd,
      version: options.version,
      previousVersion: options.previousVersion,
    });
    subjects = collected.subjects;
    previousVersion = previousVersion ?? collected.previousVersion;
  }

  const prompt = buildReleaseNotesPrompt({
    version: options.version,
    previousVersion,
    repository: options.repository,
    subjects,
  });

  const modelContent = await requestChatCompletion({
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
    model: options.model,
    system: prompt.system,
    user: prompt.user,
    fetchImpl: options.fetchImpl,
  });

  const notes = normalizeModelReleaseNotes(modelContent, {
    version: options.version,
    previousVersion,
    repository: options.repository,
  });

  if (options.outputPath) {
    mkdirSync(path.dirname(options.outputPath), { recursive: true });
    writeFileSync(options.outputPath, notes, 'utf8');
  }

  return notes;
}

/**
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} [env]
 */
export function parseCliArgs(argv, env = process.env) {
  /** @type {Record<string, string>} */
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      continue;
    }
    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      args[key] = 'true';
      continue;
    }
    args[key] = value;
    index += 1;
  }

  const tag = env.GITHUB_REF_NAME ?? '';
  const version =
    args.version ??
    (tag.startsWith('v') ? tag.slice(1) : undefined) ??
    JSON.parse(
      readFileSync(
        path.resolve(
          path.dirname(fileURLToPath(import.meta.url)),
          '..',
          'package.json',
        ),
        'utf8',
      ),
    ).version;

  const repository = args.repository ?? env.GITHUB_REPOSITORY;
  if (!repository) {
    throw new Error('Pass --repository owner/repo or set GITHUB_REPOSITORY');
  }

  const apiKey = args['api-key'] ?? env.OPENAI_API_KEY ?? env.RELEASE_NOTES_API_KEY;
  if (!apiKey) {
    throw new Error(
      'Missing OPENAI_API_KEY (or RELEASE_NOTES_API_KEY). Add it as a repository Actions secret and pass it to the Release VSIX workflow.',
    );
  }

  const projectRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
  );

  return {
    cwd: projectRoot,
    version,
    repository,
    previousVersion: args.previous,
    apiKey,
    baseUrl:
      args['base-url'] ||
      env.OPENAI_BASE_URL ||
      env.RELEASE_NOTES_API_BASE ||
      undefined,
    model: args.model || env.RELEASE_NOTES_MODEL || DEFAULT_MODEL,
    outputPath: args.output
      ? path.resolve(projectRoot, args.output)
      : undefined,
  };
}

function isMainModule() {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  return import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

if (isMainModule()) {
  try {
    const options = parseCliArgs(process.argv.slice(2));
    const notes = await generateReleaseNotes(options);
    if (!options.outputPath) {
      process.stdout.write(notes);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
