import { useState } from 'react';
import { Button, ReviewDialog as Dialog } from '@intafaced/ui';
import type { ApiResult } from '../../../shared/api';
import { displayAmount } from '../../../shared/money';
import { useResource } from '../../../shared/resource';
import { uiCopy } from '../../../shared/ui-copy';
import { PayDetails, PayFailure } from '../components';
import type { PersonalPayApi } from '../pay-api';
import type { Offer, P2PPostingEligibility, PostOfferInput } from '../schemas';
import { postCopy } from './p2p-post-copy';
import type { OfferFormValues } from './p2p-model';

/**
 * P-ads-merchant-01: what a sell ad may offer, from the same ledger read svc-p2p checks at post. Nothing is held when
 * the ad is posted; each order holds its coins in escrow when it is taken.
 */
export function SellAvailability({ pay, asset }: { pay: PersonalPayApi; asset: string }) {
  const { t } = postCopy.useCopy();
  const balance = useResource((signal) => pay.sellBalance(asset, signal), `pay:p2p-sell-balance:${asset}`);
  return (
    <div className="stack" data-testid="offer-available">
      {balance.resource.status === 'ready' ? (
        <p>{t('available', { amount: displayAmount(balance.resource.data.available), asset })}</p>
      ) : balance.resource.status === 'failed' ? (
        <p className="muted">{t('availableFailed')}</p>
      ) : (
        <p className="muted">{t('availableLoading')}</p>
      )}
      <small className="muted">{t('availableHint')}</small>
      <small className="muted">{t('availableShared')}</small>
    </div>
  );
}

/**
 * P-ads-merchant-02: the per-order band for this person's verification level. A buy ad's orders must fit it (every
 * take of a buy ad meets the maker's level); a sell ad's buyers each meet their own level when they take.
 */
export function LevelLimits({ pay, side }: { pay: PersonalPayApi; side: 'buy' | 'sell' }) {
  const { t } = postCopy.useCopy();
  const limits = useResource((signal) => pay.levelLimits(signal), 'pay:p2p-level-limits');
  const resource = limits.resource;
  return (
    <div className="stack" data-testid="offer-level-limits">
      {resource.status === 'ready' ? (
        <>
          <p>
            {t('levelLimits', {
              level: t(LEVEL_LABEL[resource.data.tier]),
              min: displayAmount(resource.data.orderMin),
              max: displayAmount(resource.data.orderMax),
              currency: resource.data.currency,
            })}
          </p>
          <small className="muted">{t(side === 'buy' ? 'levelBuyHint' : 'levelSellHint')}</small>
        </>
      ) : resource.status === 'failed' ? (
        <LevelLimitsFailure code={resource.failure.code} retry={limits.reload} />
      ) : (
        <p className="muted">{t('levelLoading')}</p>
      )}
    </div>
  );
}

/** The operator's state of the table is said as it is; only a read that failed for another reason offers a retry. */
function LevelLimitsFailure({ code, retry }: { code: string | undefined; retry: () => void }) {
  const { t } = postCopy.useCopy();
  const settled =
    code === 'p2p.verification_limits_unset'
      ? 'levelUnset'
      : code === 'p2p.verification_limits_invalid'
        ? 'levelInvalid'
        : code === 'p2p.verification_level_unwired'
          ? 'levelUnwired'
          : null;
  if (settled) return <p className="muted">{t(settled)}</p>;
  return (
    <p className="muted">
      {t('levelFailed')}{' '}
      <Button variant="ghost" onClick={retry}>
        {t('levelRetry')}
      </Button>
    </p>
  );
}

const LEVEL_LABEL = { none: 'levelNone', basic: 'levelBasic', full: 'levelFull', institutional: 'levelInstitutional' } as const;

/**
 * P-ads-merchant-12: what posting an ad in the chosen fiat needs, read from svc-p2p's checklist, which judges the same
 * checks a post is refused on. Each check shows the person's value and the target.
 */
export function PostingChecklist({ pay, fiatCurrency }: { pay: PersonalPayApi; fiatCurrency: string }) {
  const { t } = postCopy.useCopy();
  return (
    <div className="stack" data-testid="posting-checklist">
      {fiatCurrency === '' ? <p className="muted">{t('checklistPickFiat')}</p> : <PostingChecks pay={pay} fiatCurrency={fiatCurrency} />}
    </div>
  );
}

