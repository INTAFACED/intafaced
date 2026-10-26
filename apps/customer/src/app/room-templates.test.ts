// The route-to-template registry stays in step with the app's route table (Lit glass redesign).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { templates } from '@intafaced/ui/lit';
import { PORTAL_ROOMS } from '../features/pay/portal/routes';
import { rooms } from './navigation';
import { PORTAL_TEMPLATES, ROUTE_TEMPLATES, type RoomTemplate } from './room-templates';

/**
 * Report-only until stage C of the redesign: a route without a template is listed, not failed. Stage C flips this
 * one switch and then every route must name its template (the plan's "done is computed by a registry test").
 */
const EVERY_ROUTE_NEEDS_A_TEMPLATE = false;

const routes = rooms.filter((r) => !r.alias).map((r) => r.path);
const src = fileURLToPath(new URL('..', import.meta.url));
const isRoom = (v: RoomTemplate | string): v is RoomTemplate => typeof v === 'object';

describe('room templates registry', () => {
  it('names only routes that exist, and no alias', () => {
    const known = new Set(routes);
    expect(Object.keys(ROUTE_TEMPLATES).filter((p) => !known.has(p))).toEqual([]);
  });

  it('uses only the eight template ids', () => {
    const ids = new Set(Object.keys(templates));
    const used = [...Object.values(ROUTE_TEMPLATES).filter(isRoom), ...Object.values(PORTAL_TEMPLATES)].map((e) => e.template);
    expect(used.filter((t) => !ids.has(t))).toEqual([]);
  });

  it('covers every merchant portal page', () => {
    expect(Object.keys(PORTAL_TEMPLATES).sort()).toEqual([...PORTAL_ROOMS].sort());
  });

  it('every route names its template (report-only until stage C)', () => {
    const missing = routes.filter((p) => !(p in ROUTE_TEMPLATES));
    if (EVERY_ROUTE_NEEDS_A_TEMPLATE) expect(missing).toEqual([]);
    else if (missing.length > 0) console.warn(`Routes with no template yet (report-only): ${missing.join(', ')}`);
  });

  it('reports how many rooms are on their template', () => {
    const all = [...Object.values(ROUTE_TEMPLATES).filter(isRoom), ...Object.values(PORTAL_TEMPLATES)];
    const migrated = all.filter((e) => e.migrated).length;
    expect(migrated).toBeLessThanOrEqual(all.length);
    console.info(`Rooms on their template: ${migrated} of ${all.length}`);
  });

  it('a migrated room really renders through a template', () => {
    const all = [...Object.entries(ROUTE_TEMPLATES), ...Object.entries(PORTAL_TEMPLATES)];
    for (const [room, entry] of all) {
      if (!isRoom(entry) || !entry.migrated) continue;
      const file = join(src, entry.migrated.file);
      expect(existsSync(file), `${room}: ${entry.migrated.file}`).toBe(true);
      expect(readFileSync(file, 'utf8'), room).toContain('@intafaced/ui/lit/templates');
    }
  });
});
