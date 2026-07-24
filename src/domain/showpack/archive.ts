import { createHash } from 'node:crypto';

import { Unzip, UnzipInflate } from 'fflate';

import type { Showpack } from './schema.js';
import { type ValidationIssue, validateShowpack } from './validate.js';

const MAX_ARCHIVE_BYTES = 250 * 1024 * 1024;
const MAX_TOTAL_UNCOMPRESSED_BYTES = 800 * 1024 * 1024;
const MAX_SINGLE_FILE_BYTES = 200 * 1024 * 1024;
const MAX_ENTRY_COUNT = 1_100;
const MAX_COMPRESSION_RATIO = 200;
const MAX_JSON_BYTES = 8 * 1024 * 1024;

export type ArchiveImportResult =
  | {
      ok: true;
      pack: Showpack;
      archiveHash: string;
      packHash: string;
      files: ReadonlyMap<string, Uint8Array>;
    }
  | {
      ok: false;
      issues: ValidationIssue[];
    };

function safeArchivePath(input: string): string | null {
  if (
    input.length === 0 ||
    input.length > 240 ||
    input.includes('\0') ||
    input.includes('\\') ||
    input.startsWith('/') ||
    /^[a-zA-Z]:/.test(input)
  ) {
    return null;
  }
  const segments = input.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return null;
  }
  return segments.join('/');
}

function parseJson(bytes: Uint8Array, path: string): unknown {
  if (bytes.byteLength > MAX_JSON_BYTES) {
    throw new Error(`${path} exceeds the JSON size limit.`);
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return JSON.parse(text) as unknown;
}

function extractArchive(archive: Uint8Array): Promise<Map<string, Uint8Array>> {
  return new Promise((resolve, reject) => {
    if (archive.byteLength > MAX_ARCHIVE_BYTES) {
      reject(new Error('Archive exceeds the compressed size limit.'));
      return;
    }

    const files = new Map<string, Uint8Array>();
    const caseFolded = new Set<string>();
    let entryCount = 0;
    let declaredTotal = 0;
    let completed = 0;
    let feedComplete = false;
    let settled = false;

    const finishIfReady = () => {
      if (!settled && feedComplete && completed === entryCount) {
        settled = true;
        resolve(files);
      }
    };

    const fail = (error: unknown) => {
      if (!settled) {
        settled = true;
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };

    try {
      const unzip = new Unzip((file) => {
        entryCount += 1;
        if (entryCount > MAX_ENTRY_COUNT) {
          fail(new Error('Archive contains too many entries.'));
          file.terminate();
          return;
        }

        const path = safeArchivePath(file.name);
        if (!path || path.endsWith('/')) {
          fail(new Error(`Unsafe or unsupported archive path: "${file.name}".`));
          file.terminate();
          return;
        }

        const folded = path.toLocaleLowerCase('en-US');
        if (caseFolded.has(folded)) {
          fail(new Error(`Duplicate or case-colliding archive path: "${path}".`));
          file.terminate();
          return;
        }
        caseFolded.add(folded);

        if (
          file.originalSize !== undefined &&
          (file.originalSize > MAX_SINGLE_FILE_BYTES ||
            declaredTotal + file.originalSize > MAX_TOTAL_UNCOMPRESSED_BYTES)
        ) {
          fail(new Error(`Archive entry "${path}" exceeds extraction limits.`));
          file.terminate();
          return;
        }

        if (
          file.originalSize !== undefined &&
          file.size !== undefined &&
          file.size > 0 &&
          file.originalSize / file.size > MAX_COMPRESSION_RATIO
        ) {
          fail(new Error(`Archive entry "${path}" has a suspicious compression ratio.`));
          file.terminate();
          return;
        }

        declaredTotal += file.originalSize ?? 0;
        const chunks: Uint8Array[] = [];
        let received = 0;

        file.ondata = (error, data, final) => {
          if (error) {
            fail(error);
            return;
          }
          received += data.byteLength;
          if (received > MAX_SINGLE_FILE_BYTES) {
            file.terminate();
            fail(new Error(`Archive entry "${path}" exceeded its extraction limit.`));
            return;
          }
          chunks.push(data);
          if (final) {
            const merged = new Uint8Array(received);
            let offset = 0;
            for (const chunk of chunks) {
              merged.set(chunk, offset);
              offset += chunk.byteLength;
            }
            files.set(path, merged);
            completed += 1;
            finishIfReady();
          }
        };
        file.start();
      });

      unzip.register(UnzipInflate);
      unzip.push(archive, true);
      feedComplete = true;
      finishIfReady();
    } catch (error) {
      fail(error);
    }
  });
}

export async function importShowpackArchive(archive: Uint8Array): Promise<ArchiveImportResult> {
  try {
    const files = await extractArchive(archive);
    const manifestBytes = files.get('manifest.json');
    const episodeBytes = files.get('episode/script.json');
    if (!manifestBytes || !episodeBytes) {
      return {
        ok: false,
        issues: [
          {
            path: '/',
            code: 'missing_required_file',
            message: 'A showpack must contain manifest.json and episode/script.json.',
          },
        ],
      };
    }

    const rawPack = {
      manifest: parseJson(manifestBytes, 'manifest.json'),
      episode: parseJson(episodeBytes, 'episode/script.json'),
    };
    const validation = validateShowpack(rawPack);
    if (!validation.ok) return validation;

    const allowed = new Set([
      'manifest.json',
      'episode/script.json',
      ...validation.pack.manifest.assets.map((asset) => asset.path),
    ]);
    const issues: ValidationIssue[] = [];

    for (const path of files.keys()) {
      if (!allowed.has(path)) {
        issues.push({
          path: `/${path}`,
          code: 'undeclared_file',
          message: `Archive contains undeclared file "${path}".`,
        });
      }
    }

    for (const asset of validation.pack.manifest.assets) {
      const bytes = files.get(asset.path);
      if (!bytes) {
        issues.push({
          path: `/manifest/assets/${asset.id}`,
          code: 'missing_asset',
          message: `Declared asset "${asset.path}" is missing.`,
        });
        continue;
      }
      if (bytes.byteLength !== asset.bytes) {
        issues.push({
          path: `/manifest/assets/${asset.id}/bytes`,
          code: 'asset_size_mismatch',
          message: `Asset "${asset.path}" does not match its declared byte length.`,
        });
      }
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (digest !== asset.sha256) {
        issues.push({
          path: `/manifest/assets/${asset.id}/sha256`,
          code: 'asset_hash_mismatch',
          message: `Asset "${asset.path}" failed its SHA-256 integrity check.`,
        });
      }
    }

    if (issues.length > 0) return { ok: false, issues };

    return {
      ok: true,
      pack: validation.pack,
      packHash: validation.packHash,
      archiveHash: createHash('sha256').update(archive).digest('hex'),
      files,
    };
  } catch (error) {
    return {
      ok: false,
      issues: [
        {
          path: '/',
          code: 'invalid_archive',
          message: error instanceof Error ? error.message : 'Archive extraction failed.',
        },
      ],
    };
  }
}
