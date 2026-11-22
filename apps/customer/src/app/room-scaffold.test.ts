// The room scaffold creates rooms only on a template, and keeps the registry honest.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { templates } from '@intafaced/ui/lit';
// @ts-expect-error: a plain .mjs script with no type declarations
import { markedFile, registryWith, screenSource, templateIds } from '../../scripts/new-room.mjs';

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

  it('records the move in the screen file itself, never in the shared registry', () => {
    const src: string = screenSource({ name: 'A', template: 'flow', title: 'A', path: '/a' });
    expect(src.split('\n')[0]).toBe('// volt-room: /a');
  });

  it('names the template in place, and adds a new route inside ROUTE_TEMPLATES', () => {
    const before = "export const ROUTE_TEMPLATES = {\n  '/a': { template: 'reading' },\n};\n\nexport const PORTAL_TEMPLATES = {\n};\n";
    expect(registryWith(before, '/a', 'flow')).toBe(before.replace("'reading'", "'flow'"));
    expect(registryWith(before, '/b', 'reading')).toContain("'/b': { template: 'reading' },\n};\n\nexport const PORTAL_TEMPLATES");
  });

  it('finds the screen file that already carries a route', () => {
    const dir = mkdtempSync(join(tmpdir(), 'room-scaffold-'));
    mkdirSync(join(dir, 'features', 'x'), { recursive: true });
    writeFileSync(join(dir, 'features', 'x', 'ARoom.tsx'), '// volt-room: /a\nexport const A = 1;\n');
    expect(markedFile('/a', dir)).toBe(join('features', 'x', 'ARoom.tsx'));
    expect(markedFile('/b', dir)).toBeUndefined();
  });
});
