import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

import { z } from 'zod';

import {
  PACKAGED_QWEN_RESOURCE_NAMES,
  TRUSTED_VOICE_RESOURCE_MANIFEST,
  verifyPackagedVoiceResource,
} from '../src/desktop/packaged-voice-resources.js';
import { inspectDesktopVoiceProfile } from '../src/desktop/voice-profile.js';

export interface CollectWindowsVoiceResourcesOptions {
  requireBundledHostProfile?: boolean;
}

const REJECTED_HOST_REFERENCE_SHA256S = new Set([
  // host-02: rejected by the owner after listening to the complete audition set.
  '75a0a3f07e1526a565d04419e34fff6c2a83fa55d80ce9ca611106849f61d7c5',
]);

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const ProvenanceSchema = z
  .object({
    schemaVersion: z.literal(2),
    status: z.literal('approved-private-alpha'),
    identity: z
      .object({
        voiceId: z.string(),
        sourceType: z.literal('original-synthetic-design'),
        recognizablePersonImitationIntended: z.literal(false),
      })
      .passthrough(),
    reference: z
      .object({
        file: z.literal('reference.wav'),
        durationSeconds: z.number().min(5).max(30),
        sha256: z.string(),
      })
      .passthrough(),
    renderer: z
      .object({
        engine: z.literal('qwen3-tts'),
        packageVersion: z.string(),
        model: z.literal('Qwen/Qwen3-TTS-12Hz-0.6B-Base'),
        modelRevision: z.string().regex(/^[a-f0-9]{40}$/u),
        postprocessing: z.literal('digital-silence-guards-only'),
      })
      .passthrough(),
    approval: z
      .object({
        ownerListeningApproved: z.literal(true),
        approvedAsRendered: z.literal(true),
        pitchOrTempoModificationAllowed: z.literal(false),
      })
      .passthrough(),
  })
  .passthrough();

const VoiceApprovalSchema = z
  .object({
    schemaVersion: z.literal(1),
    status: z.literal('approved'),
    engine: z.literal('qwen3-tts'),
    syntheticOriginal: z.literal(true),
    voiceId: z.string().trim().min(1).max(100),
    voiceName: z.string().trim().min(1).max(100),
    approvedAsRendered: z.literal(true),
    reference: z
      .object({
        file: z.literal('reference.wav'),
        sha256: z.string().regex(/^[a-f0-9]{64}$/u),
        transcript: z.string().trim().min(1),
      })
      .strict(),
  })
  .passthrough();

const QwenRuntimeManifestSchema = z
  .object({
    packages: z.object({ qwenTts: z.string().min(1) }).passthrough(),
    models: z
      .object({
        base: z
          .object({
            repository: z.literal('Qwen/Qwen3-TTS-12Hz-0.6B-Base'),
            revision: z.string().regex(/^[a-f0-9]{40}$/u),
          })
          .passthrough(),
      })
      .passthrough(),
  })
  .passthrough();

async function assertDedicatedHostVoiceDirectory(directory: string): Promise<void> {
  const trusted = TRUSTED_VOICE_RESOURCE_MANIFEST.bundledHostProfile;
  if (!trusted) throw new Error('The trusted bundled host manifest is absent.');
  const seenFiles = new Set<string>();
  const entries = await readdir(directory, { recursive: true });
  for (const entry of entries) {
    const path = resolve(directory, entry);
    const details = await lstat(path);
    if (details.isSymbolicLink()) {
      throw new Error(`Bundled host-voice resources cannot contain symbolic links: "${entry}".`);
    }
    if (details.isFile()) {
      const relativeName = relative(directory, path).split(sep).join('/');
      const expected = trusted.files[relativeName as keyof typeof trusted.files];
      if (!expected) {
        throw new Error(
          `The host-voice package directory contains an undeclared file: "${relativeName}".`,
        );
      }
      if (sha256(await readFile(path)) !== expected) {
        throw new Error(`Bundled host-voice file "${relativeName}" failed its trusted hash.`);
      }
      seenFiles.add(relativeName);
    }
  }
  const expectedFiles = Object.keys(trusted.files);
  if (
    seenFiles.size !== expectedFiles.length ||
    expectedFiles.some((name) => !seenFiles.has(name))
  ) {
    throw new Error('The host-voice package directory is missing a trusted release file.');
  }
}

