import { useMemo, useState } from 'react';
import { InfoTip } from './InfoTip';
import { moneyCopy } from './copy';
import { Amount, Skeleton, StateBlock, fmtAmount, fmtPct, fmtUsd, navigate, refusalCopy, type Loadable } from './deps';
import { LOT_METHODS, pnlView, type AssetPnl, type LotBook, type LotMethod, type UnknownReason } from './pnl-model';
import { useLotBook } from './pnl-source';
import { useMoneyPortfolio } from './portfolio-source';
import { stamp } from './time';
import { usePreferences } from '../../shared/preferences';

type Copy = ReturnType<typeof moneyCopy.useCopy>;

const REASON_COPY: Record<UnknownReason, 'Cost unknown' | 'No price now' | 'Cost not reconciled'> = {
  cost_unknown: 'Cost unknown',
  no_price: 'No price now',
  not_reconciled: 'Cost not reconciled',
};

const METHOD_COPY: Record<LotMethod, 'Method FIFO' | 'Method LIFO' | 'Method HIFO'> = {
  FIFO: 'Method FIFO',
  LIFO: 'Method LIFO',
  HIFO: 'Method HIFO',
};

/** One plain sentence for each reason the book can name. Codes never reach the screen. */
const RESIDUAL_COPY: Record<string, 'Residual underflow' | 'Residual cost unavailable' | 'Residual unreconciled' | 'Residual incomplete'> =
  {
    'tax.lot_underflow': 'Residual underflow',
    'tax.cost_basis_unavailable': 'Residual cost unavailable',
    'tax.lot_book_unreconciled': 'Residual unreconciled',
    'tax.lot_book_incomplete': 'Residual incomplete',
  };

function usd(value: string | null, copy: Copy, signed = false): string {
  return value === null ? copy.t('Not known') : fmtUsd(value, { showPlus: signed });
}

function MethodSwitch({ method, onChange, copy }: { method: LotMethod; onChange: (next: LotMethod) => void; copy: Copy }) {
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
              <td className="money-num">
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

function SaleRows({ book, hidden, copy }: { book: LotBook; hidden: boolean; copy: Copy }) {
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
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export default function Pnl() {
  const copy = moneyCopy.useCopy();
  const { t } = copy;
  const { hideBalances } = usePreferences();
  const [method, setMethod] = useState<LotMethod>('FIFO');
  const book = useLotBook(method);
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
        <AssetRows assets={view.assets} hidden={hideBalances} copy={copy} />
        <SaleRows book={book.data} hidden={hideBalances} copy={copy} />
      </>
    );
  }

  return (
    <div className="if-money if-money--pnl">
      <h1 className="money-title">{t('Profit and loss')}</h1>
      <p className="money-note" data-indicator="true">
        {t('Pnl indicator label')}
      </p>
      <MethodSwitch method={method} onChange={setMethod} copy={copy} />
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
