/**
 * The Preview products (PRO-TERMINAL-PLAN section 11). One row each: the id is also the feature-registry id, the fixture file
 * name (`fixtures/<id>.ts`) and the screen folder (`screens/preview/<id>/`).
 *
 * `path` is the route the product opens at, always `/preview/<id>`; the registry row of the same id owns it. `legacyPath` is the older
 * address of the same product (for example `/trade/futures`); it redirects to `path`.
 * `door` is the top-bar tab whose menu lists it. Words here are plain English and shown to customers.
 */
export const previewProductIds = [
  'futures',
  'options',
  'margin',
  'earn',
  'loans',
  'bots',
  'agents',
  'copy',
  'p2p',
  'card',
  'ifc',
  'deposit',
  'withdraw',
  'academy',
] as const;
export type PreviewProductId = (typeof previewProductIds)[number];

export interface PreviewProduct {
  id: PreviewProductId;
  /** The route (`/preview/<id>`). Link here. */
  path: string;
  /** An older address that now redirects to `path`. It belongs to the same registry row, so it is hidden when Preview is off. */
  legacyPath?: string;
  door: 'Money' | 'Trade' | 'Pay' | 'More';
  /** Name shown in menus, page titles and the "nothing was sent" sheet. */
  name: string;
  /** One line under the name in menus. */
  line: string;
}

export const previewProducts: Readonly<Record<PreviewProductId, PreviewProduct>> = {
  futures: {
    id: 'futures',
    path: '/preview/futures',
    legacyPath: '/trade/futures',
    door: 'Trade',
    name: 'Futures',
    line: 'Perpetual and dated contracts',
  },
  options: {
    id: 'options',
    path: '/preview/options',
    legacyPath: '/trade/options',
    door: 'Trade',
    name: 'Options',
    line: 'Calls, puts and strikes',
  },
  margin: {
    id: 'margin',
    path: '/preview/margin',
    legacyPath: '/trade/margin',
    door: 'Trade',
    name: 'Margin',
    line: 'Trade with borrowed funds',
  },
  earn: { id: 'earn', path: '/preview/earn', legacyPath: '/bank/earn', door: 'Money', name: 'Earn', line: 'Put idle funds to work' },
  loans: {
    id: 'loans',
    path: '/preview/loans',
    legacyPath: '/bank/loans',
    door: 'Money',
    name: 'Loans',
    line: 'Borrow against your assets',
  },
  bots: {
    id: 'bots',
    path: '/preview/bots',
    legacyPath: '/trade/bots',
    door: 'Trade',
    name: 'Trading bots',
    line: 'Automated grid and DCA strategies',
  },
  agents: {
    id: 'agents',
    path: '/preview/agents',
    legacyPath: '/agents',
    door: 'Trade',
    name: 'Agents',
    line: 'Assistants that suggest, you approve',
  },
  copy: {
    id: 'copy',
    path: '/preview/copy',
    legacyPath: '/trade/copy',
    door: 'Trade',
    name: 'Copy trading',
    line: 'Follow a trader you pick',
  },
  p2p: { id: 'p2p', path: '/preview/p2p', legacyPath: '/p2p', door: 'Trade', name: 'P2P', line: 'Trade directly with other people' },
  card: { id: 'card', path: '/preview/card', legacyPath: '/bank/cards', door: 'Pay', name: 'Card', line: 'Spend your balance anywhere' },
  ifc: { id: 'ifc', path: '/preview/ifc', door: 'More', name: 'IFC', line: 'Staking tiers and fee discounts' },
  deposit: {
    id: 'deposit',
    path: '/preview/deposit',
    legacyPath: '/uc/recharge',
    door: 'Money',
    name: 'Deposit',
    line: 'Add funds to your account',
  },
  withdraw: {
    id: 'withdraw',
    path: '/preview/withdraw',
    legacyPath: '/uc/withdraw',
    door: 'Money',
    name: 'Withdraw',
    line: 'Send funds to your own wallet',
  },
  academy: {
    id: 'academy',
    path: '/preview/academy',
    legacyPath: '/academy',
    door: 'More',
    name: 'Academy',
    line: 'Lessons and certifications',
  },
};

export function isPreviewProductId(value: string): value is PreviewProductId {
  return (previewProductIds as readonly string[]).includes(value);
}
