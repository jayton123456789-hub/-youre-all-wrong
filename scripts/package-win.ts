import { access, cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import { flipFuses, FuseVersion, FuseV1Options } from '@electron/fuses';
import { packager } from '@electron/packager';

import { collectWindowsVoiceResources, windowsHostVoiceLauncher } from './windows-voice-package.js';

const projectRoot = process.cwd();
const outputRoot = resolve(projectRoot, 'out');
const voiceResources = await collectWindowsVoiceResources(projectRoot, {
  requireBundledHostProfile: true,
});
const hostVoiceSource = voiceResources.find((path) => basename(path) === 'original-host-v1');
if (!hostVoiceSource) {
  throw new Error('The verified original host was not included in the Windows package plan.');
}
const stagingRoot = await mkdtemp(join(tmpdir(), 'yaw-windows-package-'));
const resolvedStagingRoot = resolve(stagingRoot);
if (
  dirname(resolvedStagingRoot) !== resolve(tmpdir()) ||
  !basename(resolvedStagingRoot).startsWith('yaw-windows-package-')
) {
  throw new Error(`Refusing to use an unsafe package staging directory: ${resolvedStagingRoot}`);
}
const stagedHostVoice = join(stagingRoot, 'host-voice');
await cp(hostVoiceSource, stagedHostVoice, { recursive: true, errorOnExist: true });

let packagePaths: string[];
try {
  packagePaths = await packager({
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
    extraResource: [...voiceResources.filter((path) => path !== hostVoiceSource), stagedHostVoice],
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
} finally {
  await rm(resolvedStagingRoot, { recursive: true });
}

if (packagePaths.length !== 1 || !packagePaths[0]) {
  throw new Error(`Expected one Windows package, received ${packagePaths.length}.`);
}

const packagePath = packagePaths[0];
const executablePath = resolve(packagePath, 'youre-all-wrong.exe');
await access(executablePath);
await Promise.all([
  access(resolve(packagePath, 'resources', 'setup-qwen-tts.ps1')),
  access(resolve(packagePath, 'resources', 'qwen-runtime-manifest.json')),
  access(resolve(packagePath, 'resources', 'qwen-voice-worker.py')),
  access(resolve(packagePath, 'resources', 'host-voice', 'approval.json')),
  access(resolve(packagePath, 'resources', 'host-voice', 'profile.json')),
  access(resolve(packagePath, 'resources', 'host-voice', 'reference.wav')),
  access(resolve(packagePath, 'resources', 'host-voice', 'provenance.json')),
]);
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
await writeFile(
  resolve(packagePath, 'INSTALL HOST VOICE.cmd'),
  windowsHostVoiceLauncher('youre-all-wrong.exe'),
  'utf8',
);

console.log(`Packaged and hardened: ${executablePath}`);
