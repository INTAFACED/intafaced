// @vitest-environment happy-dom
// The route-to-template registry stays in step with the app's route table (the Volt kit).
import { describe, expect, it, vi } from 'vitest';
import { templates } from '@intafaced/ui/lit';
import { PORTAL_ROOMS, parsePortalRoute } from '../features/pay/portal/routes';
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
/**
 * A route's pattern as a person opens it: a `:pair` is a real market, a `:runId` a run's id (an agent run's page opens only
 * on one), an `:id` a help topic address (lower-case letters, digits and dashes). A parameter the router checks the shape of
 * gets a well-formed TEST value (a campaign id starts `cmp_`; a More record id starts with a letter or digit, more-room-routes.ts).
 */
const SAMPLE_PARAMS: Readonly<Record<string, string>> = {
  ':pair': 'BTC-USDT',
  ':asset': 'BTC',
  ':runId': '00000000-0000-4000-8000-000000000001',
  ':id': 'test-1',
  ':campaignId': 'cmp_TEST',
  ':listingId': 'TEST-listing',
  ':projectId': 'TEST-launch',
  ':poolId': `0x${'9'.repeat(40)}`,
};
/**
 * A parameter whose shape differs between the routes that share its name: a wallet holding's `:token` is a token's address
 * (the router answers anything else not found), where a pay claim's or a shared backtest's `:token` is a link token.
 */
const SAMPLE_ROUTE_PARAMS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  '/wallet/tokens/:token': { ':token': `0x${'7'.repeat(40)}` },
};
const opened = (route: string) =>
  route.replace(/:[A-Za-z]+/g, (param) => SAMPLE_ROUTE_PARAMS[route]?.[param] ?? SAMPLE_PARAMS[param] ?? param);
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
    // A portal page has no route of its own in the room table to open: one marked as moved is drawn above through a /pay
    // address that opens it, marked in the same file and on the same template.
    for (const [page, entry] of Object.entries(PORTAL_TEMPLATES)) {
      const file = marks.get(`portal:${page}`)?.[0];
      if (!file) continue;
      const addresses = Object.entries(ROUTE_TEMPLATES).filter(
        ([path, row]) => isRoom(row) && parsePortalRoute(path)?.room === page && marks.get(path)?.[0] === file,
      );
      expect(
        addresses.map(([, row]) => (row as RoomTemplate).template),
        `the moved merchant portal page ${page} (${file}): a /pay address that opens it is marked in the same file, so it is drawn above`,
      ).toContain(entry.template);
    }
  });
});
