import { readdirSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

const here = new URL('./', import.meta.url);
/** Files the page loads before first paint. three.js may only arrive through the lazy `import('./engine.js')`. */
const eager = ['index.ts', 'tier.ts', 'random.ts', 'LitFx.tsx', 'posters/presets.ts', 'sphere-layout.ts'];
/** The modules that carry three.js: the engine, the bloom pass and every object. */
const lazyModules = () => [
  './engine.js',
  './bloom.js',
  ...readdirSync(new URL('objects/', here))
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => `./objects/${f.replace(/\.ts$/, '.js')}`),
];

describe('light objects entry', () => {
  it('never imports three.js before first paint', async () => {
    // Loading three.js core stamps `window.__THREE__`; any route to it (three, its addons, the engine, an object) does.
    const loaded: string[] = [];
    const realWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const page: { __THREE__?: string } = {};
    Object.defineProperty(globalThis, 'window', { value: page, configurable: true, writable: true });
    vi.resetModules();
    for (const id of ['three', ...lazyModules()])
      vi.doMock(id, async (original) => {
        loaded.push(id);
        return original();
      });
    try {
      for (const file of eager) {
        await import(/* @vite-ignore */ new URL(file.replace(/\.tsx?$/, '.js'), here).href);
        expect(loaded, `${file} loads three.js before first paint`).toEqual([]);
        expect(page.__THREE__, `${file} loads three.js before first paint`).toBeUndefined();
      }
    } finally {
      for (const id of ['three', ...lazyModules()]) vi.doUnmock(id);
      if (realWindow) Object.defineProperty(globalThis, 'window', realWindow);
      else delete (globalThis as { window?: unknown }).window;
    }
  });

  it('keeps every object behind the lazy import', () => {
    const objects = readdirSync(new URL('objects/', here)).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    expect(objects).toEqual(expect.arrayContaining(['sphere.ts', 'field.ts', 'logo.ts', 'coin.ts']));
  });
});

describe('seededRandom', () => {
  it('repeats for the same seed, so a frame and its poster agree', async () => {
    // Imported here, not at the top: a static import would load the eager files before the three.js check above runs.
    const { seededRandom } = await import('./random.js');
    const a = seededRandom(7);
    const b = seededRandom(7);
    const xs = Array.from({ length: 100 }, () => a());
    expect(xs).toEqual(Array.from({ length: 100 }, () => b()));
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
    expect(seededRandom(8)()).not.toBe(xs[0]);
  });
});
