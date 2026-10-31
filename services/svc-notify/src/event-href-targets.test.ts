/**
 * Unit card — every href svc-notify emits is a pinned IA target
 *
 * 1. Promise: each `href:` template in an emitter source is in the list below,
 *    copied from the customer route table / IA-SPEC rows. An emitter with a new
 *    target fails here until the list (and the app's fallback table) learns it.
 * 2. Break: `/p2p/trades/:id` style drift — a target no room answers to.
 * 3. Done bar: the five retargeted emitters point at live rooms; the four detail
 *    rows owned by other modules stay as IA-SPEC names them.
 * 4. Class N
 * 5. Paths: services/svc-notify/src/events.ts, market-halt-notice.ts, alerts/service.ts
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));

/** Rooms that exist on main (`apps/customer/src/app/navigation.ts`). */
const LIVE_ROOMS = [
  '/support',
  '/p2p/orders/:id',
  '/uc/ad',
  '/verification',
  '/uc/account',
  '/uc/safe',
  '/token',
  '/trade/futures',
  '/money/activity?tab=transfers',
  '/bank/transfers',
  '/uc/recharge',
  '/uc/recharge?asset=:id&network=:id',
  // Copy trading's My follows, where a skipped or stopped follow is (J-copy-bots-otc-03 #6).
  '/trade/copy?tab=follows',
  // A person's own agent, whose Limits page holds the monthly alert (J-agents-02 #6).
  '/agents/:id',
];

/** Detail rows IA-SPEC 2.3, 2.4, 2.6 and 2.9 give to bank, cex-spot, pay and agents. The app falls back to the nearest list room until they exist. */
const IA_SPEC_DETAIL_ROWS = ['/bank/loans/:id', '/trade/orders/:id', '/pay/request/:id', '/agents/sessions/:id'];

/** Emitted before this slice and not retargeted by it; the app maps them through its fallback table. */
const UNCHANGED_EMITTERS = ['/trade/:id', '/markets/:id'];

const PINNED = new Set([...LIVE_ROOMS, ...IA_SPEC_DETAIL_ROWS, ...UNCHANGED_EMITTERS]);

const SOURCES = ['events.ts', 'market-halt-notice.ts', 'alerts/service.ts'];

function emittedHrefs(file: string): string[] {
  const source = readFileSync(join(here, file), 'utf8');
  const out: string[] = [];
  for (const match of source.matchAll(/\bhref:\s*(`[^`]*`|'[^']*')/g)) {
    const raw = match[1]!.slice(1, -1);
    out.push(raw.replace(/\$\{[^}]*\}/g, ':id'));
  }
  return out;
}

describe('emitted href targets', () => {
  for (const file of SOURCES) {
    it(`${file} emits only pinned targets`, () => {
      const hrefs = emittedHrefs(file);
      expect(hrefs.length).toBeGreaterThanOrEqual(1);
      if (file === 'events.ts') expect(hrefs.length).toBeGreaterThanOrEqual(15);
      for (const href of hrefs) expect(PINNED.has(href), `${file}: ${href}`).toBe(true);
    });
  }

  it('no emitter still targets a path that is not a room', () => {
    const all = SOURCES.flatMap(emittedHrefs);
    for (const dead of [
      '/p2p/trades/:id',
      '/settings/verification',
      '/profile/rank',
      '/token/stakes/:id',
      '/trade/futures/positions/:id',
    ]) {
      expect(all).not.toContain(dead);
    }
  });

  it('every emitter source is scanned (a new emitter file must be added to SOURCES)', () => {
    const emitting = ['events.ts', 'market-halt-notice.ts', 'alerts/service.ts', 'deposit-credit-notice.ts', 'notify-service.ts'];
    for (const file of emitting) {
      const hasTemplate = /\bhref:\s*[`']\//.test(readFileSync(join(here, file), 'utf8'));
      expect(hasTemplate === SOURCES.includes(file), file).toBe(true);
    }
  });
});