export async function collectWindowsVoiceResources(
  projectRoot: string,
  options: CollectWindowsVoiceResourcesOptions = {},
): Promise<string[]> {
  const resourcePaths = PACKAGED_QWEN_RESOURCE_NAMES.map((name) =>
    resolve(projectRoot, 'services', name),
  );
  for (let index = 0; index < resourcePaths.length; index += 1) {
    const name = PACKAGED_QWEN_RESOURCE_NAMES[index];
    const path = resourcePaths[index];
    if (!name || !path) throw new Error('The packaged voice resource list is inconsistent.');
    await verifyPackagedVoiceResource(path, name);
  }

  const hostVoiceDirectory = resolve(projectRoot, 'assets', 'voice', 'original-host-v1');
  const profilePath = join(hostVoiceDirectory, 'profile.json');
  const profile = await inspectDesktopVoiceProfile(profilePath, 'bundled');
  if (!profile.found) {
    if (options.requireBundledHostProfile) {
      throw new Error(
        'This release requires an approved bundled host, but assets/voice/original-host-v1/profile.json is absent.',
      );
    }
    return resourcePaths;
  }
  if ('error' in profile) throw new Error(profile.error);

  const trusted = TRUSTED_VOICE_RESOURCE_MANIFEST.bundledHostProfile;
  if (!trusted) {
    throw new Error(
      'A host profile exists, but it has not been approved in packaged-voice-resources.json.',
    );
  }
  const profileHash = sha256(await readFile(profilePath));
  if (
    profile.verified.profile.voiceId !== trusted.voiceId ||
    profileHash !== trusted.profileSha256 ||
    profile.verified.referenceSha256 !== trusted.referenceSha256
  ) {
    throw new Error('The bundled host profile does not match the trusted release manifest.');
  }
  await assertDedicatedHostVoiceDirectory(hostVoiceDirectory);
  if (relative(hostVoiceDirectory, profile.verified.referencePath).startsWith('..')) {
    throw new Error('The bundled host reference escaped its dedicated package directory.');
  }

  const provenance = ProvenanceSchema.parse(
    JSON.parse(await readFile(join(hostVoiceDirectory, 'provenance.json'), 'utf8')) as unknown,
  );
  const approval = VoiceApprovalSchema.parse(
    JSON.parse(await readFile(join(hostVoiceDirectory, 'approval.json'), 'utf8')) as unknown,
  );
  const runtimeManifest = QwenRuntimeManifestSchema.parse(
    JSON.parse(
      await readFile(resolve(projectRoot, 'services', 'qwen-runtime-manifest.json'), 'utf8'),
    ) as unknown,
  );
  if (
    provenance.identity.voiceId !== profile.verified.profile.voiceId ||
    provenance.reference.sha256 !== profile.verified.referenceSha256 ||
    provenance.reference.transcript !== profile.verified.profile.reference.transcript ||
    provenance.renderer.packageVersion !== runtimeManifest.packages.qwenTts ||
    provenance.renderer.model !== runtimeManifest.models.base.repository ||
    provenance.renderer.modelRevision !== runtimeManifest.models.base.revision ||
    approval.voiceId !== profile.verified.profile.voiceId ||
    approval.voiceName !== profile.verified.profile.voiceName ||
    approval.reference.sha256 !== profile.verified.referenceSha256 ||
    approval.reference.transcript !== profile.verified.profile.reference.transcript
  ) {
    throw new Error('The approved host identity, provenance, and runtime pins do not agree.');
  }
  if (REJECTED_HOST_REFERENCE_SHA256S.has(profile.verified.referenceSha256)) {
    throw new Error(
      'The bundled host reference was rejected during owner listening review and is permanently blocked from packaging.',
    );
  }
  return [...resourcePaths, hostVoiceDirectory];
}

export function windowsHostVoiceLauncher(executableName: string): string {
  if (!/^[a-z0-9-]+\.exe$/iu.test(executableName)) {
    throw new Error('The host executable name is unsafe for the Windows launcher.');
  }
  return [
    '@echo off',
    'setlocal',
    `start "" "%~dp0${executableName}" --install-host-voice`,
    'endlocal',
    '',
  ].join('\r\n');
}
