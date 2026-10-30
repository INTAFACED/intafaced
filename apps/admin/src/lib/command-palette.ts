import { SCREENS } from './founder-ops/screens';
import { MODULE_ROUTES, moduleForPage, type ModuleId } from './modules';

/**
 * The command palette (Ctrl or Cmd K, OPS-admin-access-08, admin-access-036): every console page and the actions an operator
 * reaches for, searched by name. It lists only pages this console lets anyone open: an entry whose page belongs to a module
 * that is switched off (`ADMIN_MODULES`) is left out, exactly as the nav and the middleware leave it out. Finer permissions
 * (treasury, compliance) are each page's and service's to check, and a page says in words when it refuses the session.
 *
 * An action here opens the page where the action is done; it never runs a control itself. Every control keeps its own
 * two-founder flow on its page.
 */

export interface PaletteEntry {
  readonly id: string;
  readonly kind: 'page' | 'action';
  readonly label: string;
  /** Where Enter goes. A page path, or for the one browser action, null. */
  readonly href: string | null;
  /** Shown under the label: the area it belongs to, or what the action does. */
  readonly hint: string;
  /** Extra words it is found by. */
  readonly keywords: readonly string[];
}

/** Pages below a module's top page, in nav order. Each must be a real page of this app (checked by the test). */
const SUB_PAGES: readonly { readonly href: string; readonly label: string; readonly keywords?: readonly string[] }[] = [
  { href: '/restore', label: 'Ledger restore proof', keywords: ['backup', 'integrity'] },
  { href: '/merchants/overview', label: 'Merchants: overview' },
  { href: '/merchants/all', label: 'Merchants: all merchants' },
  { href: '/merchants/approvals', label: 'Merchants: approvals', keywords: ['kyb'] },
  { href: '/merchants/live', label: 'Merchants: live' },
  { href: '/merchants/new', label: 'Merchants: new merchant' },
  { href: '/merchants/risk', label: 'Merchants: risk' },
  { href: '/merchants/treasury', label: 'Merchants: treasury and halts', keywords: ['halt'] },
  { href: '/merchants/registries', label: 'Merchants: registries', keywords: ['venues', 'networks', 'wallets'] },
  { href: '/tools/console-mode', label: 'Maintenance mode', keywords: ['read only', 'read-only', 'maintenance', 'console mode'] },
  { href: '/tools/announcements', label: 'Announcements: console banner', keywords: ['banner', 'announcement', 'staff notice'] },
  { href: '/system/settings', label: 'Platform settings', keywords: ['effective', 'configuration', 'blank', 'owner'] },
  { href: '/system/profile', label: 'Profile and preferences', keywords: ['preferences', 'time zone', 'home page', 'theme', 'profile'] },
  { href: '/support/settings', label: 'Support: contact settings' },
  { href: '/support/articles', label: 'Support: write and review help articles' },
  { href: '/compliance/cases', label: 'Compliance cases', keywords: ['aml', 'review', 'case'] },
  { href: '/bank-ops/holds', label: 'Bank: global send holds', keywords: ['held', 'release'] },
  { href: '/more-ops/mining', label: 'Mining desk', keywords: ['pool', 'shares', 'workers'] },
  { href: '/more-ops/predict', label: 'Predict desk', keywords: ['prediction'] },
  { href: '/more-ops/agents/log', label: 'Agent action log', keywords: ['agents', 'refused', 'transcript', 'audit'] },
  { href: '/more-ops/venue-economics', label: 'Venue unit economics', keywords: ['cost'] },
  { href: '/more-ops/campaigns', label: 'Campaigns desk', keywords: ['campaign', 'builder', 'promotion', 'calendar'] },
  { href: '/more-ops/campaigns/waves', label: 'Waitlist waves', keywords: ['waitlist', 'campaigns', 'invite'] },
  { href: '/protocol-ops/listing', label: 'Protocol: pool and market control', keywords: ['delist', 'hide'] },
  { href: '/trade-ops/markets', label: 'Trade: markets', keywords: ['symbol', 'listing'] },
  { href: '/trade-ops/orders', label: 'Trade: orders', keywords: ['order', 'bust'] },
  { href: '/trade-ops/positions', label: 'Trade: positions' },
  { href: '/trade-ops/liquidations', label: 'Trade: liquidations' },
  { href: '/trade-ops/risk-limits', label: 'Trade: risk limits', keywords: ['caps', 'bands'] },
  { href: '/trade-ops/kill-switch', label: 'Trade: kill switch', keywords: ['halt'] },
  { href: '/trade-ops/approvals', label: 'Trade: approvals' },
  { href: '/trade-ops/surveillance', label: 'Trade: surveillance', keywords: ['wash', 'spoofing'] },
  { href: '/trade-ops/audit', label: 'Trade: audit' },
  { href: '/trade-ops/exports', label: 'Trade: exports', keywords: ['csv'] },
  { href: '/identity-ops/keys', label: 'Identity: signing keys', keywords: ['rotate', 'jwt'] },
  { href: '/identity-ops/oauth', label: 'Identity: OAuth apps' },
];

