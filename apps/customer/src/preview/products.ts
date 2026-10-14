/**
 * The Preview products (PRO-TERMINAL-PLAN section 11). One row each: the id is also the feature-registry id, the fixture file
 * name (`fixtures/<id>.ts`) and the screen folder (`screens/preview/<id>/`).
 *
 * `path` is the route the product opens at. It is the room's existing path; the registry row of the same id owns it.
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
] as const;
export type PreviewProductId = (typeof previewProductIds)[number];

export interface PreviewProduct {
  id: PreviewProductId;
  path: string;
  door: 'Money' | 'Trade' | 'Pay' | 'More';
  /** Name shown in menus, page titles and the "nothing was sent" sheet. */
  name: string;
  /** One line under the name in menus. */
  line: string;
}

export const previewProducts: Readonly<Record<PreviewProductId, PreviewProduct>> = {
  futures: { id: 'futures', path: '/trade/futures', door: 'Trade', name: 'Futures', line: 'Perpetual and dated contracts' },
  options: { id: 'options', path: '/trade/options', door: 'Trade', name: 'Options', line: 'Calls, puts and strikes' },
  margin: { id: 'margin', path: '/trade/margin', door: 'Trade', name: 'Margin', line: 'Trade with borrowed funds' },
  earn: { id: 'earn', path: '/bank/earn', door: 'Money', name: 'Earn', line: 'Put idle funds to work' },
  loans: { id: 'loans', path: '/bank/loans', door: 'Money', name: 'Loans', line: 'Borrow against your assets' },
  bots: { id: 'bots', path: '/trade/bots', door: 'Trade', name: 'Trading bots', line: 'Automated grid and DCA strategies' },
  agents: { id: 'agents', path: '/agents', door: 'Trade', name: 'Agents', line: 'Assistants that suggest, you approve' },
  copy: { id: 'copy', path: '/trade/copy', door: 'Trade', name: 'Copy trading', line: 'Follow a trader you pick' },
  p2p: { id: 'p2p', path: '/p2p', door: 'Trade', name: 'P2P', line: 'Trade directly with other people' },
  card: { id: 'card', path: '/bank/cards', door: 'Pay', name: 'Card', line: 'Spend your balance anywhere' },
  ifc: { id: 'ifc', path: '/ifc', door: 'More', name: 'IFC', line: 'Staking tiers and fee discounts' },
  deposit: { id: 'deposit', path: '/uc/recharge', door: 'Money', name: 'Deposit', line: 'Add funds to your account' },
  withdraw: { id: 'withdraw', path: '/uc/withdraw', door: 'Money', name: 'Withdraw', line: 'Send funds to your own wallet' },
};

export function isPreviewProductId(value: string): value is PreviewProductId {
  return (previewProductIds as readonly string[]).includes(value);
}
