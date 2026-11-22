// @vitest-environment happy-dom
// The route-to-template registry stays in step with the app's route table (the Volt kit).
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { templates } from '@intafaced/ui/lit';
import { PORTAL_ROOMS, type PortalRoom } from '../features/pay/portal/routes';
import { rooms as portalRooms } from '../features/pay/portal/rooms';
import { MerchantAccessContext, type MerchantAccessValue } from '../features/pay/portal/access/MerchantAccess';
import { allows, type Access } from '../features/pay/portal/access/resolve';
import { ROLE_CAPABILITIES } from '../features/pay/portal/access/capabilities';
import type { PortalApi } from '../features/pay/portal/api';
import { rooms } from './navigation';
import { renderPart } from './render-record/harness';
import { PORTAL_TEMPLATES, ROUTE_TEMPLATES, type RoomTemplate } from './room-templates';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Report-only until stage C of the redesign: a route without a template is listed, not failed. Stage C flips this
 * one switch and then every route must name its template (the plan's "done is computed by a registry test").
 */
const EVERY_ROUTE_NEEDS_A_TEMPLATE = false;

const routes = rooms.filter((r) => !r.alias).map((r) => r.path);
/** A route's pattern as a person opens it: its registry row's `sample` where it names one. */
const opened = (route: string, entry: RoomTemplate) => entry.sample ?? route;
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

  it('a migrated room really renders through its template', { timeout: 300_000 }, async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      for (const [room, entry] of Object.entries(ROUTE_TEMPLATES)) {
        if (!isRoom(entry) || !entry.migrated) continue;
        const html = await renderPart({ name: room, route: opened(room, entry) });
        expect(html.startsWith('<!-- never settled -->'), `${room} settles`).toBe(false);
        const drawn = [...html.matchAll(/data-template="([a-z-]+)"/g)].map((m) => m[1]);
        expect(drawn, `${room} (${entry.migrated.file}) draws the ${entry.template} template`).toContain(entry.template);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('a migrated merchant portal page really renders through its template, for the owner of a ready account', () => {
    // A portal page is drawn by the portal's own room table. The look gate's TEST account reads no business, so its
    // /pay address above stops at the account check; here the owner of a ready TEST account opens it, every read
    // still on its way, and the page must draw its template.
    const access = {
      status: 'ready',
      source: 'my-access',
      merchantId: '11111111-1111-4111-8111-111111111111',
      role: 'owner',
      accountStatus: 'active',
      kybStatus: 'approved',
      mode: 'gateway',
      sessionInteractive: true,
      displayName: null,
      legalName: null,
      pricingVisibility: null,
      capabilities: ROLE_CAPABILITIES.owner,
    } as Access;
    const value: MerchantAccessValue = {
      access,
      merchant: { status: 'loading' },
      team: { status: 'loading' },
      reloadMerchant: () => undefined,
      reload: () => undefined,
      can: (need) => allows(access, need),
      canOwnerWrite: true,
      sessionScopes: null,
      moneyReason: () => null,
    };
    const pending = new Promise<never>(() => undefined);
    const portal = new Proxy({}, { get: () => () => pending }) as PortalApi;
    for (const [room, entry] of Object.entries(PORTAL_TEMPLATES)) {
      if (!entry.migrated) continue;
      const page = portalRooms[room as PortalRoom].render(
        { room: room as PortalRoom },
        { portal, authority: null, access: value, starterFee: null },
      );
      const html = renderToStaticMarkup(createElement(MerchantAccessContext.Provider, { value }, page));
      const drawn = [...html.matchAll(/data-template="([a-z-]+)"/g)].map((m) => m[1]);
      expect(drawn, `portal:${room} (${entry.migrated.file}) draws the ${entry.template} template`).toContain(entry.template);
    }
  });
});
