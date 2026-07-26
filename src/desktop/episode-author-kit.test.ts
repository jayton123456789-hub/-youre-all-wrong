import { createHash } from 'node:crypto';

import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { validateShowpack } from '../domain/showpack/validate.js';
import {
  buildEpisodeAuthorKitArchive,
  buildEpisodeAuthorKitFiles,
  EPISODE_AUTHOR_KIT_FILENAME,
} from './episode-author-kit.js';

describe('episode author kit', () => {
  it('contains AI instructions, schema, validated examples, and the voice/display contract', () => {
    const files = buildEpisodeAuthorKitFiles();

    expect(EPISODE_AUTHOR_KIT_FILENAME).toMatch(/\.zip$/u);
    expect(Object.keys(files)).toEqual(
      expect.arrayContaining([
        '00-START-HERE.md',
        '01-COPY-PASTE-PROMPT.txt',
        '02-AI-MASTER-INSTRUCTIONS.md',
        '04-VOICE-TIMING-AND-PRONUNCIATION.md',
        '08-2011-TONE-AND-PACING-STUDY.md',
        'schema/showpack-v1.schema.json',
        'templates/starter-episode.json',
        'examples/complete-episode.json',
        'KIT-MANIFEST.json',
      ]),
    );
    expect(files['01-COPY-PASTE-PROMPT.txt']).toContain('return only one downloadable');
    expect(files['04-VOICE-TIMING-AND-PRONUNCIATION.md']).toContain(
      '"spokenText": "And now, Minecraft: The Heavy Update."',
    );
    expect(files['08-2011-TONE-AND-PACING-STUDY.md']).toContain('BloodCo.');
    expect(files['08-2011-TONE-AND-PACING-STUDY.md']).toContain('Magic_Pudding');
    expect(files['08-2011-TONE-AND-PACING-STUDY.md']).toContain('Buoyant_Baby_Water_Cribs');
    expect(files['08-2011-TONE-AND-PACING-STUDY.md']).toContain('Do not copy or closely');

    for (const path of ['templates/starter-episode.json', 'examples/complete-episode.json']) {
      const validation = validateShowpack(JSON.parse(files[path]!) as unknown);
      expect(validation.ok, path).toBe(true);
    }
  });

  it('builds a readable ZIP whose manifest authenticates every documented file', () => {
    const archive = buildEpisodeAuthorKitArchive();
    const files = unzipSync(archive);
    const manifest = JSON.parse(strFromU8(files['KIT-MANIFEST.json']!)) as {
      files: Array<{ path: string; bytes: number; sha256: string }>;
    };

    expect(archive.byteLength).toBeGreaterThan(10_000);
    expect(Object.keys(files)).toHaveLength(manifest.files.length + 1);
    for (const entry of manifest.files) {
      const bytes = files[entry.path];
      expect(bytes, entry.path).toBeDefined();
      expect(bytes!.byteLength, entry.path).toBe(entry.bytes);
      expect(createHash('sha256').update(bytes!).digest('hex'), entry.path).toBe(entry.sha256);
    }
  });
});
