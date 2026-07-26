import { createHash, randomUUID } from 'node:crypto';
import {
  access,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  unlink,
} from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';

import { demoPack } from '../content/demo-pack.js';
import { canonicalJson } from '../domain/canonical.js';
import { importShowpackArchive } from '../domain/showpack/archive.js';
import type { Showpack } from '../domain/showpack/schema.js';
import { type ValidationIssue, validateShowpack } from '../domain/showpack/validate.js';
import type { DesktopEpisodeState, DesktopEpisodeSummary } from './episode-contract.js';

const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 250 * 1024 * 1024;
export const ACTIVE_SHOWPACK_FILE = 'active-showpack.json';
export const SHOWPACK_LIBRARY_DIRECTORY = 'showpack-library';
const COMPLETE_MARKER_FILE = 'complete.json';
const CANONICAL_ARCHIVE_SCRIPT_FILE = 'canonical-showpack.json';
const ORIGINAL_ARCHIVE_FILE = 'episode.showpack';
const EXTRACTED_DIRECTORY = 'extracted';
const PACK_HASH_PATTERN = /^[a-f0-9]{64}$/;

interface ImportedEpisodeArchive {
  bytes: Uint8Array;
  archiveHash: string;
  packHash: string;
  files: ReadonlyMap<string, Uint8Array>;
}

export type EpisodeImportResult =
  | {
      ok: true;
      pack: Showpack;
      packHash: string;
      archive: ImportedEpisodeArchive | null;
    }
  | {
      ok: false;
      issues: ValidationIssue[];
    };

function invalidFile(message: string, code = 'invalid_episode_file'): EpisodeImportResult {
  return {
    ok: false,
    issues: [{ path: '/', code, message }],
  };
}

function validateJson(text: string): EpisodeImportResult {
  try {
    const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    const validation = validateShowpack(JSON.parse(withoutBom) as unknown);
    if (!validation.ok) return validation;
    return {
      ok: true,
      pack: validation.pack,
      packHash: validation.packHash,
      archive: null,
    };
  } catch (error) {
    return invalidFile(
      error instanceof Error ? `Episode JSON could not be read: ${error.message}` : 'Invalid JSON.',
      'invalid_json',
    );
  }
}

export async function importEpisodeFile(filePath: string): Promise<EpisodeImportResult> {
  try {
    const extension = extname(filePath).toLocaleLowerCase('en-US');
    if (extension !== '.json' && extension !== '.showpack') {
      return invalidFile('Choose a .json episode document or a .showpack archive.');
    }

    const source = await stat(filePath);
    if (!source.isFile()) return invalidFile('The selected episode source is not a file.');

    const limit = extension === '.json' ? MAX_JSON_BYTES : MAX_ARCHIVE_BYTES;
    if (source.size > limit) {
      return invalidFile(
        extension === '.json'
          ? 'Episode JSON exceeds the 8 MB safety limit.'
          : 'Showpack archive exceeds the 250 MB safety limit.',
        'episode_too_large',
      );
    }

    const bytes = await readFile(filePath);
    if (extension === '.json') {
      const imported = validateJson(bytes.toString('utf8'));
      if (imported.ok && imported.pack.manifest.assets.length > 0) {
        return invalidFile(
          'Raw episode JSON cannot carry declared media assets. Package the script and assets as a .showpack archive.',
          'raw_json_missing_assets',
        );
      }
      return imported;
    }

    const imported = await importShowpackArchive(bytes);
    if (!imported.ok) return imported;
    return {
      ok: true,
      pack: imported.pack,
      packHash: imported.packHash,
      archive: {
        bytes,
        archiveHash: imported.archiveHash,
        packHash: imported.packHash,
        files: imported.files,
      },
    };
  } catch (error) {
    return invalidFile(
      error instanceof Error ? error.message : 'The selected episode could not be opened.',
    );
  }
}

export function summarizeEpisode(
  pack: Showpack,
  source: DesktopEpisodeSummary['source'],
): DesktopEpisodeSummary {
  return {
    id: pack.episode.id,
    title: pack.episode.title,
    author: pack.manifest.author,
    source,
  };
}

