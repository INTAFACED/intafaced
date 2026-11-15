import { Badge, HeroNumber, Money } from '@intafaced/ui';
import type { UiDisplayCurrency } from '@intafaced/contracts/ui-view-preferences';
import { useAsOfText } from '../../features/trade/venue/VenueKit';
import { shownUsd, type PartId, type Standing, type ValuedPart } from './standing';
import { standingCopy } from './standing-copy';

type T = ReturnType<typeof standingCopy.useCopy>['t'];

const PART_LABEL = { wallet: 'Part wallet', venue: 'Part venue', partner: 'Part partner' } as const satisfies Record<PartId, string>;
/** A part's name: the source's own name, or for a partner that did not answer, its plain role. */
function partName(part: ValuedPart, t: T): string {
  return part.id === 'partner' && !part.label ? t('Part partner unnamed') : t(PART_LABEL[part.id], { name: part.label });
}

const PART_SOURCE = { wallet: 'Source wallet', venue: 'Source venue', partner: 'Source partner' } as const satisfies Record<PartId, string>;

/** "1234567.89" -> "1,234,567.89". */
function grouped(decimal: string): string {
  const [whole = '0', fraction] = decimal.split('.');
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${fraction === undefined ? '' : `.${fraction}`}`;
}

/** A full-precision USD value as a person reads it: dollars to the cent, grouped. */
export function dollars(valueUsd: string): string {
  return `$${grouped(shownUsd(valueUsd))}`;
}

/**
 * The total of what a person holds where it sits (`standing.ts`): the figure in the chosen unit, the price source and its
 * time, every part with its source and as-of time and its value, and what is left out and why. Home and Assets draw
 * this one component from the same reads, so both rooms show the same figures.
 */
export function StandingTotal({
  standing,
  pricesFailed,
  displayCurrency,
  hidden,
  pro = false,
  testId,
}: {
  standing: Standing;
  pricesFailed: boolean;
  displayCurrency: UiDisplayCurrency;
  hidden: boolean;
  pro?: boolean;
  testId: string;
}) {
  const { t } = standingCopy.useCopy();
  const asOfText = useAsOfText();
  const { totalUsd, btc, prices } = standing;
  const btcTotal = btc !== null && btc.total !== null ? btc.total : null;
  const test = Boolean(prices?.test) || standing.parts.some((part) => part.test);
  const size = pro ? 'hero-pro' : undefined;
  return (
    <section data-testid={testId} data-standing="" className="form-stack" aria-label={t('Title')}>
      <div data-testid="standing-figure" data-unit={btcTotal !== null ? 'BTC' : 'USD'} data-total-usd={totalUsd ?? ''}>
        {totalUsd === null ? (
          <span data-testid="standing-no-total">{t('No total')}</span>
        ) : btcTotal !== null ? (
          <HeroNumber value={btcTotal} decimals={8} prefix="₿" unit={pro ? 'BTC' : undefined} size={size} hidden={hidden} />
        ) : (
          <HeroNumber value={totalUsd} decimals={2} prefix="$" unit={pro ? 'USD' : undefined} size={size} hidden={hidden} />
        )}{' '}
        {test ? (
          <Badge tone="warn" data-testid="standing-test" title={t('TEST note')}>
            {t('TEST')}
          </Badge>
        ) : null}
      </div>
      <p data-testid="standing-prices" className="muted" data-state={pricesFailed ? 'failed' : prices ? 'published' : 'unpublished'}>
        {pricesFailed ? (
          t('Prices failed')
        ) : !prices ? (
          t('No price published')
        ) : (
          <>
            {totalUsd === null ? `${t('Nothing priced')} ` : null}
            {t('Prices source', { source: prices.source })}{' '}
            <time dateTime={prices.asOf} data-testid="standing-prices-as-of">
              {asOfText(prices.asOf)}
            </time>
          </>
        )}
      </p>
      <UnitNote standing={standing} displayCurrency={displayCurrency} hidden={hidden} t={t} />
      <ul data-testid="standing-parts" className="form-stack">
        {standing.parts.map((part) => (
          <Part key={part.id} part={part} hidden={hidden} t={t} asOfText={asOfText} />
        ))}
      </ul>
      {standing.unread.length > 0 ? (
        <p data-testid="standing-unread" role="status" data-parts={standing.unread.join(',')}>
          {t('Unread note', {
            parts: standing.parts
              .filter((part) => part.state === 'unread')
              .map((part) => partName(part, t))
              .join(', '),
          })}
        </p>
      ) : null}
      {standing.unpriced.length > 0 && prices ? (
        <p data-testid="standing-unpriced" data-assets={standing.unpriced.join(',')}>
          {t('Unpriced note', { assets: standing.unpriced.join(', ') })}
        </p>
      ) : null}
    </section>
  );
}

function UnitNote({
  standing,
  displayCurrency,
  hidden,
  t,
}: {
  standing: Standing;
  displayCurrency: UiDisplayCurrency;
  hidden: boolean;
  t: T;
}) {
  const { btc, prices, totalUsd } = standing;
  if (totalUsd === null) return null;
  if (displayCurrency !== 'USD' && displayCurrency !== 'BTC')
    return (
      <p data-testid="standing-unit-note" data-total-unit="USD">
        {t('Other currency', { currency: displayCurrency })}
      </p>
    );
  if (btc === null) return null;
  if (btc.total !== null)
    return (
      <p data-testid="standing-unit-note" data-total-unit="BTC">
        {hidden
          ? t('Shown in BTC hidden', { source: prices?.source ?? '' })
          : t('Shown in BTC', { source: prices?.source ?? '', usd: dollars(totalUsd) })}
      </p>
    );
  return (
    <p data-testid="standing-unit-note" data-total-unit="USD">
      {t('BTC price missing')}
    </p>
  );
}

function Part({ part, hidden, t, asOfText }: { part: ValuedPart; hidden: boolean; t: T; asOfText: (iso: string) => string }) {
  return (
    <li data-testid="standing-part" data-part={part.id} data-state={part.state} data-value-usd={part.valueUsd ?? ''}>
      <span data-testid="standing-part-label">{partName(part, t)}</span>
      {part.test ? (
        <>
          {' '}
          <Badge tone="warn">{t('TEST')}</Badge>
        </>
      ) : null}
      {' · '}
      <span data-testid="standing-part-source">{t(PART_SOURCE[part.id])}</span>
      {part.asOf ? (
        <>
          {' · '}
          <time dateTime={part.asOf} data-testid="standing-part-as-of">
            {asOfText(part.asOf)}
          </time>
        </>
      ) : null}
      {': '}
      {part.state === 'reading' ? (
        <span className="muted">{t('Part reading')}</span>
      ) : part.state === 'unread' ? (
        <span data-testid="standing-part-unread">{t('Part unread')}</span>
      ) : part.rows.length === 0 ? (
        <span className="muted">{t('Part empty')}</span>
      ) : part.valueUsd === null ? (
        <span className="muted">{t('Part not valued')}</span>
      ) : (
        <Money data-testid="standing-part-value" value={dollars(part.valueUsd)} hidden={hidden} />
      )}
    </li>
  );
}
