import { defineCopy } from '../../shared/i18n';

// Plain names for the spending categories the Bank reports by key.
const en = {
  transfers: 'Transfers',
  trading: 'Trading',
  p2p: 'Person-to-person',
  fees: 'Fees',
  withdrawals: 'Withdrawals',
  earn: 'Earn and staking',
  deposits: 'Deposits',
  rewards: 'Rewards',
  other: 'Everything else',
} as const;
const es = {
  transfers: 'Transferencias',
  trading: 'Trading',
  p2p: 'Persona a persona',
  fees: 'Comisiones',
  withdrawals: 'Retiros',
  earn: 'Rendimiento y staking',
  deposits: 'Depósitos',
  rewards: 'Recompensas',
  other: 'Todo lo demás',
} satisfies Record<keyof typeof en, string>;
const fr = {
  transfers: 'Virements',
  trading: 'Trading',
  p2p: 'De personne à personne',
  fees: 'Frais',
  withdrawals: 'Retraits',
  earn: 'Placements et staking',
  deposits: 'Dépôts',
  rewards: 'Récompenses',
  other: 'Tout le reste',
} satisfies Record<keyof typeof en, string>;
export const analyticsCopy = defineCopy('customer.money.analytics', en, { es, fr });

const known = (key: string): key is keyof typeof en => Object.hasOwn(en, key);
/** The name a customer reads for a category key. A key we have no name for is made readable instead of shown raw. */
export function categoryLabel(key: string): string {
  if (known(key)) return analyticsCopy.t(key);
  const words = key
    .replace(/[_.-]+/g, ' ')
    .trim()
    .toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : analyticsCopy.t('other');
}
