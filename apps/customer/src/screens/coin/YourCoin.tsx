import { coinCopy } from './copy';
import { positionOf } from './coin-math';
import { Amount, Button, dec, fmtAmount, fmtUsd, fmtUsdChange, isHiddenPath, Money, useLotBook, type Holding } from './deps';

/**
 * "Your {BASE}" (UI-SPEC 5.5): only for a coin the person holds. The amount, its value, what is free and what is set
 * aside for orders, and Send and Convert (each only while that page is live).
 */
export function YourCoin({ asset, holding }: { asset: string; holding: Holding }) {
  const { t } = coinCopy.useCopy();
  const actions = [
    { label: t('Send'), href: '/pay/send', path: '/pay/send' },
    { label: t('Convert'), href: `/trade/convert?from=${encodeURIComponent(asset)}`, path: '/trade/convert' },
  ].filter((action) => !isHiddenPath(action.path));
  return (
    <section className="coin-card coin-yours" aria-label={t('Your {asset}', { asset })} data-testid="your-coin">
      <div className="coin-yours__main">
        <h2 data-testid="coin-h2" className="coin-h2">
          {t('Your {asset}', { asset })}
        </h2>
        <Amount className="coin-yours__amount" value={`${fmtAmount(holding.total, { places: 8 })} ${asset}`} />
        <Money className="coin-yours__value" value={holding.usdValue === null ? null : fmtUsd(holding.usdValue)} />
      </div>
      <dl className="coin-yours__rows">
        <div>
          <dt>{t('Available')}</dt>
          <dd>
            <Amount value={`${fmtAmount(holding.available, { places: 8 })} ${asset}`} />
          </dd>
        </div>
        <div>
          <dt>{t('In orders')}</dt>
          <dd>
            <Amount value={`${fmtAmount(holding.inOrders, { places: 8 })} ${asset}`} />
          </dd>
        </div>
      </dl>
      <CoinPosition asset={asset} priceUsd={holding.priceUsd ?? null} />
      {actions.length > 0 ? (
        <div className="coin-yours__actions">
          {actions.map((action) => (
            <Button key={action.path} variant="secondary" size={40} nativeButton={false} render={<a href={action.href} />}>
              {action.label}
            </Button>
          ))}
        </div>
      ) : null}
    </section>
  );
}

/**
 * "Your position" (J-portfolio-10 #4): what the open lots of this coin cost, read from the same lot book as Profit and
 * loss (svc-tax `lotBook`, the account's saved method), and what they make at the live price. A cost the book does not
 * know stays unknown, never zero.
 */
function CoinPosition({ asset, priceUsd }: { asset: string; priceUsd: string | null }) {
  const { t } = coinCopy.useCopy();
  const book = useLotBook('saved');
  const row = book.status === 'ready' ? (book.data.assets.find((entry) => entry.assetId === asset) ?? null) : null;
  const position = row ? positionOf(row, priceUsd) : null;
  const usd = (value: string | null) => (value === null ? t('Not known') : fmtUsd(value));
  return (
    <section className="coin-yours__position" data-testid="coin-position" aria-label={t('Your position')}>
      <h3 className="coin-yours__position-title">{t('Your position')}</h3>
      {book.status === 'loading' ? (
        <p className="coin-yours__note">{t('Reading your lot book')}</p>
      ) : book.status !== 'ready' ? (
        <p className="coin-yours__note" role="status">
          {t('Your lot book could not be read')}
        </p>
      ) : position === null ? (
        <p className="coin-yours__note" role="status">
          {row && (dec(row.uncountedQty) ?? 0n) > 0n ? t('Lots left out of {asset}', { asset }) : t('No open lots of {asset}', { asset })}
        </p>
      ) : (
        <>
          <dl className="coin-yours__rows">
            <div>
              <dt>{t('Quantity')}</dt>
              <dd data-figure="quantity">
                <Amount value={`${fmtAmount(position.quantity, { places: 8 })} ${asset}`} />
              </dd>
            </div>
            <div>
              <dt>{t('Average price')}</dt>
              <dd data-figure="average-price">{usd(position.averagePrice)}</dd>
            </div>
            <div>
              <dt>{t('Cost basis')}</dt>
              <dd data-figure="cost-basis">{usd(position.costBasis)}</dd>
            </div>
            <div>
              <dt>{t('Result')}</dt>
              <dd data-figure="result">{position.result === null ? t('Not known') : fmtUsdChange(position.result)}</dd>
            </div>
          </dl>
          <p className="coin-yours__note">{t('Position note')}</p>
        </>
      )}
    </section>
  );
}
