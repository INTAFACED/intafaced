import 'server-only';
import { routeChangeSchema, routeDeskSchema, type RouteDesk } from '@intafaced/contracts/agents-routes';
import { founderCall, parseWith, type FounderCallContext } from '@/lib/desk/founder-call';
import { refusalOf } from '@/lib/agents-log/server';
import { handlesFor } from '@/lib/agents-fleet/server';
import type { RoutesAction } from './model';

/**
 * The routing table desk's hops (J-agents-20), always as the signed-in founder through svc-edge: svc-agents reads the
 * table and holds every rule of a change (two distinct founders, one pending change per task, applied once with its
 * audit row); identity names the founders by handle. Nothing is cached or kept here.
 */

const parseDesk = parseWith(routeDeskSchema);
const parseChange = parseWith(routeChangeSchema);

export type RoutesAnswer =
  { readonly kind: 'ok'; readonly data: unknown } | { readonly kind: 'refused'; readonly code: string; readonly status: number };

/** The founders a desk read names: who asked for a change, who confirmed it, and who wrote each audit row. */
function deskIds(desk: RouteDesk): unknown[] {
  const ids: unknown[] = [];
  for (const route of desk.routes)
    for (const change of [route.pending, route.lastChange]) if (change) ids.push(change.proposedBy, change.confirmedBy);
  for (const row of desk.audit) ids.push(row.operatorId, row.proposedBy);
  return ids;
}

export async function runRoutes(ctx: FounderCallContext, action: RoutesAction): Promise<RoutesAnswer> {
  switch (action.action) {
    case 'desk': {
      const result = await founderCall(ctx, 'agents', 'routes.desk', 'GET', {}, parseDesk);
      if (result.kind !== 'ok') return refusalOf(result);
      const { handles, unread } = await handlesFor(ctx, deskIds(result.data));
      return { kind: 'ok', data: { ...result.data, handles, handlesUnread: unread, me: ctx.session.userId.toLowerCase() } };
    }
    case 'propose': {
      const { action: _, ...input } = action;
      const result = await founderCall(ctx, 'agents', 'routes.propose', 'POST', input, parseChange);
      return result.kind === 'ok' ? { kind: 'ok', data: result.data } : refusalOf(result);
    }
    case 'withdraw':
    case 'confirm': {
      const result = await founderCall(ctx, 'agents', `routes.${action.action}`, 'POST', { changeId: action.changeId }, parseChange);
      return result.kind === 'ok' ? { kind: 'ok', data: result.data } : refusalOf(result);
    }
  }
}
