import { useState } from 'react';
import { Button } from '@intafaced/ui/lit';
import { Sheet } from '@intafaced/ui/lit/templates';
import { displayAmount } from '../../../shared/money';
import { uiCopy } from '../../../shared/ui-copy';
import {
  draftId,
  keys,
  leverageTimes,
  sumDecimals,
  sumKnown,
  type AsOf,
  type OrderIntent,
  type VenueMarket,
  type VenuePreview,
  type VenueUp,
} from '../../../features/trade/venue-api';
import {
  AsOfLine,
  Known,
  OutcomeLine,
  TestMark,
  type ActionResult,
  type RunAction,
  type VenueAccount,
} from '../../../features/trade/venue/VenueKit';
import { builderApprovalLine, builderApproved, carriesBuilderFee } from '../../../features/trade/venue/VenueReview';
import { venueCopy } from '../../../features/trade/venue/venue-copy';
import { futuresVenueCopy } from './venue-copy';
import { venueRiskCopy } from './venue-risk-copy';
import { bpsToPercent, percentOf, type ProjectedVenueTier } from './venue-risk-logic';
import { VenueTierConfirm } from './VenueTierConfirm';

export interface SplitReviewData {
  actionKey: string;
  orders: OrderIntent[];
  previews: AsOf<VenuePreview>[];
  priceCorrected: { asked: string; applied: string } | null;
  tier: ProjectedVenueTier | null;
}

/**
 * Review and Confirm sheet for orders split to stay within the venue's max order cap (J-derivatives-02 #5). Signs once
 * via `place_orders`, keeping one action key and one child key per part, and gates Confirm on tier acceptance when the
 * combined size crosses a margin tier (#6).
 */
