/**
 * Route × viewport matrix — single source of coverage truth for Stream A uiproof.
 * Spec: FRONTEND-OPERATING-PLAN-2026-07-30.md (removed) §2.6
 */
export const TIER_A_VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
];

export const TIER_B_VIEWPORTS = [
  { name: 'phone-small', width: 320, height: 720 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'tablet-wide', width: 1024, height: 768 },
];

/** Backwards-compatible name: Tier A remains every route at the two core sizes. */
export const VIEWPORTS = TIER_A_VIEWPORTS;

import { MEMBER_ROUTE_AUTHORITY } from './route-authority.mjs';

/**
 * Generated from the living Vue router. Adding a route to routes.js therefore
 * adds two Tier-A proof cells automatically; dynamic/wildcard routes use the
 * explicit safe fixtures in route-authority.mjs.
 *
 * @typedef {{ sourcePath: string, path: string, id: string, note: string, expectLoginRedirect: boolean, redirect: string|null }} RouteCase
 * @type {RouteCase[]}
 */
export const ROUTES = MEMBER_ROUTE_AUTHORITY;

/**
 * Tier B samples each materially different layout family rather than repeating
 * the same shell chrome across an unhelpful 89 × 5 Cartesian product.
 */
export const LAYOUT_FAMILIES = [
  { name: 'marketing', path: '/' },
  { name: 'auth', path: '/login' },
  { name: 'exchange-desk', path: '/exchange/btc_usdt' },
  { name: 'platform-os', path: '/platform' },
  { name: 'bank', path: '/bank/business' },
  { name: 'pay', path: '/pay/checkout' },
  { name: 'p2p', path: '/p2p' },
  { name: 'member-money', path: '/uc/money' },
  { name: 'otc-desk', path: '/otc/trade/usdt' },
  { name: 'content-detail', path: '/announcement/uiproof' },
  { name: 'not-found', path: '/uiproof-not-found' },
];

const routesByPath = new Map(ROUTES.map((route) => [route.path, route]));
export const TIER_B_ROUTES = LAYOUT_FAMILIES.map((family) => {
  const route = routesByPath.get(family.path);
  if (!route) throw new Error(`Tier B layout family ${family.name} has no route for ${family.path}`);
  return { ...route, layoutFamily: family.name };
});

export const PROOF_CASES = [
  ...ROUTES.flatMap((route) => TIER_A_VIEWPORTS.map((viewport) => ({ route, viewport, tier: 'A' }))),
  ...TIER_B_ROUTES.flatMap((route) => TIER_B_VIEWPORTS.map((viewport) => ({ route, viewport, tier: 'B' }))),
];

/** Network path prefixes whose failures are allowlisted when backends are down. */
export const NETWORK_ALLOW_PREFIXES = ['/uc', '/market', '/exchange', '/otc', '/api'];

/**
 * Forbidden brand strings (runtime DOM). Mirrors tooling/ci/brand-scan.mjs intent.
 * Patterns are assembled so this file does not itself contain the banned literals
 * (static brand-scan would otherwise fail the gate that lists the names).
 */
function ban(...parts) {
  return new RegExp(parts.join(''), 'i');
}
export const FORBIDDEN_DOM = [
  ban('gmas', 'ter'),
  ban('finc', 'ept'),
  ban('settl', 'etx'),
  ban('payk', 'wik'),
  ban('\\banth', 'ropic\\b'),
  ban('\\bcla', 'ude\\b'),
  ban('\\bope', 'nai\\b'),
  ban('gpt-', '\\d'),
  ban('biz', 'zan'),
  ban('bit', 'rade'),
  ban('coin', 'exchange'),
];

export function shotName(routeId, viewportName) {
  return `${routeId}__${viewportName}.png`;
}
