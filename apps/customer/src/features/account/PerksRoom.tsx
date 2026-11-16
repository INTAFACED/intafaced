import { useMemo } from 'react';
import { POINTS_TIER_OWNER_QUESTION } from '@intafaced/contracts/campaigns-catalogue';
import { useDataEnv, useSource } from '../../data/hooks';
import { refusalCopy } from '../../data';
import type { Loadable } from '../../data/types';
import { useSession } from '../session/session';
import { EmptyState, Page, Panel } from '../../shared/ui';
import { feeTierFetcher, type FeeTier, type FeeTierPass } from '../public/fee-tier';
import { PromotionTabs } from './Promotions';
import { promotionsCopy } from './promotions-copy';
import { perksCopy } from './perks-copy';

/**
 * /uc/promotion/perks (CM-vip-tiers-01, J-campaigns-14 #1 to #4): the person's loyalty tier, reached on spend (svc-trade's
 * 30-day volume tier), its fee multiplier (the tier's taker rate over regular's in the owner's default pair group), the
 * next tier and what is left to reach it, and a tier on points, which waits for the owner (OWNER 87) and says so. A VIP
 * trial pass granted as a campaign reward shows as a badge with its end time while it is in force; its fee discount is
 * the tier every order placed until then is charged at. When it ends the badge goes, and the pass's row says how it
 * ended. Read every few seconds, so the badge goes when the pass ends without a reload. Nothing here is a sample.
 */
export function PromotionPerks() {
  const { userId } = useSession();
  const { t, Copy } = promotionsCopy.useCopy();
  return (
    <div className="promotions">
      <Page title={t('title')} description={t('description')}>
        {userId ? (
          <>
            <PromotionTabs view="perks" />
            <SignedInPerks />
          </>
        ) : (
          <EmptyState
            title={t('signIn')}
            action={
              <a className="text-link" href="/login?redirect=%2Fuc%2Fpromotion%2Fperks">
                <Copy k="signIn" />
              </a>
            }
          >
            <Copy k="guest" />
          </EmptyState>
        )}
      </Page>
    </div>
  );
}

function SignedInPerks() {
  const env = useDataEnv();
  const source = useMemo(() => env.poller.source<FeeTier | null>('perks-fee-tier', feeTierFetcher(env.api), { intervalMs: 5_000 }), [env]);
  return <PerksView load={useSource(source)} />;
}

/** "2026-11-16 03:02:00 UTC": a pass ends to the second. */
const utc = (iso: string): string => `${iso.slice(0, 19).replace('T', ' ')} UTC`;

export function PerksView({ load }: { load: Loadable<FeeTier | null> }) {
  const { t } = perksCopy.useCopy();
  return (
    <section className="perks" aria-label={t('title')} data-testid="perks" data-state={load.status}>
      <Panel title={t('title')}>
        <p className="muted">{t('intro')}</p>
        {load.status === 'loading' ? <p role="status">{t('loading')}</p> : null}
        {load.status === 'error' ? (
          <p role="alert" data-testid="perks-failed">
            {t('failed')}{' '}
            <button type="button" className="text-link" onClick={load.retry}>
              {t('retry')}
            </button>
          </p>
        ) : null}
        {load.status === 'refused' ? <p role="alert">{refusalCopy(load.code).title}</p> : null}
        {load.status === 'empty' || (load.status === 'ready' && load.data === null) ? (
          <p role="note" data-testid="perks-schedule-blank">
            {t('scheduleBlank')}
          </p>
        ) : null}
        {load.status === 'ready' && load.data ? <Perks tier={load.data} /> : null}
        <PointsTier />
      </Panel>
    </section>
  );
}

function Perks({ tier }: { tier: FeeTier }) {
  const { t } = perksCopy.useCopy();
  const rate = tier.rates?.find((row) => row.tierId === tier.tier) ?? null;
  const pass = tier.pass ?? null;
  return (
    <>
      <section aria-label={t('tierTitle')} data-testid="perks-tier" data-tier={tier.tier}>
        <h3>{t('tierTitle')}</h3>
        <p>
          {t('tierLead')} <strong lang="zxx">{tier.tier}</strong>
        </p>
        <p className="muted">{t('tierBasis')}</p>
        <p data-testid="perks-multiplier" data-multiplier={rate?.takerMultiplier ?? ''}>
          {t('multiplier')}:{' '}
          {rate && rate.takerMultiplier !== null ? (
            <span lang="zxx">
              ×{rate.takerMultiplier} ({t('taker')} {bps(rate.takerBps)}, {t('maker')} {bps(rate.makerBps)})
            </span>
          ) : (
            t('multiplierUnset')
          )}
        </p>
      </section>

      <section aria-label={t('nextTitle')} data-testid="perks-next" data-next={tier.next?.tierId ?? ''}>
        <h3>{t('nextTitle')}</h3>
        <p>
          {!tier.program ? (
            t('nextUnset')
          ) : tier.next ? (
            <span lang="zxx">
              {tier.next.tierId} {t('nextFrom')} {tier.next.minVolume30d}, {tier.next.remaining} {t('nextToGo')}
            </span>
          ) : (
            t('nextTop')
          )}
        </p>
      </section>

      <section aria-label={t('passTitle')} data-testid="perks-pass">
        <h3>{t('passTitle')}</h3>
        {pass ? (
          <p className="badge" data-testid="perks-pass-badge" data-pass={pass.passKey} data-tier={pass.tierId} data-ends={pass.endsAt}>
            <strong>{t('passBadge')}</strong> <span lang="zxx">{pass.tierId}</span> {t('passUntil')}{' '}
            <time dateTime={pass.endsAt}>{utc(pass.endsAt)}</time>
          </p>
        ) : (
          <p className="muted" data-testid="perks-pass-none">
            {t('passNone')}
          </p>
        )}
        {pass ? <p className="muted">{t('passApplied')}</p> : null}
        {tier.passes && tier.passes.length > 0 ? <Passes passes={tier.passes} /> : null}
      </section>
    </>
  );
}

const bps = (value: number): string => `${(value / 100).toFixed(2)}%`;

function Passes({ passes }: { passes: readonly FeeTierPass[] }) {
  const { t } = perksCopy.useCopy();
  return (
    <table data-testid="perks-passes">
      <caption>{t('passesTitle')}</caption>
      <thead>
        <tr>
          <th scope="col">{t('passTier')}</th>
          <th scope="col">{t('passGranted')}</th>
          <th scope="col">{t('passEnds')}</th>
          <th scope="col">{t('passEnded')}</th>
        </tr>
      </thead>
      <tbody>
        {passes.map((pass) => (
          <tr key={pass.passKey} data-pass-row={pass.passKey} data-end={pass.endReason ?? 'open'}>
            <td lang="zxx">{pass.tierId}</td>
            <td>{utc(pass.grantedAt)}</td>
            <td>{utc(pass.endsAt)}</td>
            <td>
              {pass.endedAt === null
                ? t('passOpen')
                : `${utc(pass.endedAt)}: ${pass.endReason === 'replaced' ? t('passReplaced') : t('passExpired')}`}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** A tier on a points basis waits for the owner's decision (OWNER 87): its blocker, named in plain words. */
function PointsTier() {
  const { t } = perksCopy.useCopy();
  return (
    <section aria-label={t('pointsTitle')} data-testid="perks-points-tier" data-code="owner.decision">
      <h3>{t('pointsTitle')}</h3>
      <p role="note">
        <strong>{t('pointsLead')}</strong> <span data-testid="perks-points-question">{POINTS_TIER_OWNER_QUESTION}</span>
      </p>
    </section>
  );
}
