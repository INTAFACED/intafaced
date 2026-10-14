import { Lock } from 'lucide-react';
import type { CardStatus, SampleCard } from '../../../preview/fixtures/card';
import { cardCopy } from './copy';

/**
 * The virtual card. Pure CSS. There is no logo and no card-network mark: both are empty, labelled slots that the brand kit will fill.
 * The number shows only the last four digits.
 */
export function CardVisual({ card, status }: { card: SampleCard; status: CardStatus }) {
  const { t } = cardCopy.useCopy();
  return (
    <div
      className="pv-card__visual"
      data-status={status}
      data-testid="card-visual"
      role="img"
      aria-label={`${card.kind}, ${t('Card number')} •••• ${card.last4}`}
    >
      <div className="pv-card__top">
        <span className="pv-card__slot">{t('Brand slot')}</span>
        <span className="pv-card__kind">{card.kind}</span>
      </div>
      <span className="pv-card__chip" aria-hidden="true" />
      <p className="pv-card__number">•••• •••• •••• {card.last4}</p>
      <div className="pv-card__bottom">
        <div>
          <span className="pv-card__small">{t('Holder')}</span>
          <span className="pv-card__value">{card.holder}</span>
        </div>
        <div>
          <span className="pv-card__small">{t('Expires')}</span>
          <span className="pv-card__value">{card.expires}</span>
        </div>
        <span className="pv-card__slot pv-card__slot--network">{t('Network slot')}</span>
      </div>
      {status === 'frozen' ? (
        <div className="pv-card__frozen">
          <Lock size={18} strokeWidth={2} aria-hidden="true" />
          {t('Frozen overlay')}
        </div>
      ) : null}
    </div>
  );
}
