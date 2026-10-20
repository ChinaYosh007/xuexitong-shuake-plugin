#!/usr/bin/env node
// Offline build utility. Only font glyph hashes are shipped; no user page or font binary.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { transform } from 'esbuild';
const fontPath = process.argv[2];
if (!fontPath) throw new Error('Pass the installed SourceHanSansCN-Normal.ttf path');
const { code } = await transform(await readFile(new URL('../apps/extension/src/automation/true-type.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'esm' });
const { readTrueType } = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
const bytes = await readFile(fontPath), font = readTrueType(bytes);
const hashes = new Map();
for (const [point, index] of font.mapping) {
  // Encoded substitutions use the CJK repertoire. Avoid ambiguous compatibility aliases.
  if (point < 0x3000 || point > 0x9fff) continue;
  const glyph = font.glyph(index); if (!glyph.length) continue;
  const hash = createHash('sha256').update(glyph).digest('hex').slice(0, 32);
  const value = String.fromCodePoint(point);
  if (!hashes.has(hash)) hashes.set(hash, value);
  else if (hashes.get(hash) !== value) hashes.set(hash, null);
}
const unique = Object.fromEntries([...hashes].filter(([, value]) => value !== null));
const dir = new URL('../apps/extension/src/automation/data/', import.meta.url);
await mkdir(dir, { recursive: true });
await writeFile(new URL('source-han-glyphs.json', dir), JSON.stringify(unique));
await writeFile(new URL('README.md', dir), `# Font decoding reference\n\nSource Han Sans CN Normal, from an installed font. Only unique SHA-256/128 glyph fingerprints and Unicode characters are included, not the font binary. Unknown or ambiguous glyphs require image fallback.\n\nFont SHA-256: ${createHash('sha256').update(bytes).digest('hex')}\n\nSource and license: https://github.com/adobe-fonts/source-han-sans (SIL Open Font License 1.1). Regenerate with scripts/generate-font-reference.mjs and the corresponding font.\n`);
console.log(JSON.stringify({ referenceCharacters: Object.keys(unique).length, ambiguousHashes: hashes.size - Object.keys(unique).length }));
