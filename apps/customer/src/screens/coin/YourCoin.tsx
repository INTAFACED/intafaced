import { coinCopy } from './copy';
import { Amount, Button, fmtAmount, fmtUsd, isHiddenPath, Money, type Holding } from './deps';

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
