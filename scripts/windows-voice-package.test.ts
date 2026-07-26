import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { PACKAGED_QWEN_RESOURCE_NAMES } from '../src/desktop/packaged-voice-resources.js';
import { collectWindowsVoiceResources, windowsHostVoiceLauncher } from './windows-voice-package.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function copiedProject(includeHost = true): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'yaw-package-plan-'));
  temporaryDirectories.push(root);
  await mkdir(join(root, 'services'), { recursive: true });
  for (const name of PACKAGED_QWEN_RESOURCE_NAMES) {
    await cp(resolve('services', name), join(root, 'services', name));
  }
  if (includeHost) {
    await mkdir(join(root, 'assets', 'voice'), { recursive: true });
    await cp(
      resolve('assets', 'voice', 'original-host-v1'),
      join(root, 'assets', 'voice', 'original-host-v1'),
      { recursive: true },
    );
  }
  return root;
}

describe('Windows neural-host package plan', () => {
  it('includes every verified executable resource when no host has been approved', async () => {
    const root = await copiedProject(false);
    const resources = await collectWindowsVoiceResources(root);

    expect(resources.map((path) => basename(path))).toEqual(PACKAGED_QWEN_RESOURCE_NAMES);
  });

  it('includes only the owner-approved original host package', async () => {
    const resources = await collectWindowsVoiceResources(process.cwd(), {
      requireBundledHostProfile: true,
    });

    expect(resources.map((path) => basename(path))).toEqual([
      ...PACKAGED_QWEN_RESOURCE_NAMES,
      'original-host-v1',
    ]);
    expect(
      JSON.parse(await readFile(resolve('assets/voice/original-host-v1/approval.json'), 'utf8')),
    ).toMatchObject({
      status: 'approved',
      engine: 'qwen3-tts',
      syntheticOriginal: true,
      approvedAsRendered: true,
    });
  });

  it('rejects a modified executable resource before packaging', async () => {
    const root = await copiedProject();
    await writeFile(
      join(root, 'services', 'setup-qwen-tts.ps1'),
      '# untrusted replacement',
      'utf8',
    );

    await expect(collectWindowsVoiceResources(root)).rejects.toThrow(
      /failed its trusted SHA-256 check/u,
    );
  });

  it('rejects undeclared files in the bundled host directory', async () => {
    const root = await copiedProject();
    const undeclared = join(root, 'assets', 'voice', 'original-host-v1', 'unapproved-audition.wav');
    await mkdir(dirname(undeclared), { recursive: true });
    await writeFile(undeclared, 'not approved', 'utf8');

    await expect(collectWindowsVoiceResources(root)).rejects.toThrow(/undeclared file/u);
  });

  it('ships a pinned runtime-only setup with file-hashed model receipts', async () => {
    const setup = await readFile(resolve('services', 'setup-qwen-tts.ps1'), 'utf8');

    expect(setup).toContain('[switch]$IncludeCastingModel');
    expect(setup).toContain('runtimeManifestSha256');
    expect(setup).toContain('"sha256": digest.hexdigest()');
    expect(setup).toContain('Qwen3-TTS episode runtime is ready');
    expect(setup).toContain('larger VoiceDesign casting model was intentionally not installed');
  });

  it('builds a quoted one-click launcher and rejects unsafe executable names', () => {
    expect(windowsHostVoiceLauncher('youre-all-wrong.exe')).toContain(
      'start "" "%~dp0youre-all-wrong.exe" --install-host-voice',
    );
    expect(() => windowsHostVoiceLauncher('wrong.exe & calc.exe')).toThrow(/unsafe/u);
  });
});
