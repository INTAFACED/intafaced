// The room scaffold creates rooms only on a template, and keeps the registry honest.
import { describe, expect, it } from 'vitest';
import { templates } from '@intafaced/ui/lit';
// @ts-expect-error: a plain .mjs script with no type declarations
import { registryWith, screenSource, templateIds } from '../../scripts/new-room.mjs';

describe('room scaffold', () => {
  it('knows exactly the eight templates of the frozen contracts', () => {
    expect([...templateIds()].sort()).toEqual(Object.keys(templates).sort());
  });

  it.each(Object.keys(templates))('a %s room renders its template, parked, with no numbers', (template) => {
    const src: string = screenSource({ name: 'Statements', template, title: 'Statements' });
    expect(src).toContain("from '@intafaced/ui/lit/templates'");
    expect(src).toContain("variant: 'parked'");
    expect(src).not.toMatch(/\d/);
  });

  it('writes a title with quotes or braces as a string, never as code', () => {
    const src: string = screenSource({ name: 'X', template: 'reading', title: 'Bob\'s "{x}"' });
    expect(src).toContain('title={"Bob\'s \\"{x}\\""}');
  });

  it('replaces an unmigrated entry in place and refuses a migrated one', () => {
    const before = "export const ROUTE_TEMPLATES = {\n  '/a': { template: 'flow' },\n};\n";
    const after: string = registryWith(before, '/a', 'flow', 'features/x/ARoom.tsx');
    expect(after).toBe("export const ROUTE_TEMPLATES = {\n  '/a': { template: 'flow', migrated: { file: 'features/x/ARoom.tsx' } },\n};\n");
    expect(() => registryWith(after, '/a', 'flow', 'y')).toThrow(/already on its template/);
  });

  it('registers the new room as migrated, inside ROUTE_TEMPLATES', () => {
    const before = "export const ROUTE_TEMPLATES = {\n  '/a': { template: 'flow' },\n};\n\nexport const PORTAL_TEMPLATES = {\n};\n";
    const after: string = registryWith(before, '/b', 'reading', 'features/x/BRoom.tsx');
    expect(after).toContain(
      "'/b': { template: 'reading', migrated: { file: 'features/x/BRoom.tsx' } },\n};\n\nexport const PORTAL_TEMPLATES",
    );
  });
});
