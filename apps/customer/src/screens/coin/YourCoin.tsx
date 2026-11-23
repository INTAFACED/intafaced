import { coinCopy } from './copy';
import { positionOf } from './coin-math';
import {
  Amount,
  dec,
  fmtAmount,
  fmtUsd,
  fmtUsdChange,
  isHiddenPath,
  LinkButton,
  Money,
  useLotBook,
  usePreferences,
  type Holding,
} from './deps';

/**
 * "Your {BASE}" (UI-SPEC 5.5): only for a coin the person holds. The amount, its value, what is free and what is set
 * aside for orders, and Send and Convert (each only while that page is live).
 */
export function YourCoin({ asset, holding }: { asset: string; holding: Holding }) {
  const { t } = coinCopy.useCopy();
  const { hideBalances } = usePreferences();
  const actions = [
    { label: t('Send'), href: '/pay/send', path: '/pay/send' },
    { label: t('Convert'), href: `/trade/convert?from=${encodeURIComponent(asset)}`, path: '/trade/convert' },
  ].filter((action) => !isHiddenPath(action.path));
  return (
    <section className="lt-stack" aria-label={t('Your {asset}', { asset })} data-testid="your-coin">
      <div className="lt-lines">
        <h2 data-testid="coin-h2">{t('Your {asset}', { asset })}</h2>
        <span className="lt-figure">
          <Amount value={`${fmtAmount(holding.total, { places: 8 })} ${asset}`} hidden={hideBalances} />
        </span>
        <Money value={holding.usdValue === null ? null : fmtUsd(holding.usdValue)} hidden={hideBalances} testId="coin-yours__value" />
      </div>
      <dl className="lt-kv">
        <div>
          <dt>{t('Available')}</dt>
          <dd>
            <Amount value={`${fmtAmount(holding.available, { places: 8 })} ${asset}`} hidden={hideBalances} />
          </dd>
        </div>
        <div>
          <dt>{t('In orders')}</dt>
          <dd>
            <Amount value={`${fmtAmount(holding.inOrders, { places: 8 })} ${asset}`} hidden={hideBalances} />
          </dd>
        </div>
      </dl>
      <CoinPosition asset={asset} priceUsd={holding.priceUsd ?? null} />
      {actions.length > 0 ? (
        <div className="lt-actions">
          {actions.map((action) => (
            <LinkButton key={action.path} href={action.href}>
              {action.label}
            </LinkButton>
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
  const { hideBalances } = usePreferences();
  const book = useLotBook('saved');
  const row = book.status === 'ready' ? (book.data.assets.find((entry) => entry.assetId === asset) ?? null) : null;
  const position = row ? positionOf(row, priceUsd) : null;
  const usd = (value: string | null) => (value === null ? t('Not known') : fmtUsd(value));
  return (
    <section className="lt-stack" data-testid="coin-position" aria-label={t('Your position')}>
      <h3>{t('Your position')}</h3>
      {book.status === 'loading' ? (
        <p className="lt-hint">{t('Reading your lot book')}</p>
      ) : book.status !== 'ready' ? (
        <p className="lt-hint" role="status">
          {t('Your lot book could not be read')}
        </p>
      ) : position === null ? (
        <p className="lt-hint" role="status">
          {row && (dec(row.uncountedQty) ?? 0n) > 0n ? t('Lots left out of {asset}', { asset }) : t('No open lots of {asset}', { asset })}
        </p>
      ) : (
        <>
          <dl className="lt-kv">
            <div>
              <dt>{t('Quantity')}</dt>
              <dd data-figure="quantity">
                <Amount value={`${fmtAmount(position.quantity, { places: 8 })} ${asset}`} hidden={hideBalances} />
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
          <p className="lt-hint">{t('Position note')}</p>
        </>
      )}
    </section>
  );
}
