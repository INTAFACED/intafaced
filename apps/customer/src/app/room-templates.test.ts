// @vitest-environment happy-dom
// The route-to-template registry stays in step with the app's route table (the Volt kit).
import { describe, expect, it, vi } from 'vitest';
import { templates } from '@intafaced/ui/lit';
import { PORTAL_ROOMS } from '../features/pay/portal/routes';
import { rooms } from './navigation';
import { renderPart } from './render-record/harness';
import { PORTAL_TEMPLATES, ROUTE_TEMPLATES, type RoomTemplate } from './room-templates';
import { voltMarks } from './volt-count';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Report-only until stage C of the redesign: a route without a template is listed, not failed. Stage C flips this
 * one switch and then every route must name its template (the plan's "done is computed by a registry test").
 */
const EVERY_ROUTE_NEEDS_A_TEMPLATE = false;

const routes = rooms.filter((r) => !r.alias).map((r) => r.path);
/** A route's pattern as a person opens it: a `:pair` is a real market. */
const opened = (route: string) => route.replace(':pair', 'BTC-USDT');
const isRoom = (v: RoomTemplate | string): v is RoomTemplate => typeof v === 'object';
/** The screen file whose `// volt-room:` line says the room has moved onto its template (volt-count.ts). */
const marks = voltMarks();

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
    const all = [
      ...Object.entries(ROUTE_TEMPLATES).flatMap(([route, e]) => (isRoom(e) ? [route] : [])),
      ...Object.keys(PORTAL_TEMPLATES).map((page) => `portal:${page}`),
    ];
    const migrated = all.filter((key) => marks.has(key)).length;
    expect(migrated).toBeLessThanOrEqual(all.length);
    console.info(`Rooms on their template: ${migrated} of ${all.length}`);
  });

  it('a migrated room really renders through its template', { timeout: 300_000 }, async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      for (const [room, entry] of Object.entries(ROUTE_TEMPLATES)) {
        const file = marks.get(room)?.[0];
        if (!isRoom(entry) || !file) continue;
        const html = await renderPart({ name: room, route: opened(room) });
        expect(html.startsWith('<!-- never settled -->'), `${room} settles`).toBe(false);
        const drawn = [...html.matchAll(/data-template="([a-z-]+)"/g)].map((m) => m[1]);
        expect(drawn, `${room} (${file}) draws the ${entry.template} template`).toContain(entry.template);
      }
    } finally {
      vi.useRealTimers();
    }
    // A portal page has no route of its own in the room table to open; one marked migrated is drawn here first.
    const portal = Object.keys(PORTAL_TEMPLATES).filter((page) => marks.has(`portal:${page}`));
    expect(portal, 'a migrated merchant portal page: open its /pay address above and check it draws its template').toEqual([]);
  });
});
