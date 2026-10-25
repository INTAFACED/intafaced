import { StatusTag } from '@intafaced/ui';
import {
  KYC_LADDER_LEVELS,
  kycLevelsDescribeOutputSchema,
  type KycLadderFeatureState,
  type KycLadderLevel,
  type KycLadderRung,
} from '@intafaced/contracts/identity-kyc-levels';
import { payWithdrawalTierLimitsOutputSchema, type PayWithdrawalTierLimits } from '@intafaced/contracts/pay-withdrawal-tier-limits';
import { useSession } from '../session/session';
import { useResource } from '../../shared/resource';
import { Button, Failure, Loading } from '../../shared/ui';
import { verificationLadderCopy as copy } from './verification-ladder-copy';

const rank = (level: KycLadderLevel) => KYC_LADDER_LEVELS.indexOf(level);

/** A refusal at every level, from the region or the module. The matrix code stays in a data attribute. */
function blockedKey(code: string): 'module_blocked' | 'region_blocked' | 'unavailable' {
  if (code === 'denied.module_blocked') return 'module_blocked';
  if (code === 'denied.region_blocked') return 'region_blocked';
  return 'unavailable';
}

/**
 * I-kyc-compliance-04/05: the ladder of levels on /verification. Each level lists what it unlocks (worked out by
 * identity with the same rule the money services' guards use), what the owner publishes it asks for, and the stated
 * review time. Unpublished reads as unpublished, never as an empty list. "Verify to unlock" starts a request for that
 * level in the request form beside it; it grants nothing by itself, and shows only for a level that form offers.
 * `statusTier` is the level the page's own status read returned: when it changes (a refresh after an approval), the
 * ladder reads again, so the two never show different levels for long.
 */
