import { useId, useMemo, useState } from 'react';
import { useFavorites } from '../../data/favorites';
import { alertsCopy } from './alerts-copy';
import { priceProblem } from './alerts-model';
import { Button } from './deps';
import { ALERT_CONDITIONS, directionOfCondition, type AlertCondition, type WatchlistIntent } from './notify-api';
import type { AlertMarket } from './use-alerts';

/** The reasons the page switches its forms off, each a copy key that needs no values. */
export type BlockedReason =
  | 'reasonBusy'
  | 'reasonUnsure'
  | 'reasonMarketsLoading'
  | 'reasonMarketsFailed'
  | 'reasonNoMarkets'
  | 'reasonListLoading'
  | 'reasonListFailed'
  | 'reasonQuotaOff'
  | 'reasonQuotaFull';

const CONDITION_KEY = {
  greater_than: 'above',
  less_than: 'below',
  crossing_up: 'crossingUp',
  crossing_down: 'crossingDown',
  crossing: 'crossing',
} as const satisfies Record<AlertCondition, string>;

/**
 * One alert on each market of the person's favourites, all saved together or not at all. The favourites live on this device, so
 * the list is sent with the request; the same price is used for every market. The panel sends nothing itself: Save hands the
 * reviewed intent to the page, which owns the one-at-a-time gate and the notices.
 */
