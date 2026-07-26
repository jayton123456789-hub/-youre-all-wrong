import { createHash } from 'node:crypto';
import { open, lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

import type { Showpack } from '../domain/showpack/schema.js';

export interface RuntimeShowpackAsset {
  id: string;
  kind: 'audio' | 'image' | 'font' | 'video';
  bytes: number;
  sha256: string;
  filePath: string;
}

export interface ShowpackAssetLibrary {
  root: string;
  assets: readonly RuntimeShowpackAsset[];
  fileForId(assetId: string): RuntimeShowpackAsset | null;
}

function containedPath(root: string, relativePath: string): string {
  const target = resolve(root, ...relativePath.split('/'));
  const fromRoot = relative(root, target);
  if (fromRoot === '' || fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
    throw new Error(`Showpack asset path escaped its media root: "${relativePath}".`);
  }
  return target;
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

export async function loadShowpackAssetLibrary(
  pack: Showpack,
  configuredRoot: string | undefined,
): Promise<ShowpackAssetLibrary | null> {
  if (!configuredRoot) {
    if (pack.manifest.assets.length > 0) {
      throw new Error('The active episode declares media but has no persisted asset directory.');
    }
    return null;
  }

  const root = resolve(configuredRoot);
  const rootDetails = await lstat(root);
  if (!rootDetails.isDirectory() || rootDetails.isSymbolicLink()) {
    throw new Error('The showpack media root is not a regular directory.');
  }
  const resolvedRoot = await realpath(root);
  const assets: RuntimeShowpackAsset[] = [];
  const byId = new Map<string, RuntimeShowpackAsset>();

  for (const declared of pack.manifest.assets) {
    const candidate = containedPath(root, declared.path);
    const details = await lstat(candidate);
    if (!details.isFile() || details.isSymbolicLink() || details.size !== declared.bytes) {
      throw new Error(`Showpack asset "${declared.id}" failed its file integrity check.`);
    }
    const resolvedFile = await realpath(candidate);
    const fromRoot = relative(resolvedRoot, resolvedFile);
    if (fromRoot === '' || fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
      throw new Error(`Showpack asset "${declared.id}" escaped its media root.`);
    }
    if ((await digestFile(resolvedFile)) !== declared.sha256) {
      throw new Error(`Showpack asset "${declared.id}" failed its SHA-256 integrity check.`);
    }
    const asset: RuntimeShowpackAsset = {
      id: declared.id,
      kind: declared.kind,
      bytes: declared.bytes,
      sha256: declared.sha256,
      filePath: resolvedFile,
    };
    assets.push(asset);
    byId.set(asset.id, asset);
  }

  return {
    root: resolvedRoot,
    assets,
    fileForId: (assetId) => byId.get(assetId) ?? null,
  };
}
