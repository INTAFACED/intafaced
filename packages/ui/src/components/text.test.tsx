import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { typeRoles, type TypeRole } from '../lit/contracts.js';
import { Text } from './text.js';

const html = (el: React.ReactElement) => renderToStaticMarkup(el);

describe('Text', () => {
  it('draws every kit type role from its own role tokens', () => {
    for (const role of Object.keys(typeRoles) as TypeRole[]) {
      const out = html(<Text variant={role}>Sample</Text>);
      expect(out).toContain(`data-type-role="${role}"`);
      for (const part of ['size', 'line', 'weight', 'tracking']) expect(out).toContain(`var(--lit-type-${role}-${part})`);
    }
  });
  it('takes the figure face for figures and the mono face, in capitals, for micro', () => {
    expect(html(<Text variant="figure">$1.00</Text>)).toContain('var(--lit-font-figure)');
    const micro = html(<Text variant="micro">Code</Text>);
    expect(micro).toContain('var(--lit-font-mono)');
    expect(micro).toContain('uppercase');
    expect(html(<Text variant="body">Words</Text>)).not.toContain('font-family');
  });
  it('draws the element asked for, a paragraph by default', () => {
    expect(html(<Text variant="body">x</Text>)).toMatch(/^<p /);
    expect(
      html(
        <Text variant="heading" as="h2">
          x
        </Text>,
      ),
    ).toMatch(/^<h2 /);
  });
});
