import { useMemo, useState } from 'react';
import { InfoTip } from './InfoTip';
import { moneyCopy } from './copy';
import { Amount, Button, Skeleton, StateBlock, fmtAmount, fmtPct, fmtUsd, navigate, refusalCopy, type Loadable } from './deps';
import { MissingCost, basisRefusalWords } from './MissingCost';
import {
  LOT_METHODS,
  coinMethod,
  lotAssetFromQuery,
  lotAssets,
  lotsOf,
  methodFromQuery,
  pickableLots,
  pnlView,
  type AssetPnl,
  type LotBook,
  type LotBookLot,
  type LotBookSale,
  type LotMethod,
  type MissingBasis,
  type LotMethodSource,
  type UnknownReason,
  unknownShareOf,
} from './pnl-model';
import { useBasisOverride, useLotBook, useMissingBasis, useSaveLotChoice, type BasisOutcome, type LotChoice } from './pnl-source';
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

const METHOD_SOURCE_COPY: Record<
  LotMethodSource,
  'Method from preview' | 'Method from day' | 'Method from coin' | 'Method from account' | 'Method from default'
> = {
  preview: 'Method from preview',
  day: 'Method from day',
  asset: 'Method from coin',
  account: 'Method from account',
  default: 'Method from default',
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

/** True when the choice was saved. */
type Save = (choice: LotChoice) => Promise<boolean>;

/** The service's refusals for a choice, in the screen's words; anything else goes through the shared refusal copy. */
const CHOICE_REFUSAL: Record<string, 'Pick refused' | 'Choices not saved here' | 'Method not offered'> = {
  'tax.lot_pick_invalid': 'Pick refused',
  'tax.basis_store_unwired': 'Choices not saved here',
  'tax.lot_method_required': 'Method not offered',
};

/** Saves a choice and says how it went in one status line. The book reads itself again after a save. */
function useChoiceSaver(copy: Copy): { save: Save; busy: boolean; message: string } {
  const send = useSaveLotChoice();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const save: Save = async (choice) => {
    setBusy(true);
    setMessage('');
    const result = await send(choice);
    setBusy(false);
    const refusal = result.ok ? undefined : CHOICE_REFUSAL[result.code];
    setMessage(
      result.ok
        ? copy.t('Choice saved')
        : result.unsure
          ? copy.t('Choice unsure')
          : refusal
            ? copy.t(refusal)
            : refusalCopy(result.code).title,
    );
    return result.ok;
  };
  return { save, busy, message };
}

/** Today as a UTC calendar day, the form the day choice is saved in. */
const utcToday = () => new Date().toISOString().slice(0, 10);

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

function SaleRows({
  book,
  missing,
  hidden,
  copy,
  save,
  busy,
}: {
  book: LotBook;
  missing: MissingBasis | null;
  hidden: boolean;
  copy: Copy;
  save: Save | null;
  busy: boolean;
}) {
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
              <th scope="col">{t('Matched by')}</th>
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
                          {t('Unknown share', { qty: `${fmtAmount(part.qty)} ${part.assetId}` })}
                        </span>
                      ))
                    : null}
                </td>
                <td data-col="method">
                  <span data-method={sale.method}>{t(METHOD_COPY[sale.method])}</span>{' '}
                  <span className="money-note">{t(METHOD_SOURCE_COPY[sale.methodSource])}</span>
                  {/* At the average cost no one lot sets the cost, so no pick is offered; a saved one can still be cleared. */}
                  {save !== null && (sale.method !== 'AVERAGE' || savedPick(book, sale)) ? (
                    <LotPick book={book} sale={sale} save={save} busy={busy} copy={copy} />
                  ) : null}
                  {!book.preview && sale.pickedLotId === null && savedPick(book, sale) ? (
                    <span className="money-note"> {t('Pick not used')}</span>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/** The lot the customer saved for this sale, if any. */
function savedPick(book: LotBook, sale: LotBookSale) {
  return book.choices.status === 'saved'
    ? book.choices.picks.find((p) => p.saleTxId === sale.txId && p.assetId === sale.assetId)
    : undefined;
}

/** Which lot one sale draws on first. "By method" clears the pick. */
function LotPick({ book, sale, save, busy, copy }: { book: LotBook; sale: LotBookSale; save: Save; busy: boolean; copy: Copy }) {
  const { t } = copy;
  const { timeZone } = usePreferences();
  const saved = savedPick(book, sale);
  const lots = pickableLots(book, sale);
  // A saved pick that can no longer be used stays listed, so the control shows what is saved and can clear it.
  const stale = saved && !lots.some((lot) => lot.id === saved.lotId) ? book.lots.find((lot) => lot.id === saved.lotId) : undefined;
  return (
    <select
      className="money-note"
      aria-label={t('Lot for this sale')}
      value={saved?.lotId ?? ''}
      disabled={busy}
      onChange={(event) =>
        void save({
          procedure: 'pickSaleLot',
          input: { saleTxId: sale.txId, assetId: sale.assetId, lotId: event.target.value === '' ? null : event.target.value },
        })
      }
    >
      <option value="">{t('By method')}</option>
      {(stale ? [...lots, stale] : lots).map((lot) => (
        <option key={lot.id} value={lot.id}>
          {t('Lot option', { time: stamp(lot.acquiredAt, timeZone), qty: fmtAmount(lot.qty), source: t(SOURCE_COPY[lot.source]) })}
        </option>
      ))}
      {/* A saved lot that is no longer in the book at all still shows, so it can be cleared. */}
      {saved && !stale && !lots.some((lot) => lot.id === saved.lotId) ? <option value={saved.lotId}>{t('Lot gone')}</option> : null}
    </select>
  );
}

/** The customer's saved choices: the method for every coin, and a method for one day. A coin's method is on its lots. */
function ChoicesCard({ book, save, busy, message, copy }: { book: LotBook; save: Save; busy: boolean; message: string; copy: Copy }) {
  const { t } = copy;
  const [day, setDay] = useState(utcToday);
  const [dayAsset, setDayAsset] = useState('');
  const [dayMethod, setDayMethod] = useState<LotMethod>('FIFO');
  const choices = book.choices;
  return (
    <section className="money-card" aria-label={t('Your matching choices')}>
      <header className="money-card__head">
        <h2>{t('Your matching choices')}</h2>
      </header>
      {choices.status !== 'saved' ? (
        <p className="money-note">{t(choices.status === 'unavailable' ? 'Choices unreadable' : 'Choices not saved here')}</p>
      ) : (
        <>
          <label className="money-note">
            {t('Method for all coins')}{' '}
            <select
              aria-label={t('Method for all coins')}
              value={choices.accountMethod ?? book.method}
              disabled={busy}
              onChange={(event) =>
                void save({ procedure: 'setLotMethod', input: { assetId: null, method: event.target.value as LotMethod } })
              }
            >
              {LOT_METHODS.map((m) => (
                <option key={m} value={m}>
                  {t(METHOD_COPY[m])}
                </option>
              ))}
            </select>
          </label>
          <p className="money-note">{t('Choices rule')}</p>
          <form
            className="money-note-form"
            aria-label={t('Method for one day')}
            onSubmit={(event) => {
              event.preventDefault();
              void save({ procedure: 'setDayMethod', input: { day, assetId: dayAsset === '' ? null : dayAsset, method: dayMethod } });
            }}
          >
            <span className="money-note">{t('Method for one day')}</span>{' '}
            <input type="date" aria-label={t('Day in UTC')} value={day} required onChange={(event) => setDay(event.target.value)} />{' '}
            <select aria-label={t('Coin for that day')} value={dayAsset} onChange={(event) => setDayAsset(event.target.value)}>
              <option value="">{t('All coins')}</option>
              {lotAssets(book).map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>{' '}
            <select
              aria-label={t('Method for that day')}
              value={dayMethod}
              onChange={(event) => setDayMethod(event.target.value as LotMethod)}
            >
              {LOT_METHODS.map((m) => (
                <option key={m} value={m}>
                  {t(METHOD_COPY[m])}
                </option>
              ))}
            </select>{' '}
            <Button type="submit" variant="secondary" size={40} disabled={busy}>
              {t('Save day method')}
            </Button>
          </form>
          {choices.days.length > 0 ? (
            <ul className="money-note" aria-label={t('Saved day methods')}>
              {choices.days.map((d) => (
                <li key={`${d.day}:${d.assetId ?? '*'}`} data-day={d.day}>
                  {t('Day method line', { day: d.day, coin: d.assetId ?? t('All coins'), method: t(METHOD_COPY[d.method]) })}{' '}
                  <button
                    type="button"
                    className="money-alloc__opt"
                    disabled={busy}
                    onClick={() => void save({ procedure: 'setDayMethod', input: { day: d.day, assetId: d.assetId, method: null } })}
                  >
                    {t('Remove')}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}
      <p className="money-note" role="status">
        {message}
      </p>
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
  save,
  busy,
}: {
  book: LotBook;
  search: string;
  hidden: boolean;
  copy: Copy;
  onRemove: (lotId: string) => Promise<BasisOutcome>;
  save: Save | null;
  busy: boolean;
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
        {save !== null ? (
          <label className="money-note">
            {t('Method for coin', { asset })}{' '}
            <select
              aria-label={t('Method for coin', { asset })}
              value={coinMethod(book, asset) ?? ''}
              disabled={busy}
              onChange={(event) =>
                void save({
                  procedure: 'setLotMethod',
                  input: { assetId: asset, method: event.target.value === '' ? null : (event.target.value as LotMethod) },
                })
              }
            >
              <option value="">{t('Same as all coins')}</option>
              {LOT_METHODS.map((m) => (
                <option key={m} value={m}>
                  {t(METHOD_COPY[m])}
                </option>
              ))}
            </select>
          </label>
        ) : null}
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
  const ask = typeof asked === 'string' ? asked : null;
  const pick = (next: LotMethod) => navigate(`/money/pnl?method=${next}`, true);
  const book = useLotBook(ask);
  const missing = useMissingBasis(ask);
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
  const saver = useChoiceSaver(copy);
  // The switch shows the method on screen: the previewed one, else the account's saved (or default) method.
  const method = ask !== 'saved' ? ask : book.status === 'ready' ? book.data.method : null;
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
  } else if (book.status === 'refused' && ask === null) {
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
    const data = book.data;
    // Choices are made on the saved book, never on a preview, and only where they can be saved.
    const canChoose = !data.preview && data.choices.status === 'saved';
    const save = canChoose ? saver.save : null;
    body = (
      <>
        {data.preview ? (
          <div className="money-note" role="note" aria-label={t('Preview')}>
            <p>{t('Preview note', { method: t(METHOD_COPY[data.method]) })}</p>
            {data.choices.status === 'saved' ? (
              <Button
                type="button"
                variant="secondary"
                size={40}
                disabled={saver.busy}
                onClick={() =>
                  void saver.save({ procedure: 'setLotMethod', input: { assetId: null, method: data.method } }).then((saved) => {
                    if (saved) navigate('/money/pnl', true);
                  })
                }
              >
                {t('Save method for all coins', { method: t(METHOD_COPY[data.method]) })}
              </Button>
            ) : null}{' '}
            <a
              href="/money/pnl"
              onClick={(event) => {
                event.preventDefault();
                navigate('/money/pnl', true);
              }}
            >
              {t('Back to my choices')}
            </a>
          </div>
        ) : null}
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
        <SaleRows book={data} missing={missingData} hidden={hideBalances} copy={copy} save={save} busy={saver.busy} />
        <LotRows book={data} search={search} hidden={hideBalances} copy={copy} onRemove={removePrice} save={save} busy={saver.busy} />
        {data.preview ? null : <ChoicesCard book={data} save={saver.save} busy={saver.busy} message={saver.message} copy={copy} />}
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
