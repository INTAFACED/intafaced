import { useState } from 'react';
import { Download } from 'lucide-react';
import { Button, Field, Select } from '@intafaced/ui/lit';
import { refusalCopy } from '../../../data/refusals';
import { decodeBase64, monthRange, saveFile, shortFingerprint } from '../../../screens/money/statement-model';
import { useSession } from '../../session';
import type { Space } from '../client';
import {
  amount,
  date,
  endsField,
  funds,
  iso,
  positiveMoney,
  scheduleCadenceField,
  scheduleWindowIssue,
  startsField,
  type ActionSpec,
  useBankRecord,
} from '../components';
import { NoRows, BankSection as Section } from '../bank-frame/BankFrame';
import { ReadView as ResourceView } from '../../../shared/read-state';
import { spaceInflowCopy } from '../space-inflow-copy';
import { BANK_AUTO_INVEST_LIST, BANK_AUTO_INVEST_POLICY } from '@intafaced/contracts/bank-auto-invest-procedures';
import { BANK_TRANSFERS_LIST_SCHEDULES } from '@intafaced/contracts/bank-transfers-procedures';
import { BANK_STATEMENTS_EXPORT } from '@intafaced/contracts/bank-statements-procedures';
import { BANK_TRANSFERS_SCHEDULE } from '@intafaced/contracts/bank-transfers-2-procedures';
import { BANK_AUTO_INVEST_CREATE_ROUND_UP } from '@intafaced/contracts/bank-auto-invest-2-procedures';

const LIST_LIMIT = 50;

/** "YYYY-MM" of a moment, in UTC. */
const monthOf = (at: Date) => `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`;

/**
 * What moves into one of the person's own named spaces on its own (BK-pots-02, J-bank-07 #3): the standing orders that
 * pay into it and the card round-up that goes into it, each the bank's own instruction, with doors to add either; then
 * the space's own signed statement. Every figure is the bank's answer; nothing here works out a balance. Mounted for named
 * spaces only.
 */
export function SpaceInflows({ space, spaces, open }: { space: Space; spaces: Space[]; open: (spec: ActionSpec) => void }) {
  const { t } = spaceInflowCopy.useCopy();
  // Read for this space only, so an order or a round-up is never lost behind other ones on a page.
  const orders = useBankRecord(BANK_TRANSFERS_LIST_SCHEDULES, { limit: LIST_LIMIT, toSpaceId: space.id });
  const rules = useBankRecord(BANK_AUTO_INVEST_LIST, { limit: LIST_LIMIT, targetSpaceId: space.id });
  const policy = useBankRecord(BANK_AUTO_INVEST_POLICY, undefined);
  const main = spaces.find((row) => row.kind === 'primary' && row.assetId === space.assetId);
  const automatic = policy.resource.status === 'ready' && policy.resource.data.enabled;
  const reload = () => {
    orders.reload();
    rules.reload();
    policy.reload();
  };
  const cadence = (value: string) =>
    value === 'daily' || value === 'weekly' || value === 'monthly' || value === 'once' ? t(value) : value;
  const status = (value: string) =>
    value === 'active' || value === 'paused' || value === 'cancelled' || value === 'completed' ? t(value) : value;

  const save = () =>
    main &&
    open({
      title: t('saveTitle'),
      record: BANK_TRANSFERS_SCHEDULE,
      unit: space.assetId,
      fields: [positiveMoney(space.assetId), scheduleCadenceField, startsField, endsField],
      facts: [
        [t('from'), main.name],
        [t('into'), space.name],
      ],
      notes: [t('saveNote')],
      validate: scheduleWindowIssue,
      input: (values, requestId) => ({
        fromSpaceId: main.id,
        toSpaceId: space.id,
        amount: values.amount,
        scheduleId: requestId,
        cadence: values.cadence,
        startsAt: iso(values.startsAt!),
        ...(values.endsAt ? { endsAt: iso(values.endsAt) } : {}),
      }),
    });
  const addRoundUp = () =>
    open({
      title: t('roundupTitle'),
      record: BANK_AUTO_INVEST_CREATE_ROUND_UP,
      unit: space.assetId,
      fields: [{ ...positiveMoney(space.assetId, 'granularity', t('roundupField')), hint: t('roundupHint') }],
      facts: [[t('into'), space.name]],
      notes: [t('roundupNote'), t('roundupOne')],
      input: (values) => ({ assetId: space.assetId, targetSpaceId: space.id, granularity: values.granularity }),
    });

  return (
    <div className="lt-body" data-testid="space-inflows">
      <Section
        title={t('title')}
        description={t('description')}
        actions={
          <>
            <Button tone="secondary" onClick={save} disabled={!main}>
              {t('save')}
            </Button>
            <Button tone="secondary" onClick={addRoundUp} disabled={!automatic}>
              {t('addRoundup')}
            </Button>
          </>
        }
      >
        {!main && <p className="lt-hint">{t('noMain')}</p>}
        {policy.resource.status === 'ready' && !automatic && <p className="lt-hint">{t('roundupOff')}</p>}
        {policy.resource.status === 'failed' && (
          <p className="lt-hint">
            {t('roundupUnread')}{' '}
            <Button tone="quiet" onClick={policy.reload}>
              {t('retry')}
            </Button>
          </p>
        )}
        <h3>{t('orders')}</h3>
        <ResourceView resource={orders.resource} reload={reload}>
          {(rows) => {
            const into = rows.filter((row) => row.toSpaceId === space.id);
            return into.length ? (
              into.map((row) => (
                <article className="lt-stack" key={row.id} data-testid="space-inflow-order" data-id={row.id}>
                  <header>
                    <h4>{t('order', { amount: funds(row.amount, row.assetId), cadence: cadence(row.cadence) })}</h4>
                  </header>
                  <dl className="lt-kv">
                    <div>
                      <dt>{t('nextRun')}</dt>
                      <dd>{date(row.nextRunAt)}</dd>
                    </div>
                    <div>
                      <dt>{t('status')}</dt>
                      <dd>{status(row.status)}</dd>
                    </div>
                  </dl>
                </article>
              ))
            ) : (
              <NoRows title={t('noOrders')} />
            );
          }}
        </ResourceView>
        <h3>{t('roundups')}</h3>
        <ResourceView resource={rules.resource} reload={reload}>
          {(rows) => {
            const into = rows.filter((row) => row.kind === 'card_roundup' && row.targetSpaceId === space.id);
            return into.length ? (
              into.map((row) => (
                <article className="lt-stack" key={row.id} data-testid="space-inflow-roundup" data-id={row.id}>
                  <header>
                    <h4>{t('roundup', { amount: amount(row.amount, row.assetId) })}</h4>
                  </header>
                  <dl className="lt-kv">
                    <div>
                      <dt>{t('status')}</dt>
                      <dd>{status(row.status)}</dd>
                    </div>
                  </dl>
                </article>
              ))
            ) : (
              <NoRows title={t('noRoundup')} />
            );
          }}
        </ResourceView>
      </Section>
      <SpaceStatement key={space.id} space={space} />
    </div>
  );
}