export function WatchlistAlert({
  markets,
  userId,
  room,
  blockedReason,
  busy,
  onSave,
}: {
  markets: readonly AlertMarket[];
  userId: string | null;
  /** Places left under the price-alert quota; `null` when it is not known. */
  room: number | null;
  blockedReason: BlockedReason | null;
  busy: boolean;
  /** Sends the reviewed intent. `refused` means nothing was saved and the person may change it; the others end this attempt. */
  onSave: (intent: WatchlistIntent) => Promise<'saved' | 'unknown' | 'refused'>;
}) {
  const copy = alertsCopy.useCopy();
  const id = useId();
  const { favorites } = useFavorites(userId);
  // A favourite is a symbol such as BTC/USDT; an alert watches the market behind it.
  const listed = useMemo(() => {
    const bySymbol = new Map(markets.map((market) => [market.label, market]));
    const found = favorites.flatMap((symbol) => {
      const market = bySymbol.get(symbol);
      return market ? [market] : [];
    });
    return { found, left: favorites.length - found.length };
  }, [favorites, markets]);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [condition, setCondition] = useState<AlertCondition>('greater_than');
  const [price, setPrice] = useState('');
  const [touched, setTouched] = useState(false);
  const [review, setReview] = useState<WatchlistIntent | null>(null);

  const picked = listed.found.filter((market) => chosen.has(market.id));
  const problem = touched ? priceProblem(price) : null;
  const tooMany = room !== null && picked.length > room;

  function toReview() {
    setTouched(true);
    if (blockedReason || picked.length === 0 || priceProblem(price) !== null || tooMany) return;
    setReview({
      marketIds: picked.map((market) => market.id),
      direction: directionOfCondition(condition),
      condition,
      targetPrice: price.trim(),
    });
  }

  return (
    <section className="nf-card nf-alertform" aria-labelledby={`${id}-title`} data-testid="alerts-watchlist">
      <h2 className="nf-h2" id={`${id}-title`}>
        {copy.t('watchTitle')}
      </h2>
      <p className="nf-muted">{copy.t('watchIntro')}</p>
      {listed.found.length === 0 ? (
        <p className="nf-muted" data-testid="alerts-watchlist-empty">
          {copy.t('watchEmpty')}
        </p>
      ) : review ? (
        <div data-testid="alerts-watchlist-review">
          <h3 className="nf-h2">{copy.t('watchReviewTitle')}</h3>
          <dl className="nf-facts">
            <div>
              <dt>{copy.t('watchReviewMarkets')}</dt>
              <dd>{review.marketIds.map((marketId) => markets.find((market) => market.id === marketId)?.label ?? marketId).join(', ')}</dd>
            </div>
            <div>
              <dt>{copy.t('reviewWhen')}</dt>
              <dd lang="zxx" className="nf-num">
                {copy.t(CONDITION_KEY[review.condition])} {review.targetPrice}
              </dd>
            </div>
            <div>
              <dt>{copy.t('watchReviewCount')}</dt>
              <dd>{String(review.marketIds.length)}</dd>
            </div>
          </dl>
          <p className="nf-muted">{copy.t('watchOnce')}</p>
          <div className="nf-address__actions">
            <Button variant="secondary" size={32} disabled={busy} onClick={() => setReview(null)}>
              {copy.t('back')}
            </Button>
            <Button
              size={32}
              loading={busy}
              disabled={busy || blockedReason !== null}
              onClick={() => {
                void onSave(review).then((result) => {
                  // A saved or unsure attempt is over: sending the same batch again would double it.
                  if (result === 'refused') return;
                  setReview(null);
                  if (result === 'saved') {
                    setChosen(new Set());
                    setPrice('');
                    setTouched(false);
                  }
                });
              }}
            >
              {copy.t(busy ? 'saving' : 'watchSave', { count: String(review.marketIds.length) })}
            </Button>
          </div>
        </div>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            toReview();
          }}
        >
          <fieldset className="nf-field" disabled={blockedReason !== null}>
            <legend>{copy.t('watchMarkets')}</legend>
            {listed.found.map((market) => (
              <label key={market.id} className="nf-check">
                <input
                  type="checkbox"
                  checked={chosen.has(market.id)}
                  onChange={(event) => {
                    const next = new Set(chosen);
                    if (event.target.checked) next.add(market.id);
                    else next.delete(market.id);
                    setChosen(next);
                  }}
                />
                <span>{market.label}</span>
              </label>
            ))}
            <div className="nf-address__actions">
              <Button variant="ghost" size={28} onClick={() => setChosen(new Set(listed.found.map((market) => market.id)))}>
                {copy.t('watchAll')}
              </Button>
              <Button variant="ghost" size={28} onClick={() => setChosen(new Set())}>
                {copy.t('watchNone')}
              </Button>
            </div>
            {listed.left > 0 ? <small className="nf-muted">{copy.t('watchLeftOut', { count: String(listed.left) })}</small> : null}
          </fieldset>
          <label className="nf-field">
            <span>{copy.t('conditionLabel')}</span>
            <select
              value={condition}
              disabled={blockedReason !== null}
              onChange={(event) => {
                const next = ALERT_CONDITIONS.find((value) => value === event.target.value);
                if (next) setCondition(next);
              }}
            >
              {ALERT_CONDITIONS.map((value) => (
                <option key={value} value={value}>
                  {copy.t(CONDITION_KEY[value])}
                </option>
              ))}
            </select>
          </label>
          <label className="nf-field">
            <span>{copy.t('priceLabelNoMarket')}</span>
            <input
              inputMode="decimal"
              autoComplete="off"
              maxLength={64}
              value={price}
              disabled={blockedReason !== null}
              aria-invalid={problem !== null}
              onChange={(event) => {
                setPrice(event.target.value);
                setTouched(false);
              }}
            />
            <small className={problem ? 'nf-error' : 'nf-muted'}>
              {problem === 'empty' ? copy.t('priceEmpty') : problem === 'invalid' ? copy.t('priceInvalid') : copy.t('watchSame')}
            </small>
          </label>
          {touched && picked.length === 0 ? <p className="nf-error">{copy.t('watchNeedOne')}</p> : null}
          {tooMany ? <p className="nf-error">{copy.t('watchTooMany', { count: String(picked.length), room: String(room) })}</p> : null}
          <div className="nf-address__actions">
            <Button type="submit" size={32} disabled={blockedReason !== null}>
              {copy.t('review')}
            </Button>
          </div>
          {blockedReason ? <p className="nf-muted">{copy.t(blockedReason)}</p> : null}
        </form>
      )}
    </section>
  );
}
