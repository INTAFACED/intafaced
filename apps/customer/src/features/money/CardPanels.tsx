import type { z } from 'zod';
import { Button } from '../../shared/ui';
import { DepthPanel, DisabledAction, Fact, UnknownSwitch } from './DepthParts';
import { buildIssueInput, issuedMatches, limitProblem, maskedPan, orderBlock, type ProgrammeInfo } from './card-controls';
import { cardDepthCopy } from './card-depth-copy';
import { bps, funds, positiveMoney, type ActionSpec } from './components';
import type { cardSchema } from './contracts';
import { assetSelectField, type HeldAsset } from './holdings';
import { t as copyText } from './copy';
import './bank-depth.css';

type CardRecord = z.infer<typeof cardSchema>;

/** The card as the customer pictures it. Only facts the card service returned are drawn on it. */
export function CardFace({ card }: { card: CardRecord }) {
  const { t } = cardDepthCopy.useCopy();
  const state = card.status === 'frozen' ? t('faceFrozen') : card.status === 'closed' ? t('faceClosed') : t('faceActive');
  return (
    <div
      className="bd-card"
      data-status={card.status}
      data-test={card.simulated ? 'true' : undefined}
      role="img"
      aria-label={`${maskedPan(card.panTail)} ${state}`}
    >
      <div className="bd-card__top">
        <strong>INTAFACED</strong>
        <span className="bd-card__state">{card.simulated ? t('faceTest') : state}</span>
      </div>
      <div className="bd-card__pan" lang="zxx" dir="ltr">
        {maskedPan(card.panTail)}
      </div>
      <div className="bd-card__bottom">
        <span>{t('faceVirtual')}</span>
        <span lang="zxx" dir="ltr">
          {card.assetId ? t('faceFunding', { asset: card.assetId }) : ''}
        </span>
      </div>
    </div>
  );
}

/** Order a card: wired to `cards.issue` on a live programme, otherwise complete and disabled with the reason. */
export function OrderCard({
  open,
  programme,
  assets,
}: {
  open: (spec: ActionSpec) => void;
  programme: ProgrammeInfo | undefined;
  assets: HeldAsset[] | undefined;
}) {
  const { t } = cardDepthCopy.useCopy();
  const block = orderBlock(programme, assets?.length);
  const reason =
    block === 'loading'
      ? t('blockLoading')
      : block === 'none'
        ? t('blockNone')
        : block === 'simulated'
          ? t('blockSimulated')
          : block === 'noAssets'
            ? t('blockNoAssets')
            : null;
  const order = () => {
    if (block !== null || !assets) return;
    open({
      title: t('orderTitle'),
      procedure: 'cards.issue',
      fields: [
        assetSelectField(t('orderFunding'), t('orderFundingHint'), assets, 'assetId'),
        {
          ...positiveMoney(undefined, 'perAuthorizationLimit', t('orderLimit')),
          hint: undefined,
          validate: (value) => (limitProblem(value) ? copyText('components.enter.an.exact.decimal.amount.greater.than') : null),
        },
      ],
      notes: [t('orderLead'), t('orderNote')],
      submit: t('orderButton'),
      input: (values, requestId) => buildIssueInput(requestId, values),
      verifyOutcome: issuedMatches,
    });
  };
  return (
    <DepthPanel title={t('orderTitle')} lead={t('orderLead')} id="order-card">
      <div className="bd-choice-row" role="group" aria-label={t('orderTitle')}>
        <div className="bd-choice bd-choice--on">
          <strong>{t('orderVirtual')}</strong>
          <span className="money-caption">{t('orderVirtualBody')}</span>
        </div>
        <div className="bd-choice bd-choice--off" aria-disabled="true">
          <strong>{t('orderPhysical')}</strong>
          <span className="money-caption">{t('orderPhysicalReason')}</span>
        </div>
      </div>
      <div className="actions">
        <Button onClick={order} disabled={block !== null} aria-describedby={reason ? 'order-card-why' : undefined}>
          {t('orderButton')}
        </Button>
      </div>
      {reason && (
        <p id="order-card-why" className="money-caption" role="status">
          {reason}
        </p>
      )}
    </DepthPanel>
  );
}

/** Everything else a card owner expects, laid out in full. Each control states why it cannot be used yet. */
export function CardControlPanels({ card }: { card: CardRecord }) {
  const { t } = cardDepthCopy.useCopy();
  return (
    <div className="bd-grid" data-card={card.id}>
      <DepthPanel title={t('limitsTitle')}>
        <dl className="bd-facts">
          <Fact label={t('limitPerPurchase')}>
            <span className="numeric" lang="zxx" dir="ltr">
              {card.assetId ? funds(card.perAuthorizationLimit, card.assetId) : '—'}
            </span>
          </Fact>
          <Fact label={t('rewardsRate')}>{card.cashbackBps > 0 ? bps(card.cashbackBps) : t('rewardsRateNone')}</Fact>
        </dl>
        <DisabledAction label={t('limitEdit')} reason={t('limitEditReason')} />
        <p className="money-caption">{t('limitOtherReason')}</p>
      </DepthPanel>
      <DepthPanel title={t('channelsTitle')}>
        <UnknownSwitch label={t('channelOnline')} state={t('channelState')} />
        <UnknownSwitch label={t('channelContactless')} state={t('channelState')} />
        <UnknownSwitch label={t('channelAtm')} state={t('channelState')} />
        <UnknownSwitch label={t('channelAbroad')} state={t('channelState')} />
        <p className="money-caption">{t('channelsReason')}</p>
      </DepthPanel>
      <DepthPanel title={t('detailsTitle')}>
        <dl className="bd-facts">
          <Fact label={t('lastFour')}>
            <span lang="zxx" dir="ltr">
              {maskedPan(card.panTail)}
            </span>
          </Fact>
          <Fact label={t('fundingLabel')}>
            <span lang="zxx" dir="ltr">
              {card.assetId || '—'}
            </span>
          </Fact>
        </dl>
        <DisabledAction label={t('detailsShow')} reason={t('detailsReason')} />
      </DepthPanel>
      <DepthPanel title={t('pinTitle')}>
        <div className="actions">
          <DisabledAction label={t('pinView')} reason={t('pinReason')} />
          <DisabledAction label={t('pinChange')} reason={t('pinReason')} />
        </div>
      </DepthPanel>
      <DepthPanel title={t('walletTitle')}>
        <div className="actions">
          <DisabledAction label={t('walletApple')} reason={t('walletReason')} />
          <DisabledAction label={t('walletGoogle')} reason={t('walletReason')} />
        </div>
      </DepthPanel>
      <DepthPanel title={t('rewardsTitle')}>
        <dl className="bd-facts">
          <Fact label={t('rewardsBalance')}>{t('disabledBecause')}</Fact>
        </dl>
        <p className="money-caption">{t('rewardsReason')}</p>
      </DepthPanel>
      <DepthPanel title={t('replaceTitle')}>
        <p>{t('replaceBody')}</p>
        <a className="button button--secondary" href="#order-card">
          {t('orderButton')}
        </a>
      </DepthPanel>
    </div>
  );
}
