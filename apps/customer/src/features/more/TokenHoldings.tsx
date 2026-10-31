import { useState } from 'react';
import { z } from 'zod';
import { useApi, useSession } from '../session/session';
import { useResource } from '../../shared/resource';
import { displayAmount } from '../../shared/money';
import { usePreferences } from '../../shared/preferences';
import { Button, DataTable, EmptyState, Field, Panel } from '../../shared/ui';
import { Read, Select } from './common';
import { downloadCsv, toCsv } from './depth-csv';
import { DisabledAction, StatRow } from './depth-kit';
import {
  STAKE_CSV_HEADER,
  STAKE_LOCK_DAYS,
  stakeRows,
  summariseStakes,
  unlockCalendar,
  validStakeAmount,
  type StakeRow,
} from './token-holdings';
import { tokenHoldingsCopy } from './token-holdings-copy';

const stakeRowSchema = z.object({
  id: z.string().guid(),
  userId: z.string().guid(),
  amount: z.string(),
  tier: z.enum(['flex', 'm3', 'm12']),
  startedAt: z.string(),
  unlocksAt: z.string().nullable(),
  status: z.enum(['pending', 'active', 'unstaking', 'closed']),
});

/** Holdings summary, unlock calendar, stake ticket and export. */
export function TokenHoldings() {
  const api = useApi();
  const { userId } = useSession();
  const { hideBalances } = usePreferences();
  const { Copy, t } = tokenHoldingsCopy.useCopy();
  const [amount, setAmount] = useState('');
  const [term, setTerm] = useState<StakeRow['tier']>('flex');
  const [exported, setExported] = useState<boolean | null>(null);
  const stakes = useResource(
    (signal) =>
      api.query(
        'token',
        'listStakes',
        { status: 'all', limit: 200 },
        z.array(stakeRowSchema).refine((rows) => rows.every((row) => row.userId === userId)),
        { signal },
      ),
    `token-holdings:${userId}`,
  );
  const show = (value: string) => (hideBalances ? t('hidden') : displayAmount(value));
  return (
    <Panel title={t('holdingsTitle')}>
      <p className="muted">
        <Copy k="assetNote" />
      </p>
      <Read resource={stakes.resource} retry={stakes.reload}>
        {(rows) => {
          const now = Date.now();
          const summary = summariseStakes(rows, now);
          const calendar = unlockCalendar(rows, now);
          return (
            <>
              <StatRow
                items={[
                  { label: t('sActive'), value: show(summary.active) },
                  { label: t('sLocked'), value: show(summary.locked) },
                  { label: t('sFree'), value: show(summary.free) },
                  { label: t('sPending'), value: show(summary.pending) },
                  { label: t('sUnstaking'), value: show(summary.unstaking) },
                  { label: t('sClosed'), value: show(summary.closed) },
                  { label: t('sCount'), value: summary.count },
                ]}
              />
              <p className="muted">
                <Copy k="loadedNote" />
              </p>
              <h3>
                <Copy k="calendarTitle" />
              </h3>
              {calendar.length ? (
                <DataTable headers={[t('colAmount'), t('colTerm'), t('colUnlocks'), t('colLeft')]} label={t('calendarTitle')}>
                  {calendar.map((unlock) => (
                    <tr key={unlock.id}>
                      <td>{show(unlock.amount)}</td>
                      <td>{t(`term_${unlock.tier}`)}</td>
                      <td>
                        <time dateTime={unlock.unlocksAt}>{unlock.unlocksAt.slice(0, 10)}</time>
                      </td>
                      <td>{unlock.daysLeft}</td>
                    </tr>
                  ))}
                </DataTable>
              ) : (
                <EmptyState title={<Copy k="calendarEmpty" />} />
              )}
              <Button
                variant="secondary"
                disabled={!rows.length}
                onClick={() => setExported(downloadCsv('token-stakes.csv', toCsv(STAKE_CSV_HEADER, stakeRows(rows))))}
              >
                <Copy k="export" />
              </Button>
              {exported !== null ? (
                <p role="status">
                  <Copy k={exported ? 'exported' : 'exportFail'} />
                </p>
              ) : null}
            </>
          );
        }}
      </Read>
      <h3>
        <Copy k="ticketTitle" />
      </h3>
      <div className="depth-filters">
        <Field
          label={t('ticketAmount')}
          inputMode="decimal"
          value={amount}
          error={amount && !validStakeAmount(amount) ? t('ticketInvalid') : undefined}
          onChange={(event) => setAmount(event.target.value.trim())}
        />
        <Select
          label={t('ticketTerm')}
          value={term}
          onChange={(value) => setTerm(value as StakeRow['tier'])}
          options={(['flex', 'm3', 'm12'] as const).map((value) => ({ value, label: t(`term_${value}`) }))}
        />
      </div>
      <p className="muted">
        {t('ticketLock')}: {STAKE_LOCK_DAYS[term] ? t('lockDays', { days: STAKE_LOCK_DAYS[term] }) : t('noLock')}
      </p>
      <DisabledAction label={t('ticketReview')} reason={t('ticketBlocked')} />
    </Panel>
  );
}
