// hand-declared-ok: svc-token's launch.events.schedule output is declared in its launch router; packages/contracts has no token schemas yet
import { useState } from 'react';
import { z } from 'zod';
import { useApi, useSession } from '../session/session';
import { useResource, type Resource } from '../../shared/resource';
import { decimalSchema } from '../../shared/money';
import type { ApiResult } from '../../shared/api';
import { Button } from '../../shared/ui';
import { Details, Read } from './common';
import { launchDistributionCopy } from './launch-distribution-copy';

type Refusal = Extract<ApiResult<unknown>, { ok: false }>;
const iso = z.string().datetime({ offset: true });

/** svc-token `launch.events.schedule`: the schedule and the share vested at the service clock, or why it is not set. */
export const scheduleSchema = z
  .object({
    eventId: z.string(),
    readAt: iso,
    vesting: z.object({ startAt: iso, cliffAt: iso.nullable(), endAt: iso }).nullable(),
    reason: z.literal('launch.schedule_unset').nullable(),
    phase: z.enum(['before_start', 'before_cliff', 'vesting', 'vested']).nullable(),
    vestedShare: decimalSchema.nullable(),
    awarded: z.null(),
    awardedReason: z.literal('launch.allocation_unwired'),
  })
  .refine(
    (r) => (r.vesting === null) === (r.reason !== null) && (r.vesting === null) === (r.vestedShare === null),
    'schedule read is inconsistent',
  );
export type ScheduleRead = z.infer<typeof scheduleSchema>;

/** A UTC minute for a service timestamp; the `datetime` attribute keeps the exact value. */
function When({ at }: { at: string }) {
  return <time dateTime={at}>{`${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC`}</time>;
}

/** The share as a percentage of the allocation, from the service's decimal fraction: string arithmetic, no float. */
function percent(share: string): string {
  const [whole, fraction = ''] = share.split('.');
  const scaled = `${whole}${fraction.padEnd(4, '0').slice(0, 4)}`.replace(/^0+(?=\d)/, '');
  const digits = scaled.padStart(3, '0');
  const int = digits.slice(0, -2).replace(/^0+(?=\d)/, '');
  const dec = digits.slice(-2).replace(/0+$/, '');
  return dec ? `${int}.${dec}` : int;
}

/** The distribution panel at /launch/<id> (J-more-catalogue-13 #4, #5): schedule, vested share and the claim control. */
export function LaunchDistribution({ eventId }: { eventId: string }) {
  const api = useApi();
  const read = useResource(
    (signal) => api.query('token', 'launch.events.schedule', { id: eventId }, scheduleSchema, { signal }),
    `launch-schedule:${eventId}`,
  );
  return <LaunchDistributionView eventId={eventId} read={read} />;
}

export function LaunchDistributionView({
  eventId,
  read,
}: {
  eventId: string;
  read: { resource: Resource<ScheduleRead>; reload: () => void };
}) {
  const { t } = launchDistributionCopy.useCopy();
  const heading = 'launch-distribution-title';
  return (
    <section className="launch-catalogue-region" aria-labelledby={heading} data-testid="launch-distribution">
      <h3 id={heading}>{t('title')}</h3>
      <Read resource={read.resource} retry={read.reload}>
        {(s) =>
          s.vesting === null ? (
            <p role="status" data-testid="launch-schedule-unset">
              {t('unset')}
            </p>
          ) : (
            <>
              <Details
                items={[
                  [t('start'), <When at={s.vesting.startAt} />],
                  [t('cliff'), s.vesting.cliffAt ? <When at={s.vesting.cliffAt} /> : t('noCliff')],
                  [t('end'), <When at={s.vesting.endAt} />],
                  [t('rule'), t('linear')],
                  [
                    t('vestedNow'),
                    <span data-testid="launch-vested-share">{t('vestedShare', { percent: percent(s.vestedShare ?? '0') })}</span>,
                  ],
                  [t('readAt'), <When at={s.readAt} />],
                  [t('phase'), s.phase ? t(s.phase) : t('notSet')],
                ]}
              />
            </>
          )
        }
      </Read>
      <p className="muted" data-testid="launch-awarded">
        {t('awardedNone')}
      </p>
      <ClaimControl eventId={eventId} />
    </section>
  );
}

/** Both claim buttons are shown and refuse with the service's typed reason; neither moves anything in this build. */
function ClaimControl({ eventId }: { eventId: string }) {
  const api = useApi();
  const { userId } = useSession();
  const { t } = launchDistributionCopy.useCopy();
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [busy, setBusy] = useState(false);
  if (!userId) return <p className="muted">{t('signIn')}</p>;
  const claim = async (onChain: boolean) => {
    setBusy(true);
    try {
      const res = await api.mutate('token', 'launch.events.claim', { id: eventId, onChain }, z.never());
      setRefusal(res.ok ? null : res);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="actions">
        <Button onClick={() => void claim(true)} disabled={busy}>
          {t('claimOnChain')}
        </Button>
        <Button variant="secondary" onClick={() => void claim(false)} disabled={busy}>
          {t('claimToAccount')}
        </Button>
      </div>
      {refusal && (
        <p role="alert" data-testid="launch-claim-refusal" data-code={refusal.code ?? undefined}>
          {refusal.reason === 'uncertain'
            ? t('uncertain')
            : refusal.code === 'launch.chain_claim_unavailable'
              ? t('chainClaimUnavailable')
              : refusal.code === 'launch.claim_unavailable'
                ? t('claimUnavailable')
                : refusal.message}
        </p>
      )}
    </>
  );
}