export function VenueSplitReview({
  data,
  side,
  market,
  status,
  account,
  owner,
  run,
  result,
  onConfirm,
  onClose,
}: {
  data: SplitReviewData;
  side: 'buy' | 'sell';
  market: VenueMarket;
  status: VenueUp;
  account: VenueAccount;
  owner: string;
  run: RunAction;
  result: ActionResult | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { t } = venueRiskCopy.useCopy();
  const f = futuresVenueCopy.useCopy().t;
  const v = venueCopy.useCopy().t;
  const { t: ui, languageFor: uiLanguage } = uiCopy.useCopy();
  const [tierAccepted, setTierAccepted] = useState(false);
  const [approving, setApproving] = useState<ActionResult | null>(null);
  const [approvalDraft] = useState(() => draftId());
  const [busy, setBusy] = useState(false);

  const first = data.previews[0]!;
  const carries = data.previews.some((p) => carriesBuilderFee(p.value.builderFee));
  const approved = carries ? builderApproved(account, status) : true;
  const lockTotal = sumDecimals(data.previews.map((p) => p.value.lock.amount));
  const venueFeeTotal = sumKnown(
    data.previews.map((p) =>
      p.value.venueFee.known ? { known: true as const, value: p.value.venueFee.value.amount } : { known: false as const },
    ),
  );
  const builderFeeTotal = sumKnown(
    data.previews.map((p) =>
      p.value.builderFee.known ? { known: true as const, value: p.value.builderFee.value.amount } : { known: false as const },
    ),
  );
  const marginTotal = sumKnown(data.previews.map((p) => p.value.perpetual?.initialMargin ?? { known: false as const }));
  const perp = first.value.perpetual;
  const needsTier = data.tier?.confirmRequired === true;
  const band = market.priceBand?.known ? market.priceBand.value : null;

  async function approve() {
    if (!status.builder || busy) return;
    setBusy(true);
    const answer = await run(
      { kind: 'approve_builder_fee', builder: status.builder.address, maxFeeBps: status.builder.feeBps },
      { actionKey: keys.builderApproval(owner, status.builder.address, status.builder.feeBps, undefined, approvalDraft) },
    );
    setBusy(false);
    setApproving(answer);
    account.reload();
  }

  const sideWord = side === 'buy' ? f('Long').toLowerCase() : f('Short').toLowerCase();
  const confirmLabel = side === 'buy' ? f('Open long') : f('Open short');

  return (
    <Sheet
      open
      title={t('Split review title', { parts: String(data.orders.length), side: sideWord })}
      onClose={onClose}
      closeLabel={ui('closeDialog')}
      closeLang={uiLanguage('closeDialog')}
    >
      <div data-testid="venue-split-review" className="lt-stack">
        <TestMark test={status.test} />
        <dl className="lt-kv">
          <div>
            <dt>{t('Split review row')}</dt>
            <dd data-line="split">
              {t('Split review value', {
                parts: String(data.orders.length),
                venue: status.venue.displayName,
                sizes: data.orders.map((o) => `${o.amount} ${market.baseAsset}`).join(', '),
              })}
            </dd>
          </div>
          {data.priceCorrected ? (
            <div>
              <dt>{t('Price moved')}</dt>
              <dd className="lt-num" data-line="price-moved">
                {t('Price moved value', {
                  asked: data.priceCorrected.asked,
                  applied: data.priceCorrected.applied,
                  quote: market.quoteAsset,
                })}
              </dd>
            </div>
          ) : null}
          {band ? (
            <div>
              <dt>{t('Price band')}</dt>
              <dd className="lt-num" data-line="price-band">
                {t('Price band range', {
                  low: displayAmount(band.bandLow),
                  high: displayAmount(band.bandHigh),
                  quote: market.quoteAsset,
                  width: bpsToPercent(band.widthBps),
                })}
              </dd>
            </div>
          ) : null}
          <div>
            <dt>{v('Venue locks')}</dt>
            <dd className="lt-num" data-line="lock">
              {displayAmount(lockTotal)} {first.value.lock.asset}
            </dd>
          </div>
          <div>
            <dt>{f('Initial margin')}</dt>
            <dd className="lt-num" data-line="initial-margin">
              <Known value={marginTotal === null ? { known: false } : { known: true, value: marginTotal }} /> {market.quoteAsset}
            </dd>
          </div>
          <div>
            <dt>{v('Venue fee')}</dt>
            <dd className="lt-num" data-line="venue-fee">
              <Known value={venueFeeTotal === null ? { known: false } : { known: true, value: venueFeeTotal }} /> {market.quoteAsset}
            </dd>
          </div>
          <div>
            <dt>{v('Our builder fee')}</dt>
            <dd className="lt-num" data-line="builder-fee">
              <Known value={builderFeeTotal === null ? { known: false } : { known: true, value: builderFeeTotal }} /> {market.quoteAsset}
            </dd>
          </div>
          {data.tier ? (
            <div>
              <dt>{t('Margin tier')}</dt>
              <dd data-line="margin-tier">
                {t('Margin tier value', {
                  tier: String(data.tier.projected),
                  rate: percentOf(data.tier.maintenanceRate),
                  maxLeverage: String(data.tier.maxLeverageBps / 10_000),
                })}
              </dd>
            </div>
          ) : null}
          <div>
            <dt>{v('Builder approval')}</dt>
            <dd data-line="builder-approval">
              {v(builderApprovalLine(status.builder !== null, approved, carries), { bps: status.builder?.feeBps ?? '' })}
            </dd>
          </div>
        </dl>
        <AsOfLine asOf={first.asOf} />
        {approved === false ? (
          <Button tone="primary" disabled={busy} onClick={() => void approve()}>
            {v('Approve in wallet')}
          </Button>
        ) : null}
        <OutcomeLine result={approving} owner={owner} />
        {needsTier && data.tier && perp ? (
          <VenueTierConfirm
            symbol={market.symbol}
            tier={data.tier}
            leverageTimes={leverageTimes(perp.leverageBps)}
            accepted={tierAccepted}
            onAccept={setTierAccepted}
          />
        ) : null}
        <Button
          tone="primary"
          disabled={
            approved !== true ||
            (needsTier && !tierAccepted) ||
            (result !== null && result.kind !== 'rejected' && result.kind !== 'wallet_failed')
          }
          onClick={onConfirm}
        >
          {confirmLabel}
        </Button>{' '}
        <Button tone="secondary" onClick={onClose}>
          {v('Close review')}
        </Button>
        <OutcomeLine result={result} owner={owner} />
      </div>
    </Sheet>
  );
}
