// @vitest-environment happy-dom
// Volt is the customer app's default and only look, dark (intafaced issue 9315): the page carries it from its first byte
// with no flag, and the kit's role sheet draws Volt's values under it, light only behind the scheme switch.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { lit, litLight } from '@intafaced/ui/lit';
import { resolvePreviewScheme } from '../shared/preferences';

const here = dirname(fileURLToPath(import.meta.url));
const page = readFileSync(join(here, '../../index.html'), 'utf8');
const roles = readFileSync(join(here, '../../../../packages/ui/src/lit/lit.css'), 'utf8');

/** The declarations of the one block whose selector is exactly `selector`. */
function block(selector: string): Record<string, string> {
  const at = roles.indexOf(`\n${selector} {`);
  expect(at, selector).toBeGreaterThan(-1);
  const body = roles.slice(roles.indexOf('{', at) + 1, roles.indexOf('\n}', at));
  return Object.fromEntries([...body.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim().toLowerCase()]));
}

describe('Volt is the default and only look, dark, with no flag', () => {
  beforeEach(() => localStorage.clear());

  it("the page's root carries the look and nothing that picks another", () => {
    const root = new DOMParser().parseFromString(page, 'text/html').documentElement;
    expect(root.getAttribute('data-look')).toBe('lit');
    for (const attribute of ['data-direction', 'data-accent', 'data-theme']) expect(root.hasAttribute(attribute), attribute).toBe(false);
    expect(page).toContain('<meta name="theme-color" content="#0A0A09" />');
  });

  it("the look's block on the root is Volt's dark: its page, ink and chartreuse spark", () => {
    const dark = block(":root:where([data-look='lit'])");
    expect(dark['--lit-page']).toBe('#0a0a09');
    expect(dark['--lit-text-1']).toBe('#f3f2ec');
    expect(dark['--lit-accent']).toBe('#e0f83a');
    expect(dark['--lit-font-ui']).toMatch(/^'archivo variable'/);
    expect(lit.page).toBe('#0A0A09');
  });

  it('light is drawn only under the scheme switch, and the switch is off unless asked for', () => {
    expect(block(":root:where([data-look='lit'][data-theme='light'])")['--lit-page']).toBe(litLight.page?.toLowerCase());
    expect(resolvePreviewScheme('')).toBe('dark');
    expect(resolvePreviewScheme('?look=off&direction=x')).toBe('dark');
    expect(resolvePreviewScheme('?scheme=light')).toBe('light');
    expect(resolvePreviewScheme('?scheme=dark')).toBe('dark');
  });
});
