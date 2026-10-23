import { defineCopy } from '../../shared/i18n';
import { InfoTip } from './InfoTip';

const en = {
  namedSpacesMissing: 'Named spaces aren’t included right now, so this total may be lower than your full balance.',
  namedSpacesShort: 'Named spaces not included',
} as const;
const es = {
  namedSpacesMissing: 'Los espacios con nombre no están incluidos ahora mismo, así que este total puede ser menor que tu saldo completo.',
  namedSpacesShort: 'Espacios con nombre no incluidos',
} satisfies Record<keyof typeof en, string>;
const fr = {
  namedSpacesMissing: 'Les espaces nommés ne sont pas inclus pour le moment ; ce total peut donc être inférieur à ton solde complet.',
  namedSpacesShort: 'Espaces nommés non inclus',
} satisfies Record<keyof typeof en, string>;
export const totalNoteCopy = defineCopy('customer.totalNote', en, { es, fr });

/**
 * Shown under the total whenever it was worked out on this device (balances x prices) instead of coming from the bank's
 * own valuation. That fallback has no named spaces, so the total can be lower than the real one. Says nothing otherwise.
 */
export function DerivedTotalNote({ source, className }: { source: 'server' | 'derived'; className: string }) {
  const { t } = totalNoteCopy.useCopy();
  if (source !== 'derived') return null;
  return (
    <p className={className} data-testid="derived-total-note">
      {t('namedSpacesMissing')}
    </p>
  );
}

/**
 * The same warning sized for a line that already exists: a short label with the full sentence behind an info tip. Home
 * puts it in the change line, whose height the loading skeleton keeps, so the page does not move when it appears (#6038).
 */
export function DerivedTotalTag({ source, className }: { source: 'server' | 'derived'; className: string }) {
  const { t } = totalNoteCopy.useCopy();
  if (source !== 'derived') return null;
  return (
    <span className={className} data-testid="derived-total-note">
      {t('namedSpacesShort')}
      <InfoTip text={t('namedSpacesMissing')} label={t('namedSpacesShort')} />
    </span>
  );
}