export function activeShowpackPath(userDataDirectory: string): string {
  return join(userDataDirectory, ACTIVE_SHOWPACK_FILE);
}

export function showpackLibraryPath(userDataDirectory: string): string {
  return join(userDataDirectory, SHOWPACK_LIBRARY_DIRECTORY);
}

function versionDirectory(userDataDirectory: string, packHash: string): string {
  if (!PACK_HASH_PATTERN.test(packHash)) throw new Error('Invalid episode content hash.');
  return join(showpackLibraryPath(userDataDirectory), packHash);
}

function safeArchiveRelativePath(path: string): boolean {
  if (
    path.length === 0 ||
    path.length > 240 ||
    path.includes('\0') ||
    path.includes('\\') ||
    path.startsWith('/') ||
    /^[a-zA-Z]:/.test(path)
  ) {
    return false;
  }
  return path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function managedChild(root: string, archivePath: string): string {
  if (!safeArchiveRelativePath(archivePath)) {
    throw new Error(`Unsafe persisted archive path: "${archivePath}".`);
  }
  const absoluteRoot = resolve(root);
  const target = resolve(absoluteRoot, ...archivePath.split('/'));
  const fromRoot = relative(absoluteRoot, target);
  if (fromRoot === '' || fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
    throw new Error(`Archive path escaped the episode media directory: "${archivePath}".`);
  }
  return target;
}

async function durableWriteNew(path: string, contents: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, 'wx');
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function atomicWrite(path: string, contents: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${extname(path) || 'file'}.${randomUUID()}.next`);
  try {
    await durableWriteNew(temporary, contents);
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function digestBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function digestFile(path: string): Promise<string> {
  const handle = await open(path, 'r');
  const digest = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      digest.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return digest.digest('hex');
}

interface CompleteArchiveMarker {
  version: 1;
  packHash: string;
  archiveHash: string;
  archiveBytes: number;
  assets: Array<{
    id: string;
    path: string;
    bytes: number;
    sha256: string;
  }>;
}

function markerFor(
  pack: Showpack,
  packHash: string,
  archive: ImportedEpisodeArchive,
): CompleteArchiveMarker {
  return {
    version: 1,
    packHash,
    archiveHash: archive.archiveHash,
    archiveBytes: archive.bytes.byteLength,
    assets: pack.manifest.assets.map((asset) => ({
      id: asset.id,
      path: asset.path,
      bytes: asset.bytes,
      sha256: asset.sha256,
    })),
  };
}

function parseMarker(input: unknown): CompleteArchiveMarker | null {
  if (!input || typeof input !== 'object') return null;
  const record = input as Partial<CompleteArchiveMarker>;
  if (
    record.version !== 1 ||
    typeof record.packHash !== 'string' ||
    !PACK_HASH_PATTERN.test(record.packHash) ||
    typeof record.archiveHash !== 'string' ||
    !PACK_HASH_PATTERN.test(record.archiveHash) ||
    typeof record.archiveBytes !== 'number' ||
    !Number.isSafeInteger(record.archiveBytes) ||
    record.archiveBytes < 1 ||
    record.archiveBytes > MAX_ARCHIVE_BYTES ||
    !Array.isArray(record.assets)
  ) {
    return null;
  }
  for (const candidate of record.assets) {
    if (
      !candidate ||
      typeof candidate !== 'object' ||
      typeof candidate.id !== 'string' ||
      typeof candidate.path !== 'string' ||
      !safeArchiveRelativePath(candidate.path) ||
      typeof candidate.bytes !== 'number' ||
      !Number.isSafeInteger(candidate.bytes) ||
      candidate.bytes < 1 ||
      typeof candidate.sha256 !== 'string' ||
      !PACK_HASH_PATTERN.test(candidate.sha256)
    ) {
      return null;
    }
  }
  return record as CompleteArchiveMarker;
}

export interface PersistedEpisodeMedia {
  packPath: string;
  assetRoot: string | null;
  archivePath: string | null;
}

async function verifyPersistedArchive(
  userDataDirectory: string,
  pack: Showpack,
  packHash: string,
): Promise<PersistedEpisodeMedia | null> {
  const root = versionDirectory(userDataDirectory, packHash);
  try {
    const libraryDetails = await lstat(showpackLibraryPath(userDataDirectory));
    const rootDetails = await lstat(root);
    if (
      !libraryDetails.isDirectory() ||
      libraryDetails.isSymbolicLink() ||
      !rootDetails.isDirectory() ||
      rootDetails.isSymbolicLink()
    ) {
      return null;
    }
    const marker = parseMarker(
      JSON.parse(await readFile(join(root, COMPLETE_MARKER_FILE), 'utf8')) as unknown,
    );
    if (!marker || marker.packHash !== packHash) return null;

    const expectedAssets = new Map(pack.manifest.assets.map((asset) => [asset.id, asset]));
    if (marker.assets.length !== expectedAssets.size) return null;
    const seenAssetIds = new Set<string>();
    const extractedRoot = join(root, EXTRACTED_DIRECTORY);
    const extractedDetails = await lstat(extractedRoot);
    if (!extractedDetails.isDirectory() || extractedDetails.isSymbolicLink()) return null;
    const resolvedExtractedRoot = await realpath(extractedRoot);
    for (const entry of marker.assets) {
      if (seenAssetIds.has(entry.id)) return null;
      seenAssetIds.add(entry.id);
      const declared = expectedAssets.get(entry.id);
      if (
        !declared ||
        entry.path !== declared.path ||
        entry.bytes !== declared.bytes ||
        entry.sha256 !== declared.sha256
      ) {
        return null;
      }
      const storedPath = managedChild(extractedRoot, declared.path);
      const details = await lstat(storedPath);
      if (!details.isFile() || details.isSymbolicLink() || details.size !== declared.bytes) {
        return null;
      }
      const resolvedStoredPath = await realpath(storedPath);
      const fromExtractedRoot = relative(resolvedExtractedRoot, resolvedStoredPath);
      if (
        fromExtractedRoot === '' ||
        fromExtractedRoot.startsWith('..') ||
        isAbsolute(fromExtractedRoot)
      ) {
        return null;
      }
      if ((await digestFile(resolvedStoredPath)) !== declared.sha256) return null;
    }

    const archivePath = join(root, ORIGINAL_ARCHIVE_FILE);
    const archiveDetails = await lstat(archivePath);
    if (
      !archiveDetails.isFile() ||
      archiveDetails.isSymbolicLink() ||
      archiveDetails.size !== marker.archiveBytes
    ) {
      return null;
    }
    if ((await digestFile(archivePath)) !== marker.archiveHash) return null;
    const restoredArchive = await importShowpackArchive(await readFile(archivePath));
    if (
      !restoredArchive.ok ||
      restoredArchive.packHash !== packHash ||
      restoredArchive.archiveHash !== marker.archiveHash
    ) {
      return null;
    }

    const canonicalPath = join(root, CANONICAL_ARCHIVE_SCRIPT_FILE);
    const canonicalDetails = await lstat(canonicalPath);
    if (!canonicalDetails.isFile() || canonicalDetails.isSymbolicLink()) return null;
    const storedCanonical = validateJson(await readFile(canonicalPath, 'utf8'));
    if (!storedCanonical.ok || storedCanonical.packHash !== packHash) return null;

    return {
      packPath: activeShowpackPath(userDataDirectory),
      assetRoot: join(root, EXTRACTED_DIRECTORY),
      archivePath,
    };
  } catch {
    return null;
  }
}

async function writeArchiveVersion(
  userDataDirectory: string,
  pack: Showpack,
  packHash: string,
  archive: ImportedEpisodeArchive,
): Promise<PersistedEpisodeMedia> {
  if (digestBytes(archive.bytes) !== archive.archiveHash) {
    throw new Error('The validated archive changed before it could be persisted.');
  }
  if (archive.packHash !== packHash) {
    throw new Error('The validated archive does not belong to the active episode script.');
  }
  const library = showpackLibraryPath(userDataDirectory);
  await mkdir(library, { recursive: true });
  const libraryDetails = await lstat(library);
  if (!libraryDetails.isDirectory() || libraryDetails.isSymbolicLink()) {
    throw new Error('Refusing to persist media through an unsafe episode library path.');
  }
  const staging = join(library, `.stage-${randomUUID()}`);
  const final = versionDirectory(userDataDirectory, packHash);
  await mkdir(join(staging, EXTRACTED_DIRECTORY), { recursive: true });

  try {
    for (const [archivePath, bytes] of archive.files) {
      const destination = managedChild(join(staging, EXTRACTED_DIRECTORY), archivePath);
      await durableWriteNew(destination, bytes);
    }
    await durableWriteNew(join(staging, ORIGINAL_ARCHIVE_FILE), archive.bytes);
    await durableWriteNew(join(staging, CANONICAL_ARCHIVE_SCRIPT_FILE), `${canonicalJson(pack)}\n`);
    await durableWriteNew(
      join(staging, COMPLETE_MARKER_FILE),
      `${canonicalJson(markerFor(pack, packHash, archive))}\n`,
    );

    for (const asset of pack.manifest.assets) {
      const path = managedChild(join(staging, EXTRACTED_DIRECTORY), asset.path);
      const details = await lstat(path);
      if (
        !details.isFile() ||
        details.isSymbolicLink() ||
        details.size !== asset.bytes ||
        (await digestFile(path)) !== asset.sha256
      ) {
        throw new Error('A persisted showpack asset failed its post-write integrity check.');
      }
    }

    const existing = await verifyPersistedArchive(userDataDirectory, pack, packHash);
    if (existing) {
      await rm(staging, { recursive: true, force: true });
      return existing;
    }

    let stale: string | null = null;
    try {
      await access(final);
      stale = join(library, `.stale-${randomUUID()}`);
      await rename(final, stale);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    try {
      await rename(staging, final);
    } catch (error) {
      if (stale) await rename(stale, final).catch(() => undefined);
      throw error;
    }
    if (stale) await rm(stale, { recursive: true, force: true }).catch(() => undefined);
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }

  const persisted = await verifyPersistedArchive(userDataDirectory, pack, packHash);
  if (!persisted) throw new Error('The persisted showpack archive failed final verification.');
  return persisted;
}

async function cleanupPackLibrary(
  userDataDirectory: string,
  keepPackHash: string | null,
): Promise<void> {
  const library = resolve(showpackLibraryPath(userDataDirectory));
  const expected = resolve(userDataDirectory, SHOWPACK_LIBRARY_DIRECTORY);
  if (library !== expected)
    throw new Error('Refusing to clean an unexpected episode library path.');

  let entries;
  try {
    const details = await lstat(library);
    if (!details.isDirectory() || details.isSymbolicLink()) {
      throw new Error('Refusing to clean an unsafe episode library path.');
    }
    entries = await readdir(library, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    const managedVersion =
      PACK_HASH_PATTERN.test(entry.name) ||
      entry.name.startsWith('.stage-') ||
      entry.name.startsWith('.stale-');
    if (!managedVersion || (entry.name === keepPackHash && entry.isDirectory())) continue;
    await rm(join(library, entry.name), { recursive: true, force: true });
  }
}

export async function persistActiveEpisode(
  userDataDirectory: string,
  pack: Showpack,
  archive: ImportedEpisodeArchive | null = null,
): Promise<PersistedEpisodeMedia> {
  await mkdir(userDataDirectory, { recursive: true });
  const destination = activeShowpackPath(userDataDirectory);
  const validation = validateShowpack(pack);
  if (!validation.ok) {
    throw new Error(
      `Refusing to persist an invalid episode: ${formatValidationIssues(validation.issues)}`,
    );
  }
  if (archive === null && pack.manifest.assets.length > 0) {
    throw new Error(
      'An episode with declared assets must be imported from a complete .showpack archive.',
    );
  }

  const media = archive
    ? await writeArchiveVersion(userDataDirectory, validation.pack, validation.packHash, archive)
    : {
        packPath: destination,
        assetRoot: null,
        archivePath: null,
      };
  await atomicWrite(destination, `${canonicalJson(validation.pack)}\n`);
  await cleanupPackLibrary(userDataDirectory, archive ? validation.packHash : null).catch(
    () => undefined,
  );
  return media;
}

export async function clearActiveEpisode(userDataDirectory: string): Promise<void> {
  await unlink(activeShowpackPath(userDataDirectory)).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  });
  const library = resolve(showpackLibraryPath(userDataDirectory));
  if (library !== resolve(userDataDirectory, SHOWPACK_LIBRARY_DIRECTORY)) {
    throw new Error('Refusing to remove an unexpected episode library path.');
  }
  try {
    const details = await lstat(library);
    if (details.isSymbolicLink()) {
      await unlink(library);
    } else if (details.isDirectory()) {
      await rm(library, { recursive: true, force: true });
    } else {
      throw new Error('Refusing to remove a non-directory episode library path.');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export interface LoadedEpisode {
  pack: Showpack;
  packHash: string;
  packPath: string | null;
  assetRoot: string | null;
  archivePath: string | null;
  state: DesktopEpisodeState;
}

function bundledDemo(warning: string | null = null): LoadedEpisode {
  const validation = validateShowpack(demoPack);
  if (!validation.ok) {
    throw new Error(`Bundled episode is invalid: ${JSON.stringify(validation.issues)}`);
  }
  return {
    pack: validation.pack,
    packHash: validation.packHash,
    packPath: null,
    assetRoot: null,
    archivePath: null,
    state: {
      episode: summarizeEpisode(validation.pack, 'demo'),
      warning,
    },
  };
}

export async function loadActiveEpisode(userDataDirectory: string): Promise<LoadedEpisode> {
  const filePath = activeShowpackPath(userDataDirectory);
  const fallback = async (warning: string | null = null): Promise<LoadedEpisode> => {
    await cleanupPackLibrary(userDataDirectory, null).catch(() => undefined);
    return bundledDemo(warning);
  };
  try {
    await access(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback();
    return fallback(
      `The saved custom episode could not be opened, so the demo was used. ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  try {
    const details = await stat(filePath);
    const result =
      details.isFile() && details.size <= MAX_JSON_BYTES
        ? validateJson(await readFile(filePath, 'utf8'))
        : invalidFile('The saved active episode document exceeds its safety limits.');
    if (!result.ok) {
      return fallback(
        `The saved custom episode was rejected, so the demo was loaded. ${formatValidationIssues(
          result.issues,
        )}`,
      );
    }
    const media = await verifyPersistedArchive(userDataDirectory, result.pack, result.packHash);
    const versionRoot = versionDirectory(userDataDirectory, result.packHash);
    let versionExists = false;
    try {
      versionExists = (await stat(versionRoot)).isDirectory();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if ((result.pack.manifest.assets.length > 0 || versionExists) && !media) {
      return fallback(
        'The saved custom episode media failed its integrity check, so the demo was loaded.',
      );
    }
    await cleanupPackLibrary(userDataDirectory, media ? result.packHash : null).catch(
      () => undefined,
    );
    return {
      pack: result.pack,
      packHash: result.packHash,
      packPath: filePath,
      assetRoot: media?.assetRoot ?? null,
      archivePath: media?.archivePath ?? null,
      state: {
        episode: summarizeEpisode(result.pack, 'custom'),
        warning: null,
      },
    };
  } catch (error) {
    return fallback(
      `The saved custom episode could not be loaded, so the demo was used. ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export function formatValidationIssues(issues: ValidationIssue[], maximum = 4): string {
  const displayed = issues
    .slice(0, maximum)
    .map((issue) => `${issue.path || '/'}: ${issue.message}`)
    .join(' ');
  const remaining = issues.length - maximum;
  return remaining > 0 ? `${displayed} (+${remaining} more)` : displayed;
}
