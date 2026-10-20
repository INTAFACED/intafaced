import { describe, expect, it } from 'vitest';
import { findRoom, rooms } from '../../app/navigation';
import { features } from '../../app/feature-registry';
import { MORE_ROUTES, RESERVED_SEGMENTS, matchMoreRoute } from './more-room-routes';
import { moreRoomRoutesCopy } from './more-room-routes-copy';

describe('More room-set routes (MC-order-01)', () => {
  it('opens every section and record of the six rooms through one table', () => {
    for (const route of MORE_ROUTES) {
      const path = route.pattern.replace(/:\w+/g, 'abc-1');
      expect(matchMoreRoute(path)?.route, path).toBe(route);
    }
  });

  it('has a navigation row and a registry path for every pattern, hidden from search, never from customers', () => {
    const registry = features.find((feature) => feature.id === 'more-rooms')!;
    expect(registry.status).toBe('blocked');
    for (const route of MORE_ROUTES) {
      const row = rooms.find((room) => room.path === route.pattern);
      expect(row, route.pattern).toMatchObject({ area: 'more', door: 'More', hidden: true });
      expect(registry.paths, route.pattern).toContain(route.pattern);
      expect(moreRoomRoutesCopy.t(route.title)).not.toBe('');
    }
  });

  it('never takes a section name for an id: /predict/positions is positions, not market "positions"', () => {
    expect(matchMoreRoute('/predict/positions')?.route.kind).toBe('part');
    expect(matchMoreRoute('/market/purchases')?.route.kind).toBe('part');
    expect(matchMoreRoute('/mining/workers')?.route.pattern).toBe('/mining/workers');
    expect(matchMoreRoute('/mining/workers/w-1')).toMatchObject({ route: { pattern: '/mining/workers/:workerId' }, id: 'w-1' });
    // Every reserved segment, under its own room, is either a section or refused as an id.
    for (const [room, segments] of Object.entries(RESERVED_SEGMENTS)) {
      for (const segment of segments) {
        const hit = matchMoreRoute(`/${room}/${segment}`);
        if (hit?.route.kind === 'detail') expect(hit.invalid, `/${room}/${segment}`).toBe(true);
        // The app's own room list answers a section that has a row with that row, not with the room's parameter row.
        const row = rooms.find((candidate) => candidate.path === `/${room}/${segment}`);
        if (row) expect(findRoom(row.path)).toBe(row);
      }
    }
  });

  it('flags a malformed id instead of looking it up', () => {
    for (const bad of ['/market/a%2Fb', '/market/%E0%A4%A', '/market/.hidden', `/market/${'x'.repeat(129)}`, '/predict/%20']) {
      expect(matchMoreRoute(bad), bad).toMatchObject({ invalid: true });
    }
    expect(matchMoreRoute('/market/listing-9')).toMatchObject({ id: 'listing-9' });
    expect(matchMoreRoute('/market/Listing%20')?.invalid).toBe(true);
  });

  it('leaves other paths alone: deeper or unknown paths match nothing, so the "no customer route" panel shows', () => {
    for (const path of [
      '/market/a/b/c',
      '/market',
      '/predict',
      '/mining',
      '/blueprint',
      '/token',
      '/launch',
      '/quant/studio',
      '/academy/x',
    ]) {
      expect(matchMoreRoute(path), path).toBeUndefined();
    }
  });
});