export function VerificationLadder({
  onVerify,
  verifyDisabled,
  offered,
  statusTier,
}: {
  onVerify: (level: KycLadderLevel) => void;
  verifyDisabled: boolean;
  offered: readonly KycLadderLevel[];
  statusTier: KycLadderLevel | null;
}) {
  const { api, userId } = useSession();
  const { t, Copy } = copy.useCopy();
  const { resource, reload } = useResource(
    (signal) => api.query('identity', 'kyc.levels.describe', {}, kycLevelsDescribeOutputSchema, { signal }),
    `verification-ladder:${userId}:${statusTier ?? 'reading'}`,
  );
  // The owner's figures are the same for every customer, so one read serves every level (svc-pay, D-148).
  const { resource: limits, reload: reloadLimits } = useResource(
    (signal) => api.query('pay', 'withdrawal.tierLimits', {}, payWithdrawalTierLimitsOutputSchema, { signal }),
    `verification-ladder-limits:${userId}`,
  );
  const limitsByTier = new Map<string, PayWithdrawalTierLimits['limits']>();
  if (limits.status === 'ready') for (const l of limits.data.limits) limitsByTier.set(l.tier, [...(limitsByTier.get(l.tier) ?? []), l]);
  if (resource.status === 'loading') return <Loading />;
  if (resource.status === 'failed')
    return (
      <section className="verification__ladder" aria-label={t('title')}>
        <h2>
          <Copy k="failedTitle" />
        </h2>
        <Failure result={resource.failure} retry={reload} />
      </section>
    );
  const ladder = resource.data;
  const feature = (rung: KycLadderRung, f: KycLadderFeatureState) => {
    const held = rank(rung.level) <= rank(ladder.held);
    const label =
      f.state === 'allowed'
        ? f.perOffer
          ? t('perOffer')
          : t(held ? 'held' : 'allowed')
        : f.state === 'needs_level'
          ? t('needsLevel', { level: t(f.level) })
          : t(blockedKey(f.code));
    return (
      <li
        key={f.feature}
        className="verification__feature"
        data-feature={f.feature}
        data-state={f.state}
        {...(f.state === 'needs_level' ? { 'data-needs': f.level } : {})}
        {...(f.state === 'blocked' ? { 'data-code': f.code } : {})}
      >
        <span>
          <Copy k={f.feature} />
        </span>
        <StatusTag status={f.state === 'allowed' ? 'filled' : f.state === 'needs_level' ? 'pending' : 'cancelled'} label={label} />
      </li>
    );
  };
  return (
    <section className="verification__ladder" aria-label={t('title')}>
      <h2>
        <Copy k="title" />
      </h2>
      <p className="muted">
        <Copy k="intro" /> {ladder.regionResolved ? <Copy k="region" params={{ region: ladder.region }} /> : <Copy k="regionUnknown" />}
      </p>
      <ol className="verification__rungs">
        {ladder.levels.map((rung) => (
          <li
            key={rung.level}
            className={rung.current ? 'verification__rung verification__rung--current' : 'verification__rung'}
            data-level={rung.level}
            aria-current={rung.current ? 'step' : undefined}
          >
            <div className="verification__rung-head">
              <h3>
                <Copy k={rung.level} />
              </h3>
              {rung.current && <StatusTag status="filled" label={t('yourLevel')} />}
            </div>
            <h4>
              <Copy k="unlocks" />
            </h4>
            <ul className="verification__features">{rung.features.map((f) => feature(rung, f))}</ul>
            <h4>
              <Copy k="asks" />
            </h4>
            {rung.requirements.published ? (
              <ul className="verification__requirements" data-published="true">
                {rung.requirements.keys.map((key) => (
                  <li key={key} data-requirement={key}>
                    <Copy k={key} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="verification__requirements muted" data-published="false">
                <Copy k="notPublished" />
              </p>
            )}
            {rung.reviewHours === null ? (
              <p className="verification__review-time muted" data-stated="false">
                <Copy k="noReviewTime" />{' '}
                <a className="text-link" href="/support">
                  <Copy k="noReviewTimeHelp" /> →
                </a>
              </p>
            ) : (
              <p className="verification__review-time" data-stated="true">
                {rung.reviewHours === 1 ? <Copy k="reviewTimeOne" /> : <Copy k="reviewTime" params={{ hours: String(rung.reviewHours) }} />}
              </p>
            )}
            <h4>
              <Copy k="limitsTitle" />
            </h4>
            <div className="verification__limits" data-level={rung.level}>
              {limits.status === 'loading' ? (
                <p className="muted">
                  <Copy k="limitsReading" />
                </p>
              ) : limits.status === 'failed' ? (
                <p className="muted" data-limits="failed" data-code={limits.failure.code ?? limits.failure.reason}>
                  <Copy k="limitsFailed" />{' '}
                  <button type="button" className="text-link" onClick={reloadLimits}>
                    <Copy k="limitsRetry" />
                  </button>
                </p>
              ) : limitsByTier.get(rung.level)?.length ? (
                <>
                  <ul data-limits="set">
                    {limitsByTier.get(rung.level)!.map((l) => (
                      <li key={l.assetId}>
                        <Copy k="limitRow" params={{ asset: l.assetId, perTx: l.perTx, rolling: l.rolling24h }} />
                      </li>
                    ))}
                  </ul>
                  <p className="muted">
                    <Copy k={limits.data.enforced ? 'limitOthersRefused' : 'limitsNotApplied'} />
                  </p>
                </>
              ) : (
                <>
                  <p data-limits="unset">
                    <Copy k="limitUnset" />
                  </p>
                  <p className="muted">
                    <Copy k={limits.data.enforced ? 'limitUnsetRefused' : 'limitsNotApplied'} />
                  </p>
                </>
              )}
            </div>
            {rank(rung.level) > rank(ladder.held) && offered.includes(rung.level) && (
              <Button variant="secondary" disabled={verifyDisabled} onClick={() => onVerify(rung.level)}>
                <Copy k="verify" />
              </Button>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
