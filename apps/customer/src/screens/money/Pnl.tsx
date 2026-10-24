import { useMemo, useState } from 'react';
import { InfoTip } from './InfoTip';
import { moneyCopy } from './copy';
import { Amount, Button, Skeleton, StateBlock, fmtAmount, fmtPct, fmtUsd, navigate, refusalCopy, type Loadable } from './deps';
import { MissingCost, basisRefusalWords } from './MissingCost';
import {
  LOT_METHODS,
  lotAssetFromQuery,
  lotAssets,
  lotsOf,
  methodFromQuery,
  pnlView,
  type AssetPnl,
  type LotBook,
  type LotBookLot,
  type LotMethod,
  type MissingBasis,
  type UnknownReason,
  unknownShareOf,
} from './pnl-model';
import { useBasisOverride, useLotBook, useMissingBasis, type BasisOutcome } from './pnl-source';
import { useMoneyPortfolio } from './portfolio-source';
import { stamp } from './time';
import { usePreferences } from '../../shared/preferences';

type Copy = ReturnType<typeof moneyCopy.useCopy>;

const REASON_COPY: Record<UnknownReason, 'Cost unknown' | 'No price now' | 'Cost not reconciled'> = {
  cost_unknown: 'Cost unknown',
  no_price: 'No price now',
  not_reconciled: 'Cost not reconciled',
};

const METHOD_COPY: Record<LotMethod, 'Method FIFO' | 'Method LIFO' | 'Method HIFO' | 'Method AVERAGE'> = {
  FIFO: 'Method FIFO',
  LIFO: 'Method LIFO',
  HIFO: 'Method HIFO',
  AVERAGE: 'Method AVERAGE',
};

const SOURCE_COPY: Record<
  LotBookLot['source'],
  'Source trade' | 'Source deposit' | 'Source reward' | 'Source transfer_in' | 'Source other_in'
> = {
  trade: 'Source trade',
  deposit: 'Source deposit',
  reward: 'Source reward',
  transfer_in: 'Source transfer_in',
  other_in: 'Source other_in',
};

/** One plain sentence for each reason the book can name. Codes never reach the screen. */
const RESIDUAL_COPY: Record<
  string,
  | 'Residual underflow'
  | 'Residual cost unavailable'
  | 'Residual unreconciled'
  | 'Residual incomplete'
  | 'Residual deposit policy'
  | 'Residual price at time'
> = {
  'tax.lot_underflow': 'Residual underflow',
  'tax.cost_basis_unavailable': 'Residual cost unavailable',
  'tax.lot_book_unreconciled': 'Residual unreconciled',
  'tax.lot_book_incomplete': 'Residual incomplete',
  'tax.deposit_basis_policy_unset': 'Residual deposit policy',
  'tax.price_at_time_unavailable': 'Residual price at time',
};

function usd(value: string | null, copy: Copy, signed = false): string {
  return value === null ? copy.t('Not known') : fmtUsd(value, { showPlus: signed });
}

function MethodSwitch({ method, onChange, copy }: { method: LotMethod | null; onChange: (next: LotMethod) => void; copy: Copy }) {
  const { t } = copy;
  return (
    <div className="money-alloc__switch" role="group" aria-label={t('Matching method')}>
      {LOT_METHODS.map((option) => (
        <button key={option} type="button" className="money-alloc__opt" aria-pressed={method === option} onClick={() => onChange(option)}>
          {t(METHOD_COPY[option])}
        </button>
      ))}
    </div>
  );
}

