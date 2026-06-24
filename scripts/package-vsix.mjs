import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(import.meta.dirname, '..');
const packageJson = JSON.parse(
  readFileSync(path.join(projectRoot, 'package.json'), 'utf8'),
);
const releaseDirectory = path.join(projectRoot, 'release');
const outputPath = path.join(
  releaseDirectory,
  `vscode-npu-monitor-${packageJson.version}.vsix`,
);
const vsceCli = require.resolve('@vscode/vsce/vsce');

mkdirSync(releaseDirectory, { recursive: true });

const result = spawnSync(
  process.execPath,
  [vsceCli, 'package', '--no-dependencies', '--out', outputPath],
  {
    cwd: projectRoot,
    stdio: 'inherit',
  },
);

if (result.error) {
  throw result.error;
}
if (result.status !== 0) {
  process.exitCode = result.status ?? 1;
}
