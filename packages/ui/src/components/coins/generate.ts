/**
 * Builds coin-art.generated.ts from manifest.json and the SVG files, so the
 * logos ship inside the package (no asset pipeline, no hot-linking).
 * Run from packages/ui: `pnpm exec tsx src/components/coins/generate.ts`
 * coin-art.test.ts fails if the generated file drifts from the SVGs.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

type Manifest = { assets: Record<string, { file: string | null }> };

export function renderCoinArt(dir: string): string {
  const manifest = JSON.parse(readFileSync(`${dir}/manifest.json`, 'utf8')) as Manifest;
  const entries = Object.entries(manifest.assets)
    .filter(([, a]) => a.file)
    .map(([asset, a]) => `  ${asset}: ${JSON.stringify(readFileSync(`${dir}/${a.file}`, 'utf8').trim())},`);
  return `/**
 * GENERATED from manifest.json and the SVG files next to it. Do not edit.
 * Third-party artwork (MIT, see manifest.json); the marks are their projects' trademarks.
 */
// prettier-ignore
export const coinArt: Readonly<Record<string, string>> = {
${entries.join('\n')}
};
`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dir = fileURLToPath(new URL('.', import.meta.url)).replace(/\/$/, '');
  writeFileSync(`${dir}/coin-art.generated.ts`, renderCoinArt(dir));
  console.log('wrote coin-art.generated.ts');
}
