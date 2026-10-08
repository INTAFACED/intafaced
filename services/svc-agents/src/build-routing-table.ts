import { parseRoutingTable, type RouteDef, type RoutingTable } from './gateway/routing.js';

/**
 * An unset or blank AGENTS_ROUTING_TABLE keeps the fallback routes and drops
 * every price. Placeholder per-million rates are not a price and are not billed.
 * A JSON table is parsed as configured, so a decimal-string price still meters.
 */
export function buildRoutingTable(raw: string | undefined, fallback: RoutingTable): RoutingTable {
  if (raw === undefined || raw.trim() === '') return withoutPrices(fallback);
  return parseRoutingTable(JSON.parse(raw));
}

function withoutPrices(table: RoutingTable): RoutingTable {
  return {
    routes: table.routes.map(withoutPrice),
    ...(table.fallbackTask !== undefined ? { fallbackTask: table.fallbackTask } : {}),
  };
}

function withoutPrice(route: RouteDef): RouteDef {
  if (route.price === undefined) return route;
  return {
    task: route.task,
    providerId: route.providerId,
    model: route.model,
    maxOutputTokens: route.maxOutputTokens,
    capability: route.capability,
  };
}
