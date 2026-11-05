import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * @param {string} changelog
 * @param {string} version
 * @returns {string[]}
 */
export function parseChangelogBullets(changelog, version) {
  const heading = `## ${version}`;
  const start = changelog.indexOf(heading);
  if (start === -1) {
    throw new Error(`CHANGELOG.md has no section for ${version}`);
  }

  const afterHeading = changelog.slice(start + heading.length);
  const nextHeading = afterHeading.search(/\n## /);
  const section =
    nextHeading === -1 ? afterHeading : afterHeading.slice(0, nextHeading);

  const bullets = section
    .split('\n')
    .map(line => line.trimEnd())
    .filter(line => /^-\s+\S/.test(line))
    .map(line => line.replace(/^-\s+/, '').trim());

  if (bullets.length === 0) {
    throw new Error(`CHANGELOG.md section ${version} has no bullets`);
  }

  return bullets;
}

/**
 * @param {string} changelog
 * @param {string} version
 * @returns {string | undefined}
 */
export function findPreviousChangelogVersion(changelog, version) {
  const heading = `## ${version}`;
  const start = changelog.indexOf(heading);
  if (start === -1) {
    return undefined;
  }

  const afterHeading = changelog.slice(start + heading.length);
  const match = afterHeading.match(/\n## (\d+\.\d+\.\d+)\b/);
  return match?.[1];
}

/**
 * @param {string} bullet
 * @returns {string}
 */
export function pickReleaseEmoji(bullet) {
  const text = bullet.toLowerCase();

  if (
    /^update\b/.test(text) ||
    /\bdependencies\b/.test(text) ||
    /\beslint\b/.test(text) ||
    /\bci tooling\b/.test(text)
  ) {
    return '🛠️';
  }
  if (/known_hosts|host key|ssh configuration/.test(text)) {
    return '🔑';
  }
  if (
    /list_host_images|candidate images/.test(text) ||
    (/\bimage id\b/.test(text) && /\bdiscover|\bimages\b/.test(text))
  ) {
    return '🖼️';
  }
  if (/\bmcp\b|refresh_containers/.test(text)) {
    return '🔌';
  }
  if (/idle history|history cells|\bbusy\b.*\bmixed\b|\bmixed\b.*\bbusy\b/.test(text)) {
    return '📈';
  }
  if (/^correct\b|^fix\b|\bbug\b/.test(text)) {
    return '🐛';
  }
  if (/\bdocker\b|container monitoring|running containers/.test(text)) {
    return '🐳';
  }
  if (/^copy\b/.test(text)) {
    return '📋';
  }
  if (/^scan\b|refresh npu|poll/.test(text)) {
    return '🔄';
  }
  if (/^simplif|\btree view\b|action placement|panel status/.test(text)) {
    return '🎛️';
  }
  if (/^add\b|^expose\b|^support\b|^optionally\b|^organize\b|^refresh dependencies\b/.test(text)) {
    return '✨';
  }

  return '✨';
}

/**
 * @param {{
 *   version: string;
 *   bullets: string[];
 *   previousVersion?: string;
 *   repository: string;
 * }} input
 * @returns {string}
 */
export function buildReleaseNotes(input) {
  const { version, bullets, previousVersion, repository } = input;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error(`Invalid repository: ${repository}`);
  }
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`Invalid version: ${version}`);
  }

  const lines = ['## What\'s Changed', ''];
  for (const bullet of bullets) {
    lines.push(`* ${pickReleaseEmoji(bullet)} ${bullet}`);
  }

  if (previousVersion) {
    if (!/^\d+\.\d+\.\d+$/.test(previousVersion)) {
      throw new Error(`Invalid previous version: ${previousVersion}`);
    }
    lines.push(
      '',
      `**Full Changelog**: https://github.com/${repository}/compare/v${previousVersion}...v${version}`,
    );
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * @param {{
 *   changelogPath: string;
 *   version: string;
 *   repository: string;
 *   previousVersion?: string;
 *   outputPath?: string;
 * }} options
 * @returns {string}
 */
export function generateReleaseNotes(options) {
  const changelog = readFileSync(options.changelogPath, 'utf8');
  const bullets = parseChangelogBullets(changelog, options.version);
  const previousVersion =
    options.previousVersion ??
    findPreviousChangelogVersion(changelog, options.version);
  const notes = buildReleaseNotes({
    version: options.version,
    bullets,
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
  const args = { ...Object.fromEntries(
    argv.flatMap((token, index) => {
      if (!token.startsWith('--')) {
        return [];
      }
      const key = token.slice(2);
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        return [[key, 'true']];
      }
      return [[key, value]];
    }),
  ) };

  const tag = env.GITHUB_REF_NAME ?? '';
  const version =
    args.version ??
    (tag.startsWith('v') ? tag.slice(1) : undefined) ??
    JSON.parse(
      readFileSync(
        path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'),
        'utf8',
      ),
    ).version;

  const repository = args.repository ?? env.GITHUB_REPOSITORY;
  if (!repository) {
    throw new Error('Pass --repository owner/repo or set GITHUB_REPOSITORY');
  }

  const projectRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
  );

  return {
    changelogPath: path.resolve(
      projectRoot,
      args.changelog ?? 'CHANGELOG.md',
    ),
    version,
    repository,
    previousVersion: args.previous,
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
    const notes = generateReleaseNotes(options);
    if (!options.outputPath) {
      process.stdout.write(notes);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
