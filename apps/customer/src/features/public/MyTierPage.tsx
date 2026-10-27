import { useMemo, type ReactNode } from 'react';
import { useDataEnv, useSource } from '../../data/hooks';
import { refusalCopy } from '../../data';
import type { Loadable } from '../../data/types';
import { useLocation } from '../../app/location';
import { safeReturnTo } from '../../app/navigation';
import { useSession } from '../session/session';
import { feeTierFetcher, snapshotTime, type FeeTier, type FeeTierBenefits } from './fee-tier';
import { feeTierCopy } from './fee-tier-copy';
import { VipApply } from './VipApply';
import './public-pages.css';

/**
 * /fees/my-tier: the person's own fee tier (SP-fees-vip-03, J-cex-spot-10 #5-#6). The tier their next order keeps,
 * the volume counted toward the next snapshot and what it reaches, the next threshold, when the next snapshot runs,
 * what is counted and what is not, and the snapshot rows with the figures each used. A rule the owner left blank says
 * so; nothing is a sample.
 */
export function MyTierPage() {
  const { session, restoring } = useSession();
  const location = useLocation();
  const copy = feeTierCopy.useCopy();
  // A signed-in person who opens the page directly is not asked to sign in while their session comes back.
  if (!session && restoring) {
    return (
      <div className="pub-page" data-room="my-tier">
        <header className="pub-heading">
          <h1>{copy.t('title')}</h1>
          <p>{copy.t('lead')}</p>
        </header>
        <p role="status">{copy.t('loading')}</p>
      </div>
    );
  }
  if (!session) {
    return (
      <div className="pub-page" data-room="my-tier">
        <header className="pub-heading">
          <h1>{copy.t('title')}</h1>
          <p>{copy.t('lead')}</p>
        </header>
        <section className="pub-notice" role="status" data-tier-page="sign-in">
          <h2>{copy.t('signInTitle')}</h2>
          <p>{copy.t('signInBody')}</p>
          <a className="button button--primary" href={`/login?redirect=${encodeURIComponent(safeReturnTo(location))}`}>
            {copy.t('signInAction')}
          </a>
        </section>
      </div>
    );
  }
  return <SignedInTier />;
}

function SignedInTier() {
  const env = useDataEnv();
  const source = useMemo(() => env.poller.source<FeeTier | null>('my-fee-tier', feeTierFetcher(env.api), { intervalMs: 15_000 }), [env]);
  return <MyTierView load={useSource(source)} apply={<VipApply />} />;
}

/** `apply` is the VIP application: shown whatever the tier read answers, so a pending application stays in view. */
export function MyTierView({ load, apply }: { load: Loadable<FeeTier | null>; apply?: ReactNode }) {
  const copy = feeTierCopy.useCopy();
  return (
    <div className="pub-page" data-room="my-tier">
      <header className="pub-heading">
        <h1>{copy.t('title')}</h1>
        <p>{copy.t('lead')}</p>
      </header>
      {load.status === 'loading' ? <p role="status">{copy.t('loading')}</p> : null}
      {load.status === 'error' ? (
        <p role="alert">
          {copy.t('failed')}{' '}
          <button type="button" className="text-link" onClick={load.retry}>
            {copy.t('retry')}
          </button>
        </p>
      ) : null}
      {load.status === 'refused' ? <p role="alert">{refusalCopy(load.code).title}</p> : null}
      {load.status === 'empty' || (load.status === 'ready' && load.data === null) ? (
        <section className="pub-notice" role="status" data-tier-page="blank">
          <h2>{copy.t('blankTitle')}</h2>
          <p>{copy.t('blankBody')}</p>
        </section>
      ) : null}
      {load.status === 'ready' && load.data ? <Tier tier={load.data} /> : null}
      {apply}
      <p>
        <a className="text-link" href="/fees">
          {copy.t('feesLink')} →
        </a>
      </p>
    </div>
  );
}

