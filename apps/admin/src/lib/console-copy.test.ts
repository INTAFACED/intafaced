import { describe, expect, it } from 'vitest';
import { consoleCopy } from './console-copy';

/**
 * Missing keys must not invent English. The catalog is the only source of
 * operator copy; an unknown key renders itself so the miss is greppable.
 */
describe('consoleCopy — catalog keys, never invented English', () => {
  it('resolves a known admin.console key from @intafaced/i18n', () => {
    expect(consoleCopy('admin.console.banner.chip.none')).toBe('Cannot halt anything');
  });

  it('renders the key name when the key is not in the catalog', () => {
    const missing = 'admin.console.this.key.does.not.exist';
    const rendered = consoleCopy(missing);

    expect(rendered).toBe(missing);
    expect(rendered).not.toMatch(/cannot halt|unconfigured|please set|control plane/i);
  });
});

describe('Admin-local transport copy preserves the shared fallback', () => {
  it.each([
    ['en', 'Module writes unavailable'],
    ['es', 'Cambios de módulos no disponibles'],
    ['fr', 'Modification des modules indisponible'],
  ] as const)('has distinct%s action refusal', (locale, expected) => {
    expect(consoleCopy('admin.console.transport.title', {}, locale)).toBe(expected);
    expect(consoleCopy('admin.console.transport.credential.fact', {}, locale)).not.toContain('can freeze');
    expect(consoleCopy('admin.console.nonexistent', {}, locale)).toBe('admin.console.nonexistent');
  });
});
