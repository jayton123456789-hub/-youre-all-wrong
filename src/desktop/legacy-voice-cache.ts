import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const CACHE_WAVE_PATTERN = /^([a-f0-9]{64})\.wav$/u;
const MAX_RECEIPT_BYTES = 4_096;
const MAX_WAVE_BYTES = 32 * 1024 * 1024;

interface LegacyVoiceCacheReceipt {
  schemaVersion: 1;
  cacheKey: string;
  waveSha256: string;
  durationMs: number;
}

export interface LegacyVoiceCacheMigrationResult {
  discovered: number;
  imported: number;
  skipped: number;
}

function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'EEXIST';
}

async function regularFileWithinLimit(path: string, maximumBytes: number): Promise<boolean> {
  try {
    const details = await lstat(path);
    return (
      details.isFile() &&
      !details.isSymbolicLink() &&
      details.size > 0 &&
      details.size <= maximumBytes
    );
  } catch {
    return false;
  }
}

async function verifiedLegacyPair(
  directory: string,
  waveName: string,
  cacheKey: string,
): Promise<boolean> {
  const wavePath = join(directory, waveName);
  const receiptPath = `${wavePath}.json`;
  if (
    !(await regularFileWithinLimit(wavePath, MAX_WAVE_BYTES)) ||
    !(await regularFileWithinLimit(receiptPath, MAX_RECEIPT_BYTES))
  ) {
    return false;
  }

  try {
    const [wave, source] = await Promise.all([readFile(wavePath), readFile(receiptPath, 'utf8')]);
    const receipt = JSON.parse(source) as Partial<LegacyVoiceCacheReceipt>;
    return (
      wave.length >= 46 &&
      wave.toString('ascii', 0, 4) === 'RIFF' &&
      wave.toString('ascii', 8, 12) === 'WAVE' &&
      receipt.schemaVersion === 1 &&
      receipt.cacheKey === cacheKey &&
      typeof receipt.durationMs === 'number' &&
      receipt.durationMs > 0 &&
      receipt.waveSha256 === createHash('sha256').update(wave).digest('hex')
    );
  } catch {
    return false;
  }
}

async function copyExclusive(source: string, destination: string): Promise<void> {
  try {
    await copyFile(source, destination, constants.COPYFILE_EXCL);
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  }
}

export async function migrateVerifiedLegacyVoiceCache(
  legacyCacheDirectory: string,
  destinationCacheDirectory: string,
): Promise<LegacyVoiceCacheMigrationResult> {
  const source = resolve(legacyCacheDirectory);
  const destination = resolve(destinationCacheDirectory);
  const result: LegacyVoiceCacheMigrationResult = { discovered: 0, imported: 0, skipped: 0 };
  if (source.toLocaleLowerCase('en-US') === destination.toLocaleLowerCase('en-US')) return result;

  try {
    const details = await lstat(source);
    if (!details.isDirectory() || details.isSymbolicLink()) return result;
  } catch {
    return result;
  }

  const entries = await readdir(source, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink())
    .map((entry) => ({ entry, match: CACHE_WAVE_PATTERN.exec(entry.name) }))
    .filter(
      (candidate): candidate is typeof candidate & { match: RegExpExecArray } =>
        candidate.match !== null,
    )
    .slice(0, 10_000);
  result.discovered = candidates.length;
  if (candidates.length === 0) return result;

  await mkdir(destination, { recursive: true });
  for (const { entry, match } of candidates) {
    const cacheKey = match[1]!;
    if (!(await verifiedLegacyPair(source, entry.name, cacheKey))) {
      result.skipped += 1;
      continue;
    }
    await copyExclusive(join(source, entry.name), join(destination, entry.name));
    await copyExclusive(
      join(source, `${entry.name}.json`),
      join(destination, `${entry.name}.json`),
    );
    result.imported += 1;
  }
  return result;
}
