import { downloadAndUnzipVSCode } from '@vscode/test-electron';
import { build } from 'esbuild';
import console from 'node:console';
import { writeFileSync } from 'node:fs';
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';
import { _electron } from 'playwright';

import { linuxLibraries } from './readme/runtime.mjs';
import { ASSETS, captureScenes } from './readme/scenes.mjs';

const root = path.resolve(import.meta.dirname, '..');
const cache = path.join(root, 'release/readme-capture');
const version = '1.100.3';
const { values } = parseArgs({ options: {
  'vscode-path': { type: 'string' }, 'output-dir': { type: 'string' }, help: { type: 'boolean' },
} });

async function main() {
  if (values.help) {
    console.log('Usage: npm run docs:capture -- [--vscode-path /path/to/native/code] [--output-dir /path/to/images]');
    console.log(`Downloads VS Code ${version} to release/readme-capture; replaces the three README assets in media/.`);
    return;
  }
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    throw new Error('A graphical display is required. Use WSLg/a desktop, or xvfb-run -a npm run docs:capture.');
  }
  await mkdir(cache, { recursive: true });
  const executable = values['vscode-path'] ? path.resolve(values['vscode-path'])
    : await downloadAndUnzipVSCode({ version, cachePath: cache, timeout: 60000 });
  await access(executable);
  const libraries = await linuxLibraries(executable, cache);
  const run = await mkdtemp(path.join(cache, 'run-'));
  const extension = path.join(run, 'extension');
  const profile = path.join(run, 'profile');
  const output = path.join(run, 'images');
  const destination = path.resolve(root, values['output-dir'] ?? 'media');
  // Electron startup can reject a Playwright internal promise before launch()
  // returns. Preserve diagnostics even if Node treats that rejection as fatal.
  const reportCrash = error => {
    try { writeFileSync(path.join(run, 'error.log'), String(error.stack ?? error)); } catch { /* Preserve the original failure. */ }
    console.error('Capture failed; diagnostics retained at ' + run);
  };
  process.on('uncaughtExceptionMonitor', reportCrash);
  let app;
  let window;
  try {
    for (const directory of [extension, path.join(profile, 'User'), output, path.join(run, 'extensions'), path.join(run, 'workspace')]) {
      await mkdir(directory, { recursive: true });
    }
    const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    await writeFile(path.join(extension, 'package.json'), JSON.stringify({ ...manifest, main: './extension.js' }));
    for (const file of ['media/npu-monitor.svg', 'l10n', 'package.nls.json', 'package.nls.zh-cn.json']) {
      await cp(path.join(root, file), path.join(extension, file), { recursive: true });
    }
    let replacedService = false;
    const bundled = await build({
      entryPoints: [path.join(root, 'scripts/readme/extension.ts')], bundle: true,
      platform: 'node', format: 'cjs', target: 'node20', external: ['vscode'],
      outfile: path.join(extension, 'extension.js'), metafile: true,
      plugins: [{ name: 'readme-fixtures', setup(builder) {
        builder.onResolve({ filter: /(^|[\\/])monitorService\.(js|ts)$/ }, args => {
          const resolved = path.resolve(args.resolveDir, args.path);
          if ([path.join(root, 'src/monitorService.js'), path.join(root, 'src/monitorService.ts')].includes(resolved)) {
            replacedService = true;
            return { path: path.join(root, 'scripts/readme/fixtures.ts') };
          }
        });
      } }],
    });
    const forbidden = ['src/monitorService.ts', 'src/npu/collector.ts', 'src/containers/collector.ts'];
    if (!replacedService || Object.keys(bundled.metafile.inputs).some(file => {
      const relative = path.relative(root, path.resolve(file)).replaceAll('\\', '/');
      return forbidden.includes(relative);
    })) {
      throw new Error('README build unexpectedly contains the production collection service.');
    }
    await writeFile(path.join(profile, 'User/settings.json'), JSON.stringify({
      'workbench.colorTheme': 'Default Dark Modern', 'workbench.startupEditor': 'none',
      'window.titleBarStyle': 'custom', 'window.commandCenter': false, 'window.zoomLevel': 0,
      'workbench.activityBar.location': 'default', 'workbench.statusBar.visible': false,
      'workbench.tree.renderIndentGuides': 'always',
      'workbench.tips.enabled': false, 'security.workspace.trust.enabled': false,
      'telemetry.telemetryLevel': 'off', 'update.mode': 'none',
      'extensions.autoCheckUpdates': false, 'extensions.autoUpdate': false,
      'extensions.ignoreRecommendations': true, 'git.enabled': false,
      'editor.minimap.enabled': false, 'breadcrumbs.enabled': false,
      'npuMonitor.mcp.enabled': false, 'npuMonitor.autoRefreshAllHosts': false,
    }));
    app = await _electron.launch({
      executablePath: executable,
      args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--skip-welcome',
        '--skip-release-notes', '--disable-workspace-trust', '--password-store=basic', '--locale=en',
        `--user-data-dir=${profile}`, `--extensions-dir=${path.join(run, 'extensions')}`,
        `--extensionDevelopmentPath=${extension}`, path.join(run, 'workspace')],
      env: { ...process.env, ...libraries, TZ: 'Asia/Shanghai', ELECTRON_RUN_AS_NODE: undefined },
      timeout: 45000,
    });
    window = await app.firstWindow();
    await captureScenes(window, output);
    await app.close();
    app = undefined;
    // Publish only after every scene and encoded image has passed its checks.
    await mkdir(destination, { recursive: true });
    for (const asset of ASSETS) await cp(path.join(output, asset), path.join(destination, asset));
    console.log('Updated ' + ASSETS.map(asset => path.join(destination, asset)).join('\nUpdated '));
    await rm(run, { recursive: true, force: true });
  } catch (error) {
    await writeFile(path.join(run, 'error.log'), String(error.stack ?? error));
    if (window && !window.isClosed()) await window.screenshot({ path: path.join(run, 'failure.png') }).catch(() => {});
    console.error('Capture failed; diagnostics retained at ' + run);
    throw error;
  } finally {
    process.off('uncaughtExceptionMonitor', reportCrash);
    if (app) await app.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
