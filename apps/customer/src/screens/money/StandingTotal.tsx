import { Fold, Tag, heldStateOf, totalFreshness, useFreshnessClock, type HeldState } from '@intafaced/ui/lit';
import type { UiDisplayCurrency } from '@intafaced/contracts/ui-view-preferences';
import { useAsOfText } from '../../features/trade/venue/VenueKit';
import { STANDING_STALE_AFTER_MS, shownUsd, type PartId, type Standing, type ValuedPart } from './standing';
import { standingCopy } from './standing-copy';
import { HeroTotal, Shown, btcParts, usdParts } from './money-parts';

type T = ReturnType<typeof standingCopy.useCopy>['t'];

const PART_LABEL = { wallet: 'Part wallet', venue: 'Part venue', partner: 'Part partner' } as const satisfies Record<PartId, string>;
/** A part's name: the source's own name, or for a partner that did not answer, its plain role. */
function partName(part: ValuedPart, t: T): string {
  return part.id === 'partner' && !part.label ? t('Part partner unnamed') : t(PART_LABEL[part.id], { name: part.label });
}

/** The kit's words for a figure's state, from this room's copy. */
function heldLabels(t: T): Partial<Record<HeldState, string>> {
  return { stale: t('Held stale'), unknown: t('Held unknown'), transit: t('Held transit') };
}

/**
 * The state of one figure: known with its as-of time; stale, still with its time; not known, said in words, never an
 * empty or zero figure. The word is the kit's Tag, so colour is never the only cue.
 */