function AssetRows({ assets, hidden, copy }: { assets: readonly AssetPnl[]; hidden: boolean; copy: Copy }) {
  const { t } = copy;
  return (
    <section className="money-card" aria-label={t('Open positions')}>
      <header className="money-card__head">
        <h2>{t('Open positions')}</h2>
      </header>
      <table className="money-table">
        <thead>
          <tr>
            <th scope="col">{t('Coin')}</th>
            <th scope="col" className="money-num">
              {t('Bought quantity')}
            </th>
            <th scope="col" className="money-num">
              {t('Average price')}
            </th>
            <th scope="col" className="money-num">
              {t('Cost')}
            </th>
            <th scope="col" className="money-num">
              {t('Worth now')}
            </th>
            <th scope="col" className="money-num">
              {t('Unrealised')}
            </th>
          </tr>
        </thead>
        <tbody>
          {assets.map((a) => (
            <tr key={a.asset} data-asset={a.asset}>
              <th scope="row">
                {a.asset}
                {a.otherQty !== '0' ? (
                  <span className="money-note"> {t('Other quantity', { qty: fmtAmount(a.otherQty), asset: a.asset })}</span>
                ) : null}
              </th>
              <td className="money-num">
                <Amount value={fmtAmount(a.knownQty)} hidden={hidden} />
              </td>
              <td className="money-num" data-col="average">
                <Amount value={usd(a.avgPriceUsd, copy)} hidden={hidden} />
              </td>
              <td className="money-num" data-col="cost">
                <Amount value={usd(a.costUsd, copy)} hidden={hidden} />
              </td>
              <td className="money-num">
                <Amount value={usd(a.valueUsd, copy)} hidden={hidden} />
              </td>
              <td className="money-num" data-col="unrealised">
                {a.unrealisedUsd === null ? (
                  <span>{t(REASON_COPY[a.reason ?? 'cost_unknown'])}</span>
                ) : (
                  <Amount
                    value={`${usd(a.unrealisedUsd, copy, true)}${a.unrealisedRatio !== null ? ` (${fmtPct(a.unrealisedRatio, { signed: true })})` : ''}`}
                    hidden={hidden}
                  />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function SaleRows({ book, missing, hidden, copy }: { book: LotBook; missing: MissingBasis | null; hidden: boolean; copy: Copy }) {
  const { t } = copy;
  const { timeZone } = usePreferences();
  return (
    <section className="money-card" aria-label={t('Sales')}>
      <header className="money-card__head">
        <h2>{t('Sales')}</h2>
      </header>
      {book.sales.length === 0 ? (
        <p className="money-note">{t('No sales yet')}</p>
      ) : (
        <table className="money-table">
          <thead>
            <tr>
              <th scope="col">{t('Sold')}</th>
              <th scope="col" className="money-num">
                {t('Quantity')}
              </th>
              <th scope="col" className="money-num">
                {t('Received')}
              </th>
              <th scope="col" className="money-num">
                {t('Cost')}
              </th>
              <th scope="col" className="money-num">
                {t('Result')}
              </th>
            </tr>
          </thead>
          <tbody>
            {book.sales.map((sale) => (
              <tr key={`${sale.txId}:${sale.assetId}`} data-sale={sale.txId}>
                <th scope="row">
                  {sale.assetId} <span className="money-note">{stamp(sale.disposedAt, timeZone)}</span>
                </th>
                <td className="money-num">
                  <Amount value={fmtAmount(sale.qty)} hidden={hidden} />
                </td>
                <td className="money-num">
                  <Amount value={usd(sale.proceedsUsd, copy)} hidden={hidden} />
                </td>
                <td className="money-num">
                  <Amount value={usd(sale.costUsd, copy)} hidden={hidden} />
                </td>
                <td className="money-num" data-col="result">
                  {sale.realizedUsd === null ? (
                    <span>{sale.unmatchedQty !== '0' ? t('Part has no cost') : t('Cost unknown')}</span>
                  ) : (
                    <Amount value={usd(sale.realizedUsd, copy, true)} hidden={hidden} />
                  )}
                  {sale.basisSource === 'customer-entered' ? (
                    <span className="money-note" data-label="customer-entered">
                      {' '}
                      {t('Customer-entered')}
                    </span>
                  ) : null}
                  {missing
                    ? unknownShareOf(missing, sale).map((part, index) => (
                        <span key={`${part.lotId ?? 'no-lot'}:${index}`} className="money-note" data-effect="unknown-share">
                          {' '}
                          {t('Unknown share', { qty: `${hidden ? '••••' : fmtAmount(part.qty)} ${part.assetId}` })}
                        </span>
                      ))
                    : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/** Where the value on arrival came from, in words: the market, the candle size and when that candle started. */
function priceSource(lot: LotBookLot, copy: Copy, timeZone: Parameters<typeof stamp>[1]): string {
  const v = lot.valuedAt;
  if (v === null) return '';
  const frame = v.timeframe === '1m' ? copy.t('Candle minute') : v.timeframe === '1h' ? copy.t('Candle hour') : copy.t('Candle day');
  return copy.t('Price source', { market: v.market, frame, time: v.candleAt === null ? '' : stamp(v.candleAt, timeZone) });
}

function LotRows({
  book,
  search,
  hidden,
  copy,
  onRemove,
}: {
  book: LotBook;
  search: string;
  hidden: boolean;
  copy: Copy;
  onRemove: (lotId: string) => Promise<BasisOutcome>;
}) {
  const { t } = copy;
  const { timeZone } = usePreferences();
  const assets = lotAssets(book);
  const asset = lotAssetFromQuery(search, assets);
  if (asset === null) return null;
  const lots = lotsOf(book, asset);
  const choose = (next: string) => {
    const params = new URLSearchParams(search);
    params.set('asset', next);
    navigate(`/money/pnl?${params.toString()}`, true);
  };
  return (
    <section className="money-card" aria-label={t('Lots')}>
      <header className="money-card__head">
        <h2>{t('Lots')}</h2>
        <label className="money-note">
          {t('Lots for')}{' '}
          <select value={asset} onChange={(event) => choose(event.target.value)} aria-label={t('Coin for lots')}>
            {assets.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>
      </header>
      <p className="money-note">{t('Lots rule')}</p>
      <table className="money-table">
        <thead>
          <tr>
            <th scope="col">{t('Acquired')}</th>
            <th scope="col">{t('Source')}</th>
            <th scope="col" className="money-num">
              {t('Quantity')}
            </th>
            <th scope="col" className="money-num">
              {t('Left')}
            </th>
            <th scope="col" className="money-num">
              {t('Cost')}
            </th>
            <th scope="col" className="money-num">
              {t('Cost of what is left')}
            </th>
            <th scope="col" className="money-num">
              {t('Value on arrival')}
            </th>
            <th scope="col" className="money-num">
              {t('Days held')}
            </th>
          </tr>
        </thead>
        <tbody>
          {lots.map((lot) => (
            <tr key={lot.id} data-lot={lot.id} data-source={lot.source}>
              <th scope="row">{stamp(lot.acquiredAt, timeZone)}</th>
              <td data-col="source">{t(SOURCE_COPY[lot.source])}</td>
              <td className="money-num" data-col="qty">
                <Amount value={fmtAmount(lot.qty)} hidden={hidden} />
              </td>
              <td className="money-num" data-col="left">
                <Amount value={fmtAmount(lot.remaining)} hidden={hidden} />
              </td>
              <td className="money-num" data-col="cost">
                {lot.costUsd === null ? <span>{t('Cost unknown')}</span> : <Amount value={usd(lot.costUsd, copy)} hidden={hidden} />}
                {lot.basisSource === 'customer-entered' ? <CustomerEntered lotId={lot.id} copy={copy} onRemove={onRemove} /> : null}
              </td>
              <td className="money-num" data-col="cost-left">
                {lot.remainingCostUsd === null ? (
                  <span>{t('Cost unknown')}</span>
                ) : (
                  <Amount value={usd(lot.remainingCostUsd, copy)} hidden={hidden} />
                )}
              </td>
              <td className="money-num" data-col="arrival">
                {lot.valuedAt === null ? (
                  <span>{lot.source === 'trade' ? t('Bought, cost is what was paid') : t('No price at that time')}</span>
                ) : (
                  <>
                    <Amount value={usd(lot.valuedAt.usd, copy)} hidden={hidden} />
                    <span className="money-note" data-col="price-source">
                      {' '}
                      {priceSource(lot, copy, timeZone)}
                    </span>
                  </>
                )}
              </td>
              <td className="money-num" data-col="days">
                {lot.daysHeld === null ? t('Sold') : String(lot.daysHeld)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="money-note">{t('Term rule unset')}</p>
    </section>
  );
}

/** A lot whose cost is a price the customer entered: labelled so, with our own record beside it, and a way to take it back. */
function CustomerEntered({ lotId, copy, onRemove }: { lotId: string; copy: Copy; onRemove: (lotId: string) => Promise<BasisOutcome> }) {
  const { t } = copy;
  const [busy, setBusy] = useState(false);
  // A removal takes this label away, and the page says so above; only a refusal is said here.
  const [message, setMessage] = useState<string | null>(null);
  return (
    <span className="money-note" data-label="customer-entered">
      {' '}
      {t('Customer-entered')} · {t('Our record unknown')}{' '}
      <Button
        type="button"
        variant="ghost"
        size={28}
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          const result = await onRemove(lotId);
          setBusy(false);
          if (!result.ok) setMessage(basisRefusalWords(result, copy));
        }}
      >
        {t('Remove my price')}
      </Button>
      <span role="status">{message ?? ''}</span>
    </span>
  );
}

export default function Pnl({ search = '' }: { search?: string }) {
  const copy = moneyCopy.useCopy();
  const { t } = copy;
  const { hideBalances } = usePreferences();
  // The link is the one source of the method, so a copied or reloaded link shows what was on screen.
  const asked = useMemo(() => methodFromQuery(search), [search]);
  const method = typeof asked === 'string' ? asked : null;
  const pick = (next: LotMethod) => navigate(`/money/pnl?method=${next}`, true);
  const book = useLotBook(method);
  const missing = useMissingBasis(method);
  const basis = useBasisOverride();
  const missingData = missing.status === 'ready' ? missing.data : null;
  // What a price write did, said once at page level: the form or label that sent it leaves the page when it works.
  const [notice, setNotice] = useState<string | null>(null);
  const setPrice = async (input: Parameters<typeof basis.set>[0]) => {
    const result = await basis.set(input);
    if (result.ok) setNotice(t('Price saved'));
    return result;
  };
  const removePrice = async (lotId: string) => {
    const result = await basis.remove(lotId);
    if (result.ok) setNotice(t('Price removed'));
    return result;
  };
  const portfolio = useMoneyPortfolio();
  const rows = portfolio.status === 'ready' ? portfolio.data.rows : null;
  const view = useMemo(() => (book.status === 'ready' ? pnlView(book.data, rows) : null), [book, rows]);

  let body;
  if (book.status === 'loading') {
    body = <Skeleton width="100%" height={160} className="bg-field" />;
  } else if (book.status === 'error') {
    body = (
      <StateBlock
        kind="error"
        className="money-state"
        title={t('Couldn’t load your profit and loss')}
        onRetry={book.retry}
        retryLabel={t('Try again')}
      />
    );
  } else if (book.status === 'refused' && method === null) {
    body = <StateBlock kind="refused" className="money-state" title={t('Method not offered')} body={t('Method not offered body')} />;
  } else if (book.status === 'refused') {
    const words = refusalCopy(book.code);
    body = (
      <StateBlock
        kind="refused"
        className="money-state"
        title={words.title}
        body={words.body}
        code={words.reference}
        action={words.action}
      />
    );
  } else if (book.status === 'empty' || !view || (book.data.assets.every((a) => a.openQty === '0') && book.data.sales.length === 0)) {
    body = (
      <StateBlock
        kind="empty"
        className="money-state"
        title={t('No trades to measure yet')}
        body={t('No trades to measure body')}
        action={{ label: t('Go to Money'), href: '/money' }}
      />
    );
  } else {
    const reasons = book.data.residuals.flatMap((code) => (RESIDUAL_COPY[code] ? [RESIDUAL_COPY[code]!] : []));
    body = (
      <>
        <div className="money-head">
          <div className="money-head__main">
            <div className="money-label">
              <span>{t('Realised')}</span>
              <InfoTip text={t('Realised rule')} label={t('How realised is worked out')} side="right" />
            </div>
            <p className="money-total" data-figure="realised">
              <Amount value={usd(view.realisedUsd, copy, true)} hidden={hideBalances} />
            </p>
          </div>
          <div className="money-head__main">
            <div className="money-label">
              <span>{t('Unrealised')}</span>
              <InfoTip text={t('Unrealised rule')} label={t('How unrealised is worked out')} side="right" />
            </div>
            <p className="money-total" data-figure="unrealised">
              <Amount value={usd(view.unrealisedUsd, copy, true)} hidden={hideBalances} />
            </p>
          </div>
        </div>
        {reasons.length > 0 ? (
          <ul className="money-note" aria-label={t('Why some figures are not known')}>
            {[...new Set(reasons)].map((key) => (
              <li key={key}>{t(key)}</li>
            ))}
          </ul>
        ) : null}
        <p className="money-note" role="status" data-testid="basis-notice">
          {notice ?? ''}
        </p>
        {missingData ? (
          <MissingCost book={book.data} missing={missingData} hidden={hideBalances} copy={copy} onSave={setPrice} />
        ) : missing.status === 'refused' || missing.status === 'error' ? (
          <section className="money-card" aria-label={t('Missing cost')}>
            <header className="money-card__head">
              <h2>{t('Missing cost')}</h2>
            </header>
            <p className="money-note">
              {t('Missing cost unreadable')}
              {missing.status === 'refused' ? ` ${refusalCopy(missing.code).reference}` : ''}
            </p>
          </section>
        ) : null}
        <AssetRows assets={view.assets} hidden={hideBalances} copy={copy} />
        <SaleRows book={book.data} missing={missingData} hidden={hideBalances} copy={copy} />
        <LotRows book={book.data} search={search} hidden={hideBalances} copy={copy} onRemove={removePrice} />
      </>
    );
  }

  return (
    <div className="if-money if-money--pnl">
      <h1 className="money-title">{t('Profit and loss')}</h1>
      <p className="money-note" data-indicator="true">
        {t('Pnl indicator label')}
      </p>
      <MethodSwitch method={method} onChange={pick} copy={copy} />
      <p className="money-note">{t('Pnl method rule')}</p>
      {body}
      <p className="money-note">
        <a
          href="/money"
          onClick={(event) => {
            event.preventDefault();
            navigate('/money');
          }}
        >
          {t('Back to Money')}
        </a>
      </p>
    </div>
  );
}
