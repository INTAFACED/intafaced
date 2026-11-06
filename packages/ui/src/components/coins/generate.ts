/**
 * Builds coin-art.generated.ts from manifest.json and the SVG files, so the
 * logos ship inside the package (no asset pipeline, no hot-linking), each without
 * its whole-picture clip so it can be drawn inline with no id.
 * Run from packages/ui: `pnpm exec tsx src/components/coins/generate.ts`
 * coin-art.test.ts fails if the generated file drifts from the SVGs.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

type Manifest = { assets: Record<string, { file: string | null }> };

/**
 * The art without its whole-picture clip: each file wraps its paths in a clip path the size of its 24 by 24 viewBox,
 * which clips nothing (CoinIcon's round frame clips already). Drawn inline, an id would repeat once per icon on a page,
 * so art keeps no id at all; anything else carrying one stops generation.
 */
export function withoutFullClip(svg: string, file: string): string {
  const m = svg.match(
    /^(<svg [^>]*viewBox="0 0 24 24"[^>]*>)\s*<g clip-path="url\(#([^)"']+)\)">([\s\S]*)<\/g>\s*<defs>\s*<clipPath id="\2">\s*<rect width="24" height="24" fill="white"\/>\s*<\/clipPath>\s*<\/defs>\s*<\/svg>$/,
  );
  const out = m ? `${m[1]}\n${m[3]!.trim()}\n</svg>` : svg;
  if (/\sid\s*=|url\(|href\s*=/i.test(out)) throw new Error(`${file}: art may hold no id, url() or href once inline`);
  return out;
}

export function renderCoinArt(dir: string): string {
  const manifest = JSON.parse(readFileSync(`${dir}/manifest.json`, 'utf8')) as Manifest;
  const entries = Object.entries(manifest.assets)
    .filter(([, a]) => a.file)
    .map(([asset, a]) => `  ${asset}: ${JSON.stringify(withoutFullClip(readFileSync(`${dir}/${a.file}`, 'utf8').trim(), a.file!))},`);
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