function Held({
  state,
  asOf,
  asOfText,
  t,
  timeTestId,
}: {
  state: HeldState;
  asOf?: string | null;
  asOfText?: string;
  t: T;
  timeTestId?: string;
}) {
  const word = heldLabels(t)[state];
  const time = state !== 'unknown' && asOf ? asOf : null;
  return (
    <span data-slot="held-mark" data-held={state}>
      {word ? (
        <Tag tone="neutral" data-part="word">
          {word}
        </Tag>
      ) : null}
      {time ? (
        <>
          {word ? ' · ' : null}
          <time dateTime={time} data-testid={timeTestId}>
            {asOfText ?? time}
          </time>
        </>
      ) : null}
    </span>
  );
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
 * this one component from the same reads, so both rooms show the same figures. Drawn from the Volt kit; Pro shows the
 * same figure (the kit has one hero size), so `pro` changes nothing here.
 */
export function StandingTotal({
  standing,
  pricesFailed,
  displayCurrency,
  hidden,
  testId,
  face = 'full',
}: {
  standing: Standing;
  pricesFailed: boolean;
  displayCurrency: UiDisplayCurrency;
  hidden: boolean;
  pro?: boolean;
  testId: string;
  /**
   * `full` (Home's): every line on the face. `headline` (Assets, owner's pick A): the figure and one line naming each
   * part's value; every other line (times, price source, each part's source, what is left out) in a closed fold below,
   * still in the page with the same marks.
   */
  face?: 'full' | 'headline';
}) {
  const { t } = standingCopy.useCopy();
  const asOfText = useAsOfText();
  const { totalUsd, btc, prices } = standing;
  const btcTotal = btc !== null && btc.total !== null ? btc.total : null;
  const test = Boolean(prices?.test) || standing.parts.some((part) => part.test);
  const figure = (
    <div data-testid="standing-figure" data-unit={btcTotal !== null ? 'BTC' : 'USD'} data-total-usd={totalUsd ?? ''}>
      {totalUsd === null ? (
        <span data-testid="standing-no-total">{t('No total')}</span>
      ) : (
        <HeroTotal parts={btcTotal !== null ? btcParts(btcTotal) : usdParts(totalUsd)} hidden={hidden} unknownLabel={t('No total')} />
      )}{' '}
      {test ? (
        <span className="lt-test" data-testid="standing-test" title={t('TEST note')}>
          {t('TEST')}
        </span>
      ) : null}
    </div>
  );
  const lines = (
    <>
      {totalUsd === null ? null : <TotalAsOf standing={standing} t={t} asOfText={asOfText} />}
      <p data-testid="standing-prices" className="lt-hint" data-state={pricesFailed ? 'failed' : prices ? 'published' : 'unpublished'}>
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
      <ul data-testid="standing-parts" className="lt-rows">
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
    </>
  );
  if (face === 'headline')
    return (
      <section data-testid={testId} data-standing="" data-face="headline" className="lt-stack lt-stack-tight" aria-label={t('Title')}>
        {figure}
        <PartsLine standing={standing} hidden={hidden} t={t} />
        <Fold title={t('Worked out')} data-testid="standing-worked-out">
          <div className="lt-stack lt-stack-tight">{lines}</div>
        </Fold>
      </section>
    );
  return (
    <section data-testid={testId} data-standing="" className="lt-stack" aria-label={t('Title')}>
      {figure}
      {lines}
    </section>
  );
}

const LINE_NAME = { wallet: 'Line wallet', venue: 'Line venue', partner: 'Line partner' } as const satisfies Record<PartId, string>;

/**
 * The headline's one line under the figure: each part by its short name and its value ("Wallet $1,388.40 · Venue
 * $20,098.12"), or in words why it has none (not known, not valued, holds nothing), never a zero.
 */
function PartsLine({ standing, hidden, t }: { standing: Standing; hidden: boolean; t: T }) {
  if (standing.parts.length === 0) return null;
  return (
    <p className="lt-hint" data-testid="standing-line">
      {standing.parts.map((part, index) => {
        const name = t(LINE_NAME[part.id]);
        return (
          <span key={part.id} data-line-part={part.id}>
            {index > 0 ? ' · ' : null}
            {part.state === 'reading' ? (
              t('Line reading', { part: name })
            ) : part.state === 'unread' ? (
              t('Line not known', { part: name })
            ) : part.rows.length === 0 ? (
              t('Line empty', { part: name })
            ) : part.valueUsd === null ? (
              t('Line not valued', { part: name })
            ) : (
              <>
                {name} <Shown text={dollars(part.valueUsd)} hidden={hidden} />
              </>
            )}
          </span>
        );
      })}
    </p>
  );
}

/**
 * The total's own time: the oldest as-of time among the parts it adds up, stale when that part is stale. A part
 * that couldn't be read is left out of the total and named below (J-home-ia-01 #1), so it is not one of these parts.
 */
function TotalAsOf({ standing, t, asOfText }: { standing: Standing; t: T; asOfText: (iso: string) => string }) {
  const read = standing.parts.filter((part): part is ValuedPart & { asOf: string } => part.state === 'read' && part.asOf !== null);
  const oldest = read.reduce<string | null>(
    (min, part) => (min === null || Date.parse(part.asOf) < Date.parse(min) ? part.asOf : min),
    null,
  );
  const now = useFreshnessClock({ asOf: oldest, staleAfterMs: STANDING_STALE_AFTER_MS, enabled: oldest !== null });
  const total = totalFreshness(
    read.map((part) => ({ state: heldStateOf({ asOf: part.asOf, now, staleAfterMs: STANDING_STALE_AFTER_MS }), asOf: part.asOf })),
  );
  return (
    <p data-testid="standing-as-of" data-held={total.state} className="lt-hint">
      {t('Total as of')}{' '}
      <Held
        state={total.state}
        asOf={total.asOf}
        asOfText={total.asOf ? asOfText(total.asOf) : undefined}
        t={t}
        timeTestId="standing-as-of-time"
      />
    </p>
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
  const read = part.state === 'read';
  const now = useFreshnessClock({ asOf: part.asOf, staleAfterMs: STANDING_STALE_AFTER_MS, enabled: read && part.asOf !== null });
  const held: HeldState | null =
    part.state === 'reading'
      ? null
      : heldStateOf({ asOf: part.asOf, now, staleAfterMs: STANDING_STALE_AFTER_MS, unknown: part.state === 'unread' });
  return (
    <li
      data-testid="standing-part"
      data-part={part.id}
      data-state={part.state}
      data-held={held ?? undefined}
      data-value-usd={part.valueUsd ?? ''}
    >
      {/* Each row of `.lt-rows` stacks its children, so each line is one element: the name, then who reports it and when,
          then the figure. A bare separator between them would stand on a line of its own. */}
      <span>
        <span data-testid="standing-part-label">{partName(part, t)}</span>
        {part.test ? (
          <>
            {' '}
            <span className="lt-test" data-testid="standing-part-test">
              {t('TEST')}
            </span>
          </>
        ) : null}
      </span>
      <span className="lt-hint">
        <span data-testid="standing-part-source">{t(PART_SOURCE[part.id])}</span>
        {/* A TEST part names the TEST adapter its figures come from (J-home-ia-11 #3): the source's own name. */}
        {part.test && part.label ? (
          <>
            {', '}
            <span data-testid="standing-part-adapter">{t('Source TEST adapter', { name: part.label })}</span>
          </>
        ) : null}
        {held !== null && held !== 'unknown' && part.asOf ? (
          <>
            {' · '}
            <Held state={held} asOf={part.asOf} asOfText={asOfText(part.asOf)} t={t} timeTestId="standing-part-as-of" />
          </>
        ) : null}
      </span>
      {part.state === 'reading' ? (
        <span className="lt-hint">{t('Part reading')}</span>
      ) : part.state === 'unread' ? (
        <span>
          <Held state="unknown" t={t} /> <span data-testid="standing-part-unread">{t('Part unread')}</span>
        </span>
      ) : part.rows.length === 0 ? (
        <span className="lt-hint">{t('Part empty')}</span>
      ) : part.valueUsd === null ? (
        <span>
          {/* Nothing here has a published price, so each amount is shown as its source reports it. */}
          <Shown
            testId="standing-part-amounts"
            slot="amount"
            text={part.rows.map((row) => `${row.amount} ${row.asset}`).join(', ')}
            hidden={hidden}
          />{' '}
          <span className="lt-hint">{t('Part not valued')}</span>
        </span>
      ) : (
        <Shown testId="standing-part-value" text={dollars(part.valueUsd)} hidden={hidden} />
      )}
    </li>
  );
}