function Tier({ tier }: { tier: FeeTier }) {
  const copy = feeTierCopy.useCopy();
  const name = (tierId: string) => (tierId === 'regular' ? copy.t('regular') : tierId);
  const { program, volume } = tier;
  return (
    <>
      <section className="pub-card" aria-label={copy.t('yourTier', { tier: name(tier.tier) })} data-tier-page="tier">
        <h2 data-tier={tier.tier}>{copy.t('yourTier', { tier: name(tier.tier) })}</h2>
        <p>
          {tier.trial ? (
            <span data-tier-page="trial">{copy.t('tierFromTrial', { time: snapshotTime(tier.trial.endsAt) })}</span>
          ) : tier.lastSnapshot ? (
            copy.t('tierFromSnapshot', { time: snapshotTime(tier.lastSnapshot.instant) })
          ) : (
            copy.t('tierNoSnapshot')
          )}
        </p>
        {program === null ? <p data-tier-page="thresholds-not-set">{copy.t('thresholdsNotSet')}</p> : null}
      </section>
      {program && volume ? (
        <>
          <section className="pub-card" aria-label={copy.t('volumeTitle')} data-tier-page="volume">
            <h2>{copy.t('volumeTitle')}</h2>
            <p data-volume={volume.amount}>
              <strong>{copy.t('volumeLine', { amount: volume.amount, fills: String(volume.fills) })}</strong>
            </p>
            <p data-reaches={volume.reaches}>{copy.t('reaches', { tier: name(volume.reaches) })}</p>
            <p data-tier-page="next">
              {tier.next
                ? copy.t('nextTier', { tier: name(tier.next.tierId), min: tier.next.minVolume30d, remaining: tier.next.remaining })
                : copy.t('topTier')}
            </p>
            <table className="pub-table" aria-label={copy.t('thresholdsTitle')}>
              <thead>
                <tr>
                  <th scope="col">{copy.t('colTier')}</th>
                  <th scope="col">{copy.t('colFrom')}</th>
                </tr>
              </thead>
              <tbody>
                {program.thresholds.map((threshold) => (
                  <tr key={threshold.tierId} data-threshold={threshold.tierId}>
                    <th scope="row">{name(threshold.tierId)}</th>
                    <td>{threshold.minVolume30d}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <section className="pub-card" aria-label={copy.t('snapshotTitle')} data-tier-page="snapshot">
            <h2>{copy.t('snapshotTitle')}</h2>
            <p data-next-snapshot={tier.nextSnapshotAt ?? ''}>
              {!tier.snapshotsRunning
                ? copy.t('snapshotsStopped')
                : tier.nextSnapshotAt
                  ? copy.t('nextSnapshot', { time: snapshotTime(tier.nextSnapshotAt) })
                  : copy.t('noSnapshotTime')}
            </p>
            <p>{copy.t('graceNotSet')}</p>
          </section>
          <section className="pub-card" aria-label={copy.t('countsTitle')} data-tier-page="counts">
            <h2>{copy.t('countsTitle')}</h2>
            <ul>
              <li data-counted="spot">{copy.t('counted', { quotes: program.volumeQuotes.join(', ') })}</li>
              {tier.excluded.map((code) => (
                <li key={code} data-excluded={code}>
                  {copy.t(`excluded_${code}` as const)}
                </li>
              ))}
            </ul>
          </section>
        </>
      ) : null}
      <Benefits
        benefits={program?.benefits ?? null}
        tiers={program ? ['regular', ...program.thresholds.map((threshold) => threshold.tierId)] : []}
        yours={tier.tier}
        name={name}
      />
      <section className="pub-card" aria-label={copy.t('snapshotsTitle')} data-tier-page="snapshots">
        <h2>{copy.t('snapshotsTitle')}</h2>
        {tier.snapshots.length === 0 ? (
          <p>{copy.t('noSnapshots')}</p>
        ) : (
          <table className="pub-table">
            <thead>
              <tr>
                <th scope="col">{copy.t('colTime')}</th>
                <th scope="col">{copy.t('colTier')}</th>
                <th scope="col">{copy.t('colVolume')}</th>
                <th scope="col">{copy.t('colTrades')}</th>
                <th scope="col">{copy.t('colVersion')}</th>
              </tr>
            </thead>
            <tbody>
              {tier.snapshots.map((row) => (
                <tr key={row.key} data-snapshot={row.key}>
                  <th scope="row">{snapshotTime(row.instant)}</th>
                  <td>{name(row.tierId)}</td>
                  <td>{row.volume30d}</td>
                  <td>{row.countedFills}</td>
                  <td>{row.scheduleVersion}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}

const NOT_SET = { prioritySupport: null, vipPortal: null, ambassador: null, subAccountCap: null, withdrawalLimit24h: null } as const;

/**
 * The owner's benefits table: one row per tier of the programme, lowest first, the person's own marked. A cell the owner
 * left blank, or a tier with no row, says "not set".
 */
function Benefits({
  benefits,
  tiers,
  yours,
  name,
}: {
  benefits: readonly FeeTierBenefits[] | null;
  tiers: readonly string[];
  yours: string;
  name: (tierId: string) => string;
}) {
  const copy = feeTierCopy.useCopy();
  const flag = (value: boolean | null) => (value === null ? copy.t('benefitNotSet') : value ? copy.t('benefitYes') : copy.t('benefitNo'));
  return (
    <section className="pub-card" aria-labelledby="tier-benefits-title" data-tier-page="benefits">
      <h2 id="tier-benefits-title">{copy.t('benefitsTitle')}</h2>
      {benefits === null ? (
        <p data-benefits="not-set">{copy.t('benefitsNotSet')}</p>
      ) : (
        <>
          <p>{copy.t('benefitsLead')}</p>
          <table className="pub-table" aria-labelledby="tier-benefits-title">
            <thead>
              <tr>
                <th scope="col">{copy.t('colTier')}</th>
                <th scope="col">{copy.t('colPrioritySupport')}</th>
                <th scope="col">{copy.t('colVipPortal')}</th>
                <th scope="col">{copy.t('colAmbassador')}</th>
                <th scope="col">{copy.t('colSubAccountCap')}</th>
                <th scope="col">{copy.t('colWithdrawalLimit')}</th>
              </tr>
            </thead>
            <tbody>
              {tiers
                .map((tierId) => benefits.find((row) => row.tierId === tierId) ?? { ...NOT_SET, tierId })
                .map((row) => (
                  <tr key={row.tierId} data-benefits={row.tierId} aria-current={row.tierId === yours ? 'true' : undefined}>
                    <th scope="row">{row.tierId === yours ? copy.t('benefitYours', { tier: name(row.tierId) }) : name(row.tierId)}</th>
                    <td data-benefit="prioritySupport">{flag(row.prioritySupport)}</td>
                    <td data-benefit="vipPortal">{flag(row.vipPortal)}</td>
                    <td data-benefit="ambassador">{flag(row.ambassador)}</td>
                    <td data-benefit="subAccountCap">{row.subAccountCap === null ? copy.t('benefitNotSet') : String(row.subAccountCap)}</td>
                    <td data-benefit="withdrawalLimit24h">
                      {row.withdrawalLimit24h === null
                        ? copy.t('benefitNotSet')
                        : copy.t('benefitLimit', { amount: row.withdrawalLimit24h.amount, asset: row.withdrawalLimit24h.asset })}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
