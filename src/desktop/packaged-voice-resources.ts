import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { z } from 'zod';

import trustedManifestInput from './packaged-voice-resources.json';

export const PACKAGED_QWEN_RESOURCE_NAMES = [
  'qwen-voice-worker.py',
  'setup-qwen-tts.ps1',
  'qwen-runtime-manifest.json',
] as const;

export type PackagedQwenResourceName = (typeof PACKAGED_QWEN_RESOURCE_NAMES)[number];

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const TrustedVoiceResourceManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    resources: z
      .object({
        'qwen-voice-worker.py': z.string().regex(SHA256_PATTERN),
        'setup-qwen-tts.ps1': z.string().regex(SHA256_PATTERN),
        'qwen-runtime-manifest.json': z.string().regex(SHA256_PATTERN),
      })
      .strict(),
    bundledHostProfile: z
      .object({
        voiceId: z.string().trim().min(1).max(100),
        profileSha256: z.string().regex(SHA256_PATTERN),
        referenceSha256: z.string().regex(SHA256_PATTERN),
        files: z
          .object({
            'README.md': z.string().regex(SHA256_PATTERN),
            'approval.json': z.string().regex(SHA256_PATTERN),
            'profile.json': z.string().regex(SHA256_PATTERN),
            'provenance.json': z.string().regex(SHA256_PATTERN),
            'reference.wav': z.string().regex(SHA256_PATTERN),
          })
          .strict(),
      })
      .strict()
      .nullable(),
  })
  .strict();

export const TRUSTED_VOICE_RESOURCE_MANIFEST =
  TrustedVoiceResourceManifestSchema.parse(trustedManifestInput);

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function isPackagedResourceName(value: string): value is PackagedQwenResourceName {
  return PACKAGED_QWEN_RESOURCE_NAMES.some((name) => name === value);
}

export async function verifyPackagedVoiceResource(
  path: string,
  expectedName?: PackagedQwenResourceName,
): Promise<void> {
  const name = expectedName ?? basename(path);
  if (!isPackagedResourceName(name)) {
    throw new Error(`"${name}" is not a trusted packaged neural-host resource.`);
  }
  if (basename(path) !== name) {
    throw new Error(`Expected packaged resource "${name}", received "${basename(path)}".`);
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    throw new Error(
      `The packaged neural-host resource "${name}" could not be read: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const actual = sha256(bytes);
  const expected = TRUSTED_VOICE_RESOURCE_MANIFEST.resources[name];
  if (actual !== expected) {
    throw new Error(
      `The packaged neural-host resource "${name}" failed its trusted SHA-256 check.`,
    );
  }
}

export async function verifyPackagedHostVoiceProfile(
  profilePath: string,
  voiceId: string,
  referenceSha256: string,
): Promise<void> {
  const trusted = TRUSTED_VOICE_RESOURCE_MANIFEST.bundledHostProfile;
  if (!trusted) {
    throw new Error('This application does not trust a bundled neural-host profile.');
  }
  if (voiceId !== trusted.voiceId || referenceSha256 !== trusted.referenceSha256) {
    throw new Error('The bundled neural-host identity does not match the trusted release.');
  }
  const root = dirname(profilePath);
  const entries = await readdir(root, { withFileTypes: true });
  const fileNames = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  const expectedNames = Object.keys(trusted.files);
  if (
    entries.some((entry) => !entry.isFile()) ||
    fileNames.length !== expectedNames.length ||
    expectedNames.some((name) => !fileNames.includes(name))
  ) {
    throw new Error('The packaged host-voice directory does not match the trusted release.');
  }
  for (const name of expectedNames) {
    const expected = trusted.files[name as keyof typeof trusted.files];
    const actual = sha256(await readFile(join(root, name)));
    if (actual !== expected) {
      throw new Error(`The packaged host-voice file "${name}" failed its trusted hash.`);
    }
  }
}