function PostingChecks({ pay, fiatCurrency }: { pay: PersonalPayApi; fiatCurrency: string }) {
  const { t } = postCopy.useCopy();
  const eligibility = useResource((signal) => pay.postingEligibility(fiatCurrency, signal), `pay:p2p-posting:${fiatCurrency}`);
  const resource = eligibility.resource;
  if (resource.status === 'loading') return <p className="muted">{t('checklistLoading')}</p>;
  if (resource.status === 'failed')
    return (
      <p className="muted">
        {t('checklistFailed')}{' '}
        <Button variant="ghost" onClick={eligibility.reload}>
          {t('levelRetry')}
        </Button>
      </p>
    );
  const { policy, checks } = resource.data;
  return (
    <>
      <p>{t('checklistTitle', { fiat: fiatCurrency })}</p>
      {policy === 'unset' ? <p className="muted">{t('checklistUnset', { fiat: fiatCurrency })}</p> : null}
      {policy === 'invalid' ? <p className="muted">{t('checklistInvalid')}</p> : null}
      {policy === 'none' ? <p className="muted">{t('checklistNone', { fiat: fiatCurrency })}</p> : null}
      {checks.length > 0 ? (
        <ul className="p2p-risk-points">
          {checks.map((check) => (
            <li key={check.id} data-check={check.id} data-state={check.state}>
              <strong>{t(CHECK_LABEL[check.id])}</strong> · {t(STATE_LABEL[check.state])}.{' '}
              {t('checkValues', { current: checkValue(t, check, check.current), required: checkValue(t, check, check.required) })}
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

type Check = P2PPostingEligibility['checks'][number];
const CHECK_LABEL = {
  kyc_tier: 'checkKycTier',
  completed_orders: 'checkCompletedOrders',
  completion_rate: 'checkCompletionRate',
} as const;
const STATE_LABEL = { met: 'checkMet', not_met: 'checkNotMet', unknown: 'checkUnknown' } as const;

/** A check's value in words: the level by name, the rate as a percent. */
function checkValue(t: ReturnType<typeof postCopy.useCopy>['t'], check: Check, value: string | null): string {
  if (value === null) return t('checkNoValue');
  if (check.id === 'kyc_tier' && value in LEVEL_LABEL) return t(LEVEL_LABEL[value as keyof typeof LEVEL_LABEL]);
  if (check.id === 'completion_rate') return `${value}%`;
  return value;
}

/** The advertiser terms, read in full and accepted for the exact version svc-p2p published. */
export function AdvertiserTermsSheet({
  pay,
  version,
  onAccepted,
  onClose,
}: {
  pay: PersonalPayApi;
  version: string;
  onAccepted: (version: string) => void;
  onClose: () => void;
}) {
  const { t } = postCopy.useCopy();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const accept = async () => {
    setBusy(true);
    setFailed(false);
    const result = await pay.acceptAdvertiserTerms(version);
    setBusy(false);
    if (result.ok) onAccepted(result.data.version);
    else setFailed(true);
  };
  return (
    <Dialog closeLabel={uiCopy.t('closeDialog')} title={t('termsTitle')} onClose={() => (busy ? undefined : onClose())}>
      <div className="form-stack" data-testid="advertiser-terms">
        <p className="muted">{t('termsVersion', { version })}</p>
        <ul className="p2p-risk-points">
          <li>{t('termsBalance')}</li>
          <li>{t('termsRelease')}</li>
          <li>{t('termsHonour')}</li>
          <li>{t('termsContact')}</li>
          <li>{t('termsAction')}</li>
        </ul>
        {failed ? (
          <p data-testid="failure" className="failure" role="alert">
            {t('termsAcceptFailed')}
          </p>
        ) : null}
        <div className="actions">
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            {t('termsClose')}
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => void accept()}>
            {busy ? t('termsAccepting') : t('termsAccept')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/** The form's values as `offers.create` takes them: trimmed, the coin in capitals, blank optional fields left out. */
export function postInput(values: OfferFormValues): PostOfferInput {
  const terms = values.terms.trim();
  return {
    side: values.side,
    asset: values.asset.trim().toUpperCase(),
    fiatCurrency: values.fiatCurrency,
    priceType: values.priceType,
    price: values.price.trim(),
    minAmount: values.minAmount.trim(),
    maxAmount: values.maxAmount.trim(),
    ...(values.totalAmount.trim() === '' ? {} : { totalAmount: values.totalAmount.trim() }),
    methods: values.methods,
    ...(terms === '' ? {} : { terms }),
    ...(values.side === 'sell' && values.acceptsNonInstant ? { acceptsNonInstant: true } : {}),
  };
}

type Failure = Extract<ApiResult<unknown>, { ok: false }>;

/** A post refusal the room says in its own words, or null for the shared failure notice. */
function refusalKey(failure: Failure | null) {
  switch (failure?.code) {
    case 'p2p.config_unset':
      return 'refusedConfig' as const;
    case 'p2p.offer_limit_exceeded':
      return 'refusedLimit' as const;
    case 'p2p.offer_method_no_destination':
      return 'refusedNoDestination' as const;
    case 'p2p.trading_disabled':
      return 'refusedTrading' as const;
    case 'denied.kyc_required':
      return 'refusedVerify' as const;
    case 'p2p.instrument_kms_required':
      return 'keyOff' as const;
    case 'p2p.verification_limits_invalid':
    case 'p2p.content_rules_invalid':
    case 'p2p.posting_thresholds_invalid':
      return 'refusedConfig' as const;
    case 'p2p.posting_threshold_not_met':
      return 'refusedThreshold' as const;
    case 'p2p.reference_price_unavailable':
      return 'refusedNoReference' as const;
    case 'p2p.content_rule_violation':
      return 'refusedContent' as const;
    case 'p2p.verification_limit_currency':
      return 'refusedLevelCurrency' as const;
    case 'p2p.verification_level_unwired':
      return 'refusedLevelUnwired' as const;
    // The form's key already named a different ad: a reply was lost after it posted.
    case 'p2p.idempotency_conflict':
    case 'p2p.idempotency_in_progress':
      return 'refusedPostedAlready' as const;
    default:
      return null;
  }
}

/**
 * Every field of the reviewed ad, the frozen-terms note and the advertiser terms state, then Post. A refusal is shown
 * here in the room's words; `p2p.terms_not_accepted` and `p2p.terms_version_stale` open the terms instead.
 */
export function OfferSummary({
  input,
  methodLabels,
  termsNote,
  failure,
  posting,
  onConfirm,
  onBack,
}: {
  input: PostOfferInput;
  methodLabels: string[];
  termsNote: string | null;
  failure: Failure | null;
  posting: boolean;
  onConfirm: () => void;
  onBack: () => void;
}) {
  const { t } = postCopy.useCopy();
  const limit = failure?.code === 'p2p.insufficient_balance' ? failure.p2pLimit : undefined;
  const band =
    failure?.code === 'p2p.verification_order_max' || failure?.code === 'p2p.verification_order_min' ? failure.p2pLimit : undefined;
  const ruleClass = failure?.code === 'p2p.content_rule_violation' ? failure.p2pLimit?.ruleClass : undefined;
  const refused = refusalKey(failure);
  return (
    <section className="stack" data-testid="offer-summary" aria-label={t('summaryTitle')}>
      <h2>{t('summaryTitle')}</h2>
      <PayDetails
        values={[
          [t('summarySide'), t(input.side === 'sell' ? 'summarySell' : 'summaryBuy', { asset: input.asset, fiat: input.fiatCurrency })],
          [
            input.priceType === 'float' ? t('summaryMultiplier') : t('summaryPrice'),
            input.priceType === 'float' ? displayAmount(input.price) : `${displayAmount(input.price)} ${input.fiatCurrency}`,
          ],
          [
            t('summaryLimits'),
            t('summaryLimitsValue', { min: displayAmount(input.minAmount), max: displayAmount(input.maxAmount), asset: input.asset }),
          ],
          [
            t('summaryTotal'),
            input.totalAmount === undefined ? t('summaryTotalSame') : `${displayAmount(input.totalAmount)} ${input.asset}`,
          ],
          [t('summaryMethods'), <span lang="und">{methodLabels.join(', ')}</span>],
          [t('summaryTerms'), input.terms ? <span lang="und">{input.terms}</span> : t('summaryNoTerms')],
        ]}
      />
      {input.acceptsNonInstant ? <p className="muted">{t('summaryNonInstant')}</p> : null}
      <p className="muted">{t('frozenNote')}</p>
      {termsNote ? <p role="status">{termsNote}</p> : null}
      {limit?.available && limit.shortBy ? (
        <p data-testid="failure" className="failure" role="alert">
          {t('overBalance', { available: displayAmount(limit.available), shortBy: displayAmount(limit.shortBy), asset: input.asset })}
        </p>
      ) : band?.min && band.max && band.currency ? (
        <p data-testid="failure" className="failure" role="alert">
          {t('overLevel', { min: displayAmount(band.min), max: displayAmount(band.max), currency: band.currency })}
        </p>
      ) : ruleClass ? (
        <p data-testid="failure" className="failure" role="alert">
          {t('refusedContentClass', { rule: ruleClass.replaceAll('_', ' ') })}
        </p>
      ) : refused ? (
        <p data-testid="failure" className="failure" role="alert">
          {t(refused)}
        </p>
      ) : failure ? (
        <PayFailure result={failure} />
      ) : null}
      <div className="actions">
        <Button variant="ghost" disabled={posting} onClick={onBack}>
          {t('back')}
        </Button>
        <Button variant="primary" disabled={posting} onClick={onConfirm} data-testid="offer-confirm">
          {posting ? t('posting') : t('confirm')}
        </Button>
      </div>
    </section>
  );
}

/** The posted ad: its id and status as svc-p2p answered, and the ways on. */
export function OfferReceipt({ offer, onAnother }: { offer: Offer; onAnother: () => void }) {
  const { t } = postCopy.useCopy();
  const status = offer.status === 'active' ? t('statusActive') : offer.status === 'paused' ? t('statusPaused') : t('statusClosed');
  return (
    <section className="stack" role="status" data-testid="offer-receipt" aria-label={t('receiptTitle')}>
      <h2>{t('receiptTitle')}</h2>
      <PayDetails
        values={[
          [t('receiptId'), <code>{offer.id}</code>],
          [t('receiptStatus'), status],
        ]}
      />
      <div className="actions">
        <a className="button button--primary" href="/uc/ad">
          {t('receiptMine')}
        </a>
        <a className="button button--secondary" href={`/p2p?asset=${encodeURIComponent(offer.asset)}`}>
          {t('receiptBoard')}
        </a>
        <Button variant="ghost" onClick={onAnother}>
          {t('receiptAnother')}
        </Button>
      </div>
    </section>
  );
}
