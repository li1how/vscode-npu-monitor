import { execFile } from 'node:child_process';
import console from 'node:console';
import { access, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

// Some minimal WSL/Debian environments lack these two Electron libraries.
// Download and extract them into the ignored cache; never install system packages.
export async function linuxLibraries(executable, cache) {
  if (process.platform !== 'linux') return {};
  const architecture = { x64: 'x86_64-linux-gnu', arm64: 'aarch64-linux-gnu', arm: 'arm-linux-gnueabihf' }[process.arch];
  if (!architecture) throw new Error('Unsupported Linux architecture: ' + process.arch);
  const directory = path.join(cache, 'libraries');
  const libraryPath = [path.join(directory, 'usr/lib', architecture), process.env.LD_LIBRARY_PATH]
    .filter(Boolean).join(path.delimiter);
  const env = { ...process.env, LD_LIBRARY_PATH: libraryPath };
  const binaries = [executable, path.join(path.dirname(executable),
    'resources/app/node_modules/native-keymap/build/Release/keymapping.node')];
  const missing = new Set();
  for (const binary of binaries) {
    try { await access(binary); } catch { continue; }
    const { stdout } = await execute('ldd', [binary], { env });
    for (const match of stdout.matchAll(/(\S+) => not found/g)) missing.add(match[1]);
  }
  const packages = { 'libasound.so.2': ['libasound2t64', 'libasound2'], 'libxkbfile.so.1': ['libxkbfile1'] };
  for (const library of missing) {
    if (!packages[library]) throw new Error(`Missing ${library}. Install the VS Code Linux runtime dependencies and retry.`);
    await mkdir(directory, { recursive: true });
    const download = await mkdtemp(path.join(cache, 'library-'));
    try {
      console.log('Preparing isolated Linux library: ' + library);
      let downloaded = false;
      for (const name of packages[library]) {
        try {
          await execute('apt-get', ['download', name], { cwd: download, timeout: 60000 });
          downloaded = true;
          break;
        } catch { /* Try the package name used by the other Debian/Ubuntu release. */ }
      }
      if (!downloaded) throw new Error(`Cannot download ${library}. Install it using your distribution's package manager and retry.`);
      for (const archive of await readdir(download)) {
        if (archive.endsWith('.deb')) await execute('dpkg-deb', ['-x', path.join(download, archive), directory]);
      }
    } finally {
      await rm(download, { recursive: true, force: true });
    }
  }
  return { LD_LIBRARY_PATH: libraryPath };
}
