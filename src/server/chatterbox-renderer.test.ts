import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createChatterboxRendererConfig } from './chatterbox-renderer.js';

const temporaryDirectories: string[] = [];
const PINNED_MODEL_REVISION = '749d1c1a46eb10492095d68fbcf55691ccf137cd';

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'yaw-chatterbox-renderer-'));
  temporaryDirectories.push(directory);
  return directory;
}

describe('Chatterbox renderer identity', () => {
  it('uses reference file content rather than its path', async () => {
    const directory = await temporaryDirectory();
    const firstPath = join(directory, 'first.wav');
    const secondPath = join(directory, 'second.wav');
    await writeFile(firstPath, 'identical authorized voice bytes');
    await writeFile(secondPath, 'identical authorized voice bytes');

    const first = await createChatterboxRendererConfig({
      model: 'turbo',
      modelRevision: PINNED_MODEL_REVISION,
      voiceName: 'Original Host',
      referencePath: firstPath,
    });
    const second = await createChatterboxRendererConfig({
      model: 'turbo',
      modelRevision: PINNED_MODEL_REVISION,
      voiceName: 'Original Host',
      referencePath: secondPath,
    });

    expect(first.voiceProfileHashSource).toBe(second.voiceProfileHashSource);
    expect(first.voiceProfileHashSource).not.toContain(firstPath);
    expect(first.voiceProfileHashSource).not.toContain(secondPath);
  });

  it('invalidates the identity when bytes change at the same path', async () => {
    const directory = await temporaryDirectory();
    const referencePath = join(directory, 'host.wav');
    await writeFile(referencePath, 'first authorized voice');
    const first = await createChatterboxRendererConfig({
      model: 'turbo',
      modelRevision: PINNED_MODEL_REVISION,
      voiceName: 'Original Host',
      referencePath,
    });

    await writeFile(referencePath, 'revised authorized voice');
    const second = await createChatterboxRendererConfig({
      model: 'turbo',
      modelRevision: PINNED_MODEL_REVISION,
      voiceName: 'Original Host',
      referencePath,
    });

    expect(second.voiceProfileHashSource).not.toBe(first.voiceProfileHashSource);
  });

  it('binds cache and voice identity to an exact model repository revision', async () => {
    const directory = await temporaryDirectory();
    const referencePath = join(directory, 'host.wav');
    await writeFile(referencePath, 'authorized voice');
    const first = await createChatterboxRendererConfig({
      model: 'turbo',
      modelRevision: PINNED_MODEL_REVISION,
      voiceName: 'Original Host',
      referencePath,
    });
    const second = await createChatterboxRendererConfig({
      model: 'turbo',
      modelRevision: '0'.repeat(40),
      voiceName: 'Original Host',
      referencePath,
    });

    expect(first.modelRevision).toContain(PINNED_MODEL_REVISION);
    expect(second.modelRevision).not.toBe(first.modelRevision);
    expect(second.voiceProfileHashSource).not.toBe(first.voiceProfileHashSource);
    await expect(
      createChatterboxRendererConfig({
        model: 'turbo',
        modelRevision: 'main',
        voiceName: 'Original Host',
        referencePath,
      }),
    ).rejects.toThrow(/exact 40-character model repository revision/u);
  });
});
