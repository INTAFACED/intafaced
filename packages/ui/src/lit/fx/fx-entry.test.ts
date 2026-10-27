import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { seededRandom } from './random.js';

const here = new URL('./', import.meta.url);
/** Files the page loads before first paint. three.js may only arrive through the lazy `import('./engine.js')`. */
const eager = ['index.ts', 'tier.ts', 'random.ts', 'LitFx.tsx', 'posters/presets.ts', 'sphere-layout.ts'];

describe('light objects entry', () => {
  it('never imports three.js before first paint', () => {
    for (const file of eager) {
      const source = readFileSync(new URL(file, here), 'utf8');
      expect(source, file).not.toMatch(/^\s*import\s+(?!type\b)[^;]*from\s+'three(\/[^']*)?'/m);
      expect(source, file).not.toMatch(/^\s*import\s+(?!type\b)[^;]*from\s+'\.\/(engine|bloom|objects\/[^']+)\.js'/m);
    }
  });

  it('keeps every object behind the lazy import', () => {
    const objects = readdirSync(new URL('objects/', here)).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    expect(objects).toEqual(expect.arrayContaining(['sphere.ts', 'field.ts', 'logo.ts', 'coin.ts']));
  });
});

describe('seededRandom', () => {
  it('repeats for the same seed, so a frame and its poster agree', () => {
    const a = seededRandom(7);
    const b = seededRandom(7);
    const xs = Array.from({ length: 100 }, () => a());
    expect(xs).toEqual(Array.from({ length: 100 }, () => b()));
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
    expect(seededRandom(8)()).not.toBe(xs[0]);
  });
});
