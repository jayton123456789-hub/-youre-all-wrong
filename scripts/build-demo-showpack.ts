import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { strToU8, zipSync } from 'fflate';

import { demoPack } from '../src/content/demo-pack.js';
import { importShowpackArchive } from '../src/domain/showpack/archive.js';
import { validateShowpack } from '../src/domain/showpack/validate.js';

const validation = validateShowpack(demoPack);
if (!validation.ok) {
  throw new Error(`Demo episode is invalid:\n${JSON.stringify(validation.issues, null, 2)}`);
}

const archive = zipSync(
  {
    'manifest.json': strToU8(`${JSON.stringify(validation.pack.manifest, null, 2)}\n`),
    'episode/script.json': strToU8(`${JSON.stringify(validation.pack.episode, null, 2)}\n`),
  },
  { level: 6 },
);

const roundTrip = await importShowpackArchive(archive);
if (!roundTrip.ok) {
  throw new Error(
    `Packed demo failed round-trip import:\n${JSON.stringify(roundTrip.issues, null, 2)}`,
  );
}

const outputDirectory = resolve(process.cwd(), 'dist/showpacks');
const outputPath = resolve(outputDirectory, 'terms-and-conditions.showpack');
await mkdir(outputDirectory, { recursive: true });
await writeFile(outputPath, archive);

console.log(`Built ${outputPath}`);
console.log(`Archive SHA-256: ${roundTrip.archiveHash}`);
console.log(`Episode SHA-256: ${roundTrip.packHash}`);
