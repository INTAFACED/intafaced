import { existsSync, readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FX_PRESETS } from './presets.js';

describe('light object posters', () => {
  it('has a committed poster for every preset', () => {
    for (const name of Object.keys(FX_PRESETS)) {
      const file = new URL(`./${name}.jpg`, import.meta.url);
      expect(existsSync(file), `${name}.jpg is missing: run pnpm --filter @intafaced/ui fx:posters`).toBe(true);
      // a poster is a small image, never a stray full-resolution capture
      expect(statSync(file).size).toBeLessThan(120_000);
    }
  });

  it('has posters rendered from the presets as they are now', () => {
    for (const [name, preset] of Object.entries(FX_PRESETS)) {
      const file = new URL(`./${name}.json`, import.meta.url);
      expect(existsSync(file), `${name}.json is missing: run pnpm --filter @intafaced/ui fx:posters`).toBe(true);
      const rendered: unknown = JSON.parse(readFileSync(file, 'utf8'));
      expect(rendered, `${name}.jpg is older than its preset: run pnpm --filter @intafaced/ui fx:posters`).toEqual(
        JSON.parse(JSON.stringify(preset)),
      );
    }
  });
});
