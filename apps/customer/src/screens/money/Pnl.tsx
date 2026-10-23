import { useMemo, useState } from 'react';
import { InfoTip } from './InfoTip';
import { moneyCopy } from './copy';
import { Amount, Button, Skeleton, StateBlock, fmtAmount, fmtPct, fmtUsd, navigate, refusalCopy, type Loadable } from './deps';
import {
  LOT_METHODS,
  assetCustomerEntered,
  coinMethod,
  lotAssetFromQuery,
  lotAssets,
  lotsOf,
  methodFromQuery,
  pickableLots,
  pnlView,
  unknownShareOf,
  type AssetPnl,
  type LotBook,
  type LotBookLot,
  type LotBookSale,
  type LotMethod,
  type LotMethodSource,
  type UnknownReason,
} from './pnl-model';
import { useLotBasis, useLotBook, useSaveLotChoice, type LotChoice } from './pnl-source';
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

type Save = (choice: LotChoice) => Promise<void>;

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
    setMessage(result.ok ? copy.t('Choice saved') : refusalCopy(result.code).title);
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

function AssetRows({ book, assets, hidden, copy }: { book: LotBook; assets: readonly AssetPnl[]; hidden: boolean; copy: Copy }) {
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
                {a.costUsd !== null && assetCustomerEntered(book, a.asset) ? <CustomerEntered copy={copy} /> : null}
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

function SaleRows({ book, hidden, copy, save, busy }: { book: LotBook; hidden: boolean; copy: Copy; save: Save | null; busy: boolean }) {
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
                  {sale.customerEntered ? <CustomerEntered copy={copy} /> : null}
                  <UnknownShare book={book} sale={sale} hidden={hidden} copy={copy} />
                </td>
                <td data-col="method">
                  <span data-method={sale.method}>{t(METHOD_COPY[sale.method])}</span>{' '}
                  <span className="money-note">{t(METHOD_SOURCE_COPY[sale.methodSource])}</span>
                  {save !== null ? <LotPick book={book} sale={sale} save={save} busy={busy} copy={copy} /> : null}
                  {sale.pickedLotId === null && savedPick(book, sale) ? <span className="money-note"> {t('Pick not used')}</span> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/** Every figure that uses a price the customer entered says so. */
function CustomerEntered({ copy }: { copy: Copy }) {
  return (
    <span className="money-note" data-customer-entered="true">
      {' '}
      {copy.t('Customer-entered')}
    </span>
  );
}

/** The part of a sale with no cost: how much and what it brought in. Its result is not worked out from a made-up cost. */
function UnknownShare({ book, sale, hidden, copy }: { book: LotBook; sale: LotBookSale; hidden: boolean; copy: Copy }) {
  const share = unknownShareOf(book, sale);
  if (share === null) return null;
  const qty = `${fmtAmount(share.unknownQty)} ${sale.assetId}`;
  return (
    <span className="money-note" data-col="unknown-share">
      {' '}
      {share.unknownProceedsUsd === null ? (
        copy.t('Unknown share no usd', { qty })
      ) : (
        <>
          {copy.t('Unknown share', { qty })} <Amount value={usd(share.unknownProceedsUsd, copy)} hidden={hidden} />
        </>
      )}
    </span>
  );
}

/** The lots with no cost, named at the top, each with a way to enter one. */
function MissingBasisCard({ book, copy, onFix }: { book: LotBook; copy: Copy; onFix: ((lotId: string) => void) | null }) {
  const { t } = copy;
  const { timeZone } = usePreferences();
  const { lots, sales } = book.missingBasis;
  if (lots.length === 0 && sales.length === 0) return null;
  return (
    <section className="money-card" role="status" aria-label={t('Missing cost')}>
      <header className="money-card__head">
        <h2>{t('Missing cost')}</h2>
      </header>
      <p>{lots.length > 0 ? t('Missing cost lead', { count: String(lots.length) }) : t('Missing cost no lot')}</p>
      {lots.length > 0 ? (
        <ul className="money-list">
          {lots.map((lot) => {
            const full = book.lots.find((l) => l.id === lot.lotId);
            return (
              <li key={lot.lotId} data-missing-lot={lot.lotId}>
                {t('Missing lot line', {
                  source: t(SOURCE_COPY[lot.source]),
                  qty: `${fmtAmount(lot.qty)} ${lot.assetId}`,
                  time: full ? stamp(full.acquiredAt, timeZone) : '',
                })}
                {lot.sales.length > 0 ? (
                  <span className="money-note"> {t('Missing lot sales', { count: String(lot.sales.length) })}</span>
                ) : null}{' '}
                {onFix !== null ? (
                  <Button type="button" variant="secondary" size={32} onClick={() => onFix(lot.lotId)}>
                    {t('Enter a cost')}
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      <p className="money-note">{t('Missing cost rule')}</p>
    </section>
  );
}

const PRICE_SHAPE = /^\d+(\.\d{1,18})?$/;

/**
 * The guided form, opened at one lot: our record (no cost), the customer's price and where it comes from, the effect on the
 * result worked out by the service before anything is saved, then save or remove. Nothing here moves a balance.
 */
function BasisSheet({
  book,
  lotId,
  hidden,
  copy,
  onClose,
}: {
  book: LotBook;
  lotId: string;
  hidden: boolean;
  copy: Copy;
  onClose: () => void;
}) {
  const { t } = copy;
  const { timeZone } = usePreferences();
  const basis = useLotBasis();
  const lot = book.lots.find((l) => l.id === lotId) ?? null;
  const [price, setPrice] = useState(lot?.entered?.pricePerUnitUsd ?? '');
  const [note, setNote] = useState(lot?.entered?.note ?? '');
  const [effect, setEffect] = useState<{ price: string; book: LotBook } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  if (lot === null || lot.basis === 'ours') return null;
  const clean = price.trim();
  const valid = PRICE_SHAPE.test(clean) && /[1-9]/.test(clean);
  const refused = (code: string) =>
    code === 'tax.basis_override_not_allowed'
      ? t('Basis ours')
      : code === 'tax.basis_lot_unknown'
        ? t('Basis lot gone')
        : refusalCopy(code).title;
  const tryIt = async () => {
    if (!valid) {
      setMessage(t('Price invalid'));
      return;
    }
    setBusy(true);
    setMessage('');
    const result = await basis.trial(lot.id, clean);
    setBusy(false);
    if (result.ok) setEffect({ price: clean, book: result.data });
    else setMessage(refused(result.code));
  };
  const store = async (next: string | null) => {
    setBusy(true);
    setMessage('');
    const result = await basis.save(lot.id, next, next === null ? '' : note.trim());
    setBusy(false);
    if (!result.ok) {
      setMessage(refused(result.code));
      return;
    }
    setMessage(next === null ? t('Price removed') : t('Price saved'));
    onClose();
  };
  const after = effect !== null && effect.price === clean ? effect.book : null;
  const afterLot = after?.lots.find((l) => l.id === lot.id) ?? null;
  return (
    <section className="money-card" aria-label={t('Enter a cost')} data-basis-form={lot.id}>
      <header className="money-card__head">
        <h2>{t('Enter a cost')}</h2>
      </header>
      <p>
        {t('Missing lot line', {
          source: t(SOURCE_COPY[lot.source]),
          qty: `${fmtAmount(lot.qty)} ${lot.assetId}`,
          time: stamp(lot.acquiredAt, timeZone),
        })}
      </p>
      <p className="money-note" data-col="our-record">
        {t('Basis our record')}
      </p>
      {lot.valuedAt !== null ? (
        <p className="money-note">
          {t('Basis arrival hint')} <Amount value={usd(lot.valuedAt.usd, copy)} hidden={hidden} /> {priceSource(lot, copy, timeZone)}
        </p>
      ) : null}
      <form
        className="money-form"
        onSubmit={(event) => {
          event.preventDefault();
          void tryIt();
        }}
      >
        <label>
          {t('Price per coin', { asset: lot.assetId })}{' '}
          <input
            inputMode="decimal"
            autoComplete="off"
            value={price}
            onChange={(event) => setPrice(event.target.value)}
            aria-label={t('Price per coin', { asset: lot.assetId })}
          />
        </label>
        <label>
          {t('Price note')}{' '}
          <input value={note} maxLength={200} onChange={(event) => setNote(event.target.value)} aria-label={t('Price note')} />
        </label>
        <Button type="submit" variant="secondary" size={40} disabled={busy}>
          {t('See the effect')}
        </Button>
      </form>
      {after !== null ? (
        <dl className="money-note" data-basis-effect="true">
          <dt>{t('Effect lot cost')}</dt>
          <dd data-col="effect-cost">
            <Amount value={usd(afterLot?.costUsd ?? null, copy)} hidden={hidden} /> <CustomerEntered copy={copy} />
          </dd>
          <dt>{t('Effect realised')}</dt>
          <dd data-col="effect-realised">
            <Amount value={usd(book.realizedUsd, copy, true)} hidden={hidden} /> {t('Effect then')}{' '}
            <Amount value={usd(after.realizedUsd, copy, true)} hidden={hidden} />
            {after.realizedCustomerEntered ? <CustomerEntered copy={copy} /> : null}
          </dd>
        </dl>
      ) : null}
      <p>
        <Button type="button" variant="primary" size={40} disabled={busy || after === null} onClick={() => void store(clean)}>
          {t('Save price')}
        </Button>{' '}
        {lot.entered !== null ? (
          <Button type="button" variant="secondary" size={40} disabled={busy} onClick={() => void store(null)}>
            {t('Remove my price')}
          </Button>
        ) : null}{' '}
        <Button type="button" variant="secondary" size={40} disabled={busy} onClick={onClose}>
          {t('Export cancel')}
        </Button>
      </p>
      <p className="money-note" role="status">
        {message}
      </p>
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
        <p className="money-note">
          {t(
            choices.status === 'unavailable'
              ? 'Choices unreadable'
              : choices.code === 'tax.database_pool_max_unset'
                ? 'Choices store misconfigured'
                : 'Choices not saved here',
          )}
        </p>
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
  save,
  busy,
  onFix,
}: {
  book: LotBook;
  search: string;
  hidden: boolean;
  copy: Copy;
  save: Save | null;
  busy: boolean;
  onFix: ((lotId: string) => void) | null;
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
                {lot.basis === 'customer' ? <CustomerEntered copy={copy} /> : null}
                {lot.basis !== 'ours' && onFix !== null ? (
                  <>
                    {' '}
                    <Button type="button" variant="secondary" size={32} onClick={() => onFix(lot.id)}>
                      {lot.basis === 'customer' ? t('Change price') : t('Enter a cost')}
                    </Button>
                  </>
                ) : null}
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

export default function Pnl({ search = '' }: { search?: string }) {
  const copy = moneyCopy.useCopy();
  const { t } = copy;
  const { hideBalances } = usePreferences();
  // The link is the one source of the method, so a copied or reloaded link shows what was on screen.
  const asked = useMemo(() => methodFromQuery(search), [search]);
  const ask = typeof asked === 'string' ? asked : null;
  const pick = (next: LotMethod) => navigate(`/money/pnl?method=${next}`, true);
  const book = useLotBook(ask);
  const saver = useChoiceSaver(copy);
  const [basisLot, setBasisLot] = useState<string | null>(null);
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
    // A price can be entered on the saved book only, where it can be stored.
    const onFix = canChoose
      ? (lotId: string) => {
          setBasisLot(lotId);
          const lot = data.lots.find((l) => l.id === lotId);
          if (lot) {
            const params = new URLSearchParams(search);
            params.set('asset', lot.assetId);
            navigate(`/money/pnl?${params.toString()}`, true);
          }
        }
      : null;
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
                  void saver
                    .save({ procedure: 'setLotMethod', input: { assetId: null, method: data.method } })
                    .then(() => navigate('/money/pnl', true))
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
            {data.realizedCustomerEntered ? (
              <p className="money-note" data-customer-entered="true">
                {t('Uses your price')}
              </p>
            ) : null}
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
        <MissingBasisCard book={data} copy={copy} onFix={onFix} />
        <AssetRows book={data} assets={view.assets} hidden={hideBalances} copy={copy} />
        <SaleRows book={data} hidden={hideBalances} copy={copy} save={save} busy={saver.busy} />
        {basisLot !== null && canChoose ? (
          <BasisSheet key={basisLot} book={data} lotId={basisLot} hidden={hideBalances} copy={copy} onClose={() => setBasisLot(null)} />
        ) : null}
        <LotRows book={data} search={search} hidden={hideBalances} copy={copy} save={save} busy={saver.busy} onFix={onFix} />
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
