// `crewroom update`: find the latest version on GitHub and reinstall the same way Crewroom was
// installed (npm global package, or the portable Windows package), then reconnect the apps.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { CLI_PATH } from './util.js';

export const REPO = '0GithubDoN/crewroom';
const PACKAGE_URL = `https://raw.githubusercontent.com/${REPO}/main/package.json`;
const TARBALL = `https://github.com/${REPO}/archive/refs/heads/main.tar.gz`;

/** "1.2.10" > "1.2.9" */
export function newer(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}

export async function latestVersion({ timeoutMs = 8000 } = {}) {
  const res = await fetch(PACKAGE_URL, { signal: AbortSignal.timeout(timeoutMs), headers: { 'cache-control': 'no-cache' } });
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  return (await res.json()).version;
}

/** How this copy was installed: decides how to update it. */
export function installKind(cliPath = CLI_PATH) {
  const dir = path.dirname(path.dirname(cliPath));
  if (fs.existsSync(path.join(dir, '.git'))) return 'git';
  if (process.platform === 'win32' && /[\\/]Crewroom[\\/]app$/i.test(dir) && fs.existsSync(path.join(path.dirname(dir), 'node.exe'))) return 'portable';
  return 'npm';
}

const run = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
  const child = spawn(cmd, args, { stdio: 'inherit', ...opts });
  child.on('error', reject);
  child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited with code ${code}`))));
});

/** Install the latest version over this one. */
export async function install(kind = installKind()) {
  if (kind === 'git') throw new Error('This is a git checkout: update it with "git pull" (and "npm install").');
  if (kind === 'portable') {
    // Download the release zip and run its installer, which replaces %LOCALAPPDATA%\Crewroom.
    const script = [
      "$ErrorActionPreference = 'Stop'",
      `$rel = Invoke-RestMethod 'https://api.github.com/repos/${REPO}/releases/latest'`,
      "$asset = $rel.assets | Where-Object { $_.name -like '*windows-x64.zip' } | Select-Object -First 1",
      "if (-not $asset) { throw 'No Windows package in the latest release.' }",
      "$tmp = Join-Path $env:TEMP ('crewroom-update-' + [guid]::NewGuid())",
      'New-Item -ItemType Directory -Path $tmp | Out-Null',
      '$zip = Join-Path $tmp $asset.name',
      'Invoke-WebRequest $asset.browser_download_url -OutFile $zip',
      'Expand-Archive $zip -DestinationPath $tmp',
      "& (Join-Path $tmp 'Crewroom\\install-portable.ps1')",
    ].join('; ');
    return run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script]);
  }
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  return run(npm, ['install', '-g', TARBALL], { shell: process.platform === 'win32' });
}

