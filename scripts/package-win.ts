import { access } from 'node:fs/promises';
import { resolve } from 'node:path';

import { flipFuses, FuseVersion, FuseV1Options } from '@electron/fuses';
import { packager } from '@electron/packager';

const projectRoot = process.cwd();
const outputRoot = resolve(projectRoot, 'out');
const packagePaths = await packager({
  dir: projectRoot,
  name: "YOU'RE ALL WRONG!",
  executableName: 'youre-all-wrong',
  platform: 'win32',
  arch: 'x64',
  out: outputRoot,
  overwrite: true,
  asar: true,
  prune: true,
  icon: resolve(projectRoot, 'assets/branding/app-icon.ico'),
  ignore: [
    /^\/\.git(?:\/|$)/,
    /^\/\.github(?:\/|$)/,
    /^\/\.yallwrong(?:\/|$)/,
    /^\/coverage(?:\/|$)/,
    /^\/docs(?:\/|$)/,
    /^\/out(?:\/|$)/,
    /^\/release(?:\/|$)/,
    /^\/scripts(?:\/|$)/,
    /^\/services(?:\/|$)/,
    /^\/src(?:\/|$)/,
    /^\/content(?:\/|$)/,
    /^\/public(?:\/|$)/,
    /^\/assets\/branding\/(?:app-icon-source|app-icon)\.png$/,
    /^\/(?:README\.md|tsconfig\.json|vite\.config\.ts|vitest\.config\.ts)$/,
  ],
});

if (packagePaths.length !== 1 || !packagePaths[0]) {
  throw new Error(`Expected one Windows package, received ${packagePaths.length}.`);
}

const packagePath = packagePaths[0];
const executablePath = resolve(packagePath, 'youre-all-wrong.exe');
await access(executablePath);
await flipFuses(executablePath, {
  version: FuseVersion.V1,
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableCookieEncryption]: true,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
});
await access(executablePath);

console.log(`Packaged and hardened: ${executablePath}`);
