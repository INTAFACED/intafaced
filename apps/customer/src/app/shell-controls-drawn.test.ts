import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// HM-shell-03 and product law: the shell's controls (bell, Simple/Pro switch, avatar menu) are always drawn for a
// signed-in person. Feature-registry status is proof state, never visibility, so the shell never asks it whether to draw.
describe('the shell draws its controls whatever the feature registry says', () => {
  for (const file of ['TopBar.tsx', 'AccountMenu.tsx', 'Shell.tsx']) {
    it(file, () => {
      const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
      expect(source).not.toMatch(/\bisFeatureLive\b/);
    });
  }
});
