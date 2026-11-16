import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ROUTING_TABLE,
  routeCount,
  completeRouteCount,
  routingProviderIds,
  routingTableBoardCard,
  parseRoutingTableStatusLine,
  routingTableStatusLineMatches,
  routingTableExportHeader,
  routingTableExportLine,
  routingTableExportText,
  routeCountInRange,
  routingHasTask,
  tasksOf,
} from './routing.js';

describe('L3 wave66 routing table honesty', () => {
  it('default table boards', () => {
    const t = DEFAULT_ROUTING_TABLE;
    expect(routeCount(t)).toBe(t.routes.length);
    expect(completeRouteCount(t)).toBeGreaterThan(0);
    expect(routingProviderIds(t)).toContain('primary');
    expect(routingTableBoardCard(t).routes).toBe(t.routes.length);
    expect(routingTableStatusLineMatches(t)).toBe(true);
    expect(parseRoutingTableStatusLine('nope')).toBeNull();
    expect(routingTableExportText(t).startsWith(routingTableExportHeader())).toBe(true);
    expect(routingTableExportLine(t)).toContain(',');
    expect(routeCountInRange(t, 1, 100)).toBe(true);
    expect(routeCountInRange(t, 100, 1)).toBe(false);
    expect(routingHasTask(t, 'navigator.plan')).toBe(true);
    expect(routingHasTask(t, 'no.such.task')).toBe(false);
    expect(tasksOf(t).length).toBe(t.routes.length);
  });
});
