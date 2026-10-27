/** The rooms of the trade operator desk, in sub-nav order. One place so the nav, overview and tests agree. */
export interface DeskRoom {
  readonly id: string;
  readonly href: string;
  readonly label: string;
  /** What an operator does here, in one line. */
  readonly job: string;
}

export const DESK_ROOMS: readonly DeskRoom[] = [
  { id: 'overview', href: '/trade-ops', label: 'Health', job: 'Is matching up, is the book accepting orders, what is open right now.' },
  {
    id: 'markets',
    href: '/trade-ops/markets',
    label: 'Markets',
    job: 'Status of each market; halt, reduce-only, post-only, resume, delist.',
  },
  {
    id: 'charts-settings',
    href: '/trade-ops/charts/settings',
    label: 'Charts settings',
    job: 'Owner values the charts module enforces; a data class change needs a second founder.',
  },
  {
    id: 'kill-switch',
    href: '/trade-ops/kill-switch',
    label: 'Kill switch',
    job: 'Stop new orders for the whole trade module; mass cancel; venue halt.',
  },
  {
    id: 'risk-limits',
    href: '/trade-ops/risk-limits',
    label: 'Risk limits',
    job: 'Per-market limits the engine enforces, and who may change them.',
  },
  {
    id: 'approvals',
    href: '/trade-ops/approvals',
    label: 'Freezes & approvals',
    job: 'Trading restrictions per account; second-person approvals.',
  },
  {
    id: 'vip-applications',
    href: '/trade-ops/vip-applications',
    label: 'VIP applications',
    job: 'Decide applications for a VIP fee tier with a second founder; grant the trial the owner publishes.',
  },
  { id: 'orders', href: '/trade-ops/orders', label: 'Orders', job: 'Open orders across accounts; open one; seeded or customer.' },
  { id: 'positions', href: '/trade-ops/positions', label: 'Positions', job: 'Look up positions and their margin state.' },
  {
    id: 'liquidations',
    href: '/trade-ops/liquidations',
    label: 'Liquidations',
    job: 'Liquidation steps, positions nearest to liquidation, auto-deleveraging and the insurance fund.',
  },
  {
    id: 'surveillance',
    href: '/trade-ops/surveillance',
    label: 'Surveillance',
    job: 'Spoofing and layering cases; no automatic sanctions.',
  },
  { id: 'exports', href: '/trade-ops/exports', label: 'Exports', job: 'Save order, fill and audit records as CSV.' },
  { id: 'audit', href: '/trade-ops/audit', label: 'Audit', job: 'Who changed what: kill switches, restrictions, approvals.' },
];
