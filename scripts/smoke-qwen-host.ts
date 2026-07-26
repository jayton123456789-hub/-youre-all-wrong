import { createHash } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  createQwenRendererConfig,
  createQwenVoiceWorkerRunner,
  type QwenRendererOptions,
} from '../src/server/qwen-renderer.js';
import type { VoiceWorkerManifest } from '../src/server/voice-preflight.js';

const projectRoot = process.cwd();
const outputDirectory = resolve(
  projectRoot,
  '.yallwrong',
  'voice-smoke',
  `approved-voice-2-${new Date().toISOString().replaceAll(':', '-')}`,
);
await mkdir(outputDirectory, { recursive: true });

function configuredPath(name: string, fallback: string): string {
  return resolve(process.env[name]?.trim() || fallback);
}

const resources: QwenRendererOptions = {
  runtimeManifestPath: configuredPath(
    'YAW_QWEN_RUNTIME_MANIFEST_PATH',
    'services/qwen-runtime-manifest.json',
  ),
  approvalPath: configuredPath(
    'YAW_QWEN_APPROVAL_PATH',
    'assets/voice/original-host-v1/approval.json',
  ),
  baseModelPath: configuredPath('YAW_QWEN_BASE_MODEL_PATH', '.yallwrong/qwen-models/base-0.6b'),
  asrModelPath: configuredPath('YAW_QWEN_ASR_MODEL_PATH', '.yallwrong/qwen-models/asr-small-en'),
};
const pythonPath = configuredPath(
  'YAW_QWEN_PYTHON_PATH',
  '.yallwrong/qwen-tts-venv/Scripts/python.exe',
);
const workerPath = configuredPath('YAW_VOICE_WORKER_PATH', 'services/qwen-voice-worker.py');
const firstOutputPath = resolve(outputDirectory, 'approved-voice-2-smoke-1.wav');
const secondOutputPath = resolve(outputDirectory, 'approved-voice-2-smoke-2.wav');
const manifestPath = resolve(outputDirectory, 'generic-render-manifest.json');
const renderer = await createQwenRendererConfig(resources);
const manifest: VoiceWorkerManifest = {
  protocolVersion: 1,
  voiceName: renderer.voiceName,
  jobs: [
    {
      cueId: 'approved-voice-2-smoke',
      cacheKey: createHash('sha256').update('approved-voice-2-smoke-v1').digest('hex'),
      outputPath: firstOutputPath,
      text: 'Welcome back. Confidence looks nervous.',
      delivery: 'smug',
      pacePermille: 1_000,
      energyPermille: 650,
      pronunciation: {},
    },
    {
      cueId: 'approved-voice-2-smoke-second',
      cacheKey: createHash('sha256').update('approved-voice-2-smoke-v2').digest('hex'),
      outputPath: secondOutputPath,
      text: 'Good evening. Your score needs supervision.',
      delivery: 'dry',
      pacePermille: 1_000,
      energyPermille: 600,
      pronunciation: {},
    },
  ],
};
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
  encoding: 'utf8',
  flag: 'wx',
});

try {
  const runWorker = createQwenVoiceWorkerRunner({ ...resources, pythonPath });
  await runWorker(workerPath, manifestPath, (progress) => {
    if (progress.type !== 'progress') return;
    if (progress.cueId.startsWith('approved-voice-2-smoke')) {
      console.log(`${progress.cueId} passed waveform and offline transcript QA.`);
    }
  });
  console.log(`Approved Voice 2 smoke clips: ${firstOutputPath}, ${secondOutputPath}`);
  console.log('The command did not play audio automatically.');
} finally {
  await unlink(manifestPath).catch(() => undefined);
}