/** Things an operator does, each opening the page where it is done. */
const ACTIONS: readonly {
  readonly id: string;
  readonly label: string;
  readonly href: string;
  readonly hint: string;
  readonly keywords: readonly string[];
}[] = [
  {
    id: 'freeze-ledger',
    label: 'Freeze or unfreeze ledger posting',
    href: '/ledger',
    hint: 'Opens Ledger ops. Two founders; the platform-wide posting freeze in svc-ledger.',
    keywords: ['ledger', 'posting', 'halt', 'stop'],
  },
  {
    id: 'kill-module',
    label: 'Kill or re-enable a module',
    href: '/',
    hint: 'Opens the module board. Two founders; enforced at the edge.',
    keywords: ['halt', 'stop', 'kill switch'],
  },
  {
    id: 'freeze-account',
    label: 'Freeze an account',
    href: '/accounts',
    hint: 'Opens Account controls. One person or business; held in svc-identity.',
    keywords: ['customer', 'lock', 'restrict'],
  },
  {
    id: 'pay-halt',
    label: 'Halt or clear a pay rail',
    href: '/ledger',
    hint: 'Opens Ledger ops. Clearing needs a second founder.',
    keywords: ['ledger', 'pay', 'halt', 'rail'],
  },
  {
    id: 'trace-ledger',
    label: 'Look up a customer balance and its ledger entries',
    href: '/bank-ops#customer-balances',
    hint: 'Opens Bank ops. Needs the treasury permission.',
    keywords: ['ledger', 'balance', 'entries', 'customer'],
  },
  {
    id: 'restore-proof',
    label: 'Prove a ledger restore',
    href: '/restore',
    hint: 'Opens Ledger restore proof.',
    keywords: ['ledger', 'backup', 'integrity'],
  },
];

export const COPY_LINK_ID = 'copy-link';

/** Every entry the person may open, given the enabled console modules (null: no gate, everything on). */
export function paletteEntries(enabled: readonly ModuleId[] | null): PaletteEntry[] {
  const allowed = (href: string) => {
    const module = moduleForPage(href.split('#')[0]!);
    return module !== null && (enabled === null || enabled.includes(module));
  };
  const pages: PaletteEntry[] = [
    ...MODULE_ROUTES.map((r) => ({ href: r.href, label: r.label, keywords: [r.id] as readonly string[] })),
    ...SUB_PAGES.map((p) => ({ href: p.href, label: p.label, keywords: p.keywords ?? [] })),
    // The founder merchant-ops screens (served by the catch-all route); one with an id in its path needs an id, so it is not listed.
    ...SCREENS.filter((s) => !s.route.includes(':')).map((s) => ({ href: s.route, label: s.title, keywords: [] as readonly string[] })),
  ]
    .filter((p, i, list) => list.findIndex((q) => q.href === p.href) === i)
    .filter((p) => allowed(p.href))
    .map((p) => {
      const module = moduleForPage(p.href)!;
      const area = MODULE_ROUTES.find((r) => r.id === module)?.label ?? module;
      return { id: `page:${p.href}`, kind: 'page', label: p.label, href: p.href, hint: area, keywords: p.keywords };
    });
  const actions: PaletteEntry[] = ACTIONS.filter((a) => allowed(a.href)).map((a) => ({
    id: `action:${a.id}`,
    kind: 'action',
    label: a.label,
    href: a.href,
    hint: a.hint,
    keywords: a.keywords,
  }));
  const copy: PaletteEntry = {
    id: `action:${COPY_LINK_ID}`,
    kind: 'action',
    label: 'Copy link to this page',
    href: null,
    hint: 'Puts this page’s address on the clipboard.',
    keywords: ['share', 'url', 'address'],
  };
  return [...pages, ...actions, copy];
}

/**
 * Entries matching every word of the query, best first: a label that starts with the query, then a label that contains it,
 * then a match on keywords or the hint only. Pages come before actions at the same rank. An empty query lists every page.
 */
export function searchPalette(entries: readonly PaletteEntry[], query: string): PaletteEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return entries.filter((e) => e.kind === 'page');
  const q = words.join(' ');
  const scored: { entry: PaletteEntry; rank: number; at: number }[] = [];
  entries.forEach((entry, at) => {
    const label = entry.label.toLowerCase();
    const haystack = `${label} ${entry.keywords.join(' ')} ${entry.hint} ${entry.href ?? ''}`.toLowerCase();
    if (!words.every((w) => haystack.includes(w))) return;
    const rank = (label.startsWith(q) ? 0 : label.includes(q) ? 1 : 2) * 2 + (entry.kind === 'page' ? 0 : 1);
    scored.push({ entry, rank, at });
  });
  return scored.sort((a, b) => a.rank - b.rank || a.at - b.at).map((s) => s.entry);
}