type Outcome = { kind: 'done'; filename: string; rows: number; fingerprint: string } | { kind: 'error'; words: string } | null;

/** One space's signed statement for a month. The month running now covers its start up to now. */
function SpaceStatement({ space }: { space: Space }) {
  const { t } = spaceInflowCopy.useCopy();
  const { api } = useSession();
  const [month, setMonth] = useState(() => monthOf(new Date()));
  const [format, setFormat] = useState<'pdf' | 'csv'>('csv');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const range = monthRange(month);
  const now = new Date();
  const problem = range === null ? t('monthNeeded') : Date.parse(range.from) > now.getTime() ? t('monthAhead') : null;

  async function download() {
    if (busy || !range || problem) return;
    setBusy(true);
    setOutcome(null);
    const to = new Date(Math.min(Date.parse(range.to), Date.now())).toISOString();
    const result = await api.call(BANK_STATEMENTS_EXPORT, { from: range.from, to, spaceId: space.id, format });
    setBusy(false);
    if (!result.ok) {
      const code = result.code ?? '';
      const words =
        code === 'bank.statement_too_large'
          ? t('tooLarge')
          : code === 'bank.statement_unavailable'
            ? t('unavailable')
            : refusalCopy(code || result.reason).title;
      setOutcome({ kind: 'error', words });
      return;
    }
    const bytes = decodeBase64(result.data.bodyBase64);
    if (!bytes) {
      setOutcome({ kind: 'error', words: t('unreadable') });
      return;
    }
    saveFile(bytes, result.data.contentType, result.data.filename);
    setOutcome({
      kind: 'done',
      filename: result.data.filename,
      rows: result.data.rowCount,
      fingerprint: shortFingerprint(result.data.sha256),
    });
  }

  return (
    <form
      className="lt-stack"
      aria-label={t('statement')}
      onSubmit={(event) => {
        event.preventDefault();
        void download();
      }}
    >
      <h2>{t('statement')}</h2>
      <p className="lt-hint">{t('statementHint')}</p>
      <div className="lt-actions">
        <Field label={t('month')} type="month" value={month} max={monthOf(now)} onChange={(event) => setMonth(event.target.value)} />
        <Select
          label={t('format')}
          value={format}
          onChange={(value) => setFormat(value === 'pdf' ? 'pdf' : 'csv')}
          options={[
            { value: 'csv', label: 'CSV' },
            { value: 'pdf', label: 'PDF' },
          ]}
        />
        <Button type="submit" tone="secondary" disabled={busy || problem !== null}>
          <Download size={16} aria-hidden="true" />
          {t('download')}
        </Button>
      </div>
      <p className="lt-hint" role="status" aria-live="polite">
        {problem ??
          (busy
            ? t('preparing')
            : outcome?.kind === 'done'
              ? t('done', { name: outcome.filename, count: outcome.rows, fingerprint: outcome.fingerprint })
              : outcome?.kind === 'error'
                ? outcome.words
                : '')}
      </p>
    </form>
  );
}
