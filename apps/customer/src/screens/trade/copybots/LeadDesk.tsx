import { useEffect, useState } from 'react';
import { Button, EmptyState, Field, Input, KeyValue, PageSection, Table, type TableColumn } from '@intafaced/ui';
import { displayAmount } from '../../../shared/money';
import type { LeadEarnings, RoomApi } from './api';
import { roomCopy } from './copy';
import { bpsText } from './desk';
import type { Failure } from './guard';
import { RANKINGS } from './LeaderDirectory';
import { useLive } from './live';
import { InfoNote, RefusalNote } from './parts';

type FeeRow = LeadEarnings['items'][number];

/**
 * A lead's own desk (J-copy-bots-otc-06 #3 to #5): what the lead has earned, as fee-share rows only, and the lead's level.
 * A profit share and a maximum ratio can be asked for here; the service refuses both, and the refusal is shown as it comes.
 */
export function LeadDesk({ api }: { api: RoomApi }) {
  const { t } = roomCopy.useCopy();
  const earnings = useLive((signal) => api.leadEarnings(signal), 'copy-lead-earnings', 30_000);
  const level = useLive((signal) => api.leadLevel(signal), 'copy-lead-level', 60_000);
  const [percent, setPercent] = useState('');
  const [ratio, setRatio] = useState('');
  const [shareRefusal, setShareRefusal] = useState<Failure | null>(null);
  const [ratioRefusal, setRatioRefusal] = useState<Failure | null>(null);

  const askShare = async () => {
    setShareRefusal(null);
    const result = await api.setProfitShare(percent.trim());
    if (!result.ok) setShareRefusal(result);
    earnings.reload();
  };
  const askRatio = async () => {
    setRatioRefusal(null);
    const result = await api.setMaxRatio(ratio.trim());
    if (!result.ok) setRatioRefusal(result);
  };

  const columns: TableColumn<FeeRow>[] = [
    { id: 'fill', header: t('Fill'), value: (r) => `Fill ${r.fillId.slice(0, 8)}`, pin: 'start' },
    { id: 'asset', header: t('Asset'), value: (r) => r.assetId },
    { id: 'fee', header: t('Our fee on the fill'), numeric: true, value: (r) => r.feeOnFill, cell: (r) => displayAmount(r.feeOnFill) },
    { id: 'share', header: t('Share of the fee'), value: (r) => bpsText(String(r.appliedShareBps)) ?? '' },
    { id: 'amount', header: t('Fee share'), numeric: true, value: (r) => r.amount, cell: (r) => `${displayAmount(r.amount)} ${r.assetId}` },
    { id: 'at', header: t('Time'), value: (r) => new Date(r.at).toLocaleString() },
  ];
  const data = earnings.data;
  const earned = data
    ? data.totals.length > 0
      ? data.totals.map((x) => `${displayAmount(x.amount)} ${x.assetId}`).join(', ')
      : t('None recorded')
    : null;

  return (
    <>
      <section aria-label={t('Your earnings')}>
        <PageSection title={t('Your earnings')} headingLevel={2}>
          {earnings.status === 'error' && earnings.failure ? <RefusalNote failure={earnings.failure} retry={earnings.reload} /> : null}
          <InfoNote>{data?.profitShare ?? t('Leaders are paid a share of the trading fee only, never a share of profit.')}</InfoNote>
          <KeyValue
            items={[
              { label: t('Fee share earned'), value: earned },
              {
                label: t('Leader’s share of the fee'),
                value: data
                  ? data.leaderShareBps === null
                    ? t('Not approved')
                    : (bpsText(data.leaderShareBps) ?? t('Not approved'))
                  : null,
              },
              { label: t('Profit share'), value: t('Not offered') },
            ]}
          />
          <Table
            label={t('Fee share history')}
            columns={columns}
            rows={data?.items ?? []}
            getRowId={(r) => `${r.followId}:${r.fillId}`}
            status={earnings.status === 'loading' ? 'loading' : earnings.status === 'error' ? 'error' : 'ready'}
            onRetry={earnings.reload}
            minWidth={720}
            emptyState={
              <EmptyState
                size="inline"
                title={t('No fee share recorded')}
                reason={t('A row appears here for each copied fill whose trading fee you share.')}
              />
            }
          />
          <form
            className="cb-action-row"
            onSubmit={(event) => {
              event.preventDefault();
              void askShare();
            }}
          >
            <Field label={t('Profit share, %')}>
              <Input kind="decimal" value={percent} onValueChange={setPercent} precision={18} autoComplete="off" />
            </Field>
            <Button type="submit" variant="secondary">
              {t('Set a profit share')}
            </Button>
          </form>
          {shareRefusal ? <RefusalNote failure={shareRefusal} /> : null}
        </PageSection>
      </section>

      <section aria-label={t('Your level')}>
        <PageSection title={t('Your level')} headingLevel={2}>
          {level.status === 'error' && level.failure ? <RefusalNote failure={level.failure} retry={level.reload} /> : null}
          <KeyValue
            items={[
              {
                label: t('Level'),
                value: level.data ? (level.data.level ?? t('Not set: the platform has not published level thresholds')) : null,
              },
              { label: t('Listing'), value: level.data ? (level.data.leaderRef ?? t('You are not a listed leader')) : null },
            ]}
          />
          <p className="muted">{t('Maximum ratio: not set by the platform')}</p>
          <form
            className="cb-action-row"
            onSubmit={(event) => {
              event.preventDefault();
              void askRatio();
            }}
          >
            <Field label={t('Maximum ratio')}>
              <Input kind="decimal" value={ratio} onValueChange={setRatio} precision={18} autoComplete="off" />
            </Field>
            <Button type="submit" variant="secondary">
              {t('Set a maximum ratio')}
            </Button>
          </form>
          {ratioRefusal ? <RefusalNote failure={ratioRefusal} /> : null}
        </PageSection>
      </section>
    </>
  );
}

/**
 * The leaderboard (J-copy-bots-otc-06 #6; CB-copy-23): each ranked category is asked for by name and the service's
 * refusal is shown with it. No ranking is drawn; only the stated empty state shows.
 */
export function Leaderboard({ api }: { api: RoomApi }) {
  const { t } = roomCopy.useCopy();
  const [answers, setAnswers] = useState<Record<string, Failure | 'answered' | null>>({});
  useEffect(() => {
    let live = true;
    for (const item of RANKINGS) {
      void api.rankedLeaders(item.ask).then((result) => {
        if (live) setAnswers((prev) => ({ ...prev, [item.label]: result.ok ? 'answered' : result }));
      });
    }
    return () => {
      live = false;
    };
  }, [api]);

  return (
    <PageSection title={t('Leaderboard')} headingLevel={2}>
      <EmptyState
        size="inline"
        title={t('Leaders are not ranked by returns here.')}
        reason={t('Compare leaders in the directory by their own published facts. No list orders them by profit, return or copiers.')}
      />
      <ul className="cb-reasons" aria-label={t('Ranked categories')}>
        {RANKINGS.map((item) => {
          const answer = answers[item.label];
          return (
            <li key={item.label}>
              <strong>{t(item.label as 'Trending')}</strong>:{' '}
              {answer === undefined || answer === null ? t('Asking') : answer === 'answered' ? t('Not shown') : t('Refused')}
              {answer && answer !== 'answered' ? <RefusalNote failure={answer} /> : null}
            </li>
          );
        })}
      </ul>
    </PageSection>
  );
}
