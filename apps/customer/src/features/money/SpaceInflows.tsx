import { useState } from 'react';
import { Download } from 'lucide-react';
import { Button } from '../../shared/ui';
import { refusalCopy } from '../../data/refusals';
import { decodeBase64, monthRange, saveFile, shortFingerprint } from '../../screens/money/statement-model';
import { useSession } from '../session/session';
import type { Space } from './client';
import {
  amount,
  date,
  endsField,
  funds,
  iso,
  NoRows,
  positiveMoney,
  ResourceView,
  scheduleCadenceField,
  scheduleWindowIssue,
  Section,
  startsField,
  useBankRead,
  type ActionSpec,
} from './components';
import { statementFileSchema } from './contracts';
import { spaceInflowCopy } from './space-inflow-copy';

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
  const orders = useBankRead('transfers.listSchedules', { limit: LIST_LIMIT, toSpaceId: space.id });
  const rules = useBankRead('autoInvest.list', { limit: LIST_LIMIT, targetSpaceId: space.id });
  const policy = useBankRead('autoInvest.policy', undefined);
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
      procedure: 'transfers.schedule',
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
      procedure: 'autoInvest.createRoundUp',
      unit: space.assetId,
      fields: [{ ...positiveMoney(space.assetId, 'granularity', t('roundupField')), hint: t('roundupHint') }],
      facts: [[t('into'), space.name]],
      notes: [t('roundupNote'), t('roundupOne')],
      input: (values) => ({ assetId: space.assetId, targetSpaceId: space.id, granularity: values.granularity }),
    });

  return (
    <div className="money-space-inflows" data-testid="space-inflows">
      <Section
        title={t('title')}
        description={t('description')}
        actions={
          <>
            <Button variant="secondary" onClick={save} disabled={!main}>
              {t('save')}
            </Button>
            <Button variant="secondary" onClick={addRoundUp} disabled={!automatic}>
              {t('addRoundup')}
            </Button>
          </>
        }
      >
        {!main && <p className="money-caption">{t('noMain')}</p>}
        {policy.resource.status === 'ready' && !automatic && <p className="money-caption">{t('roundupOff')}</p>}
        {policy.resource.status === 'failed' && (
          <p className="money-caption">
            {t('roundupUnread')}{' '}
            <Button variant="ghost" onClick={policy.reload}>
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
                <article className="money-record" key={row.id} data-testid="space-inflow-order" data-id={row.id}>
                  <header>
                    <h4>{t('order', { amount: funds(row.amount, row.assetId), cadence: cadence(row.cadence) })}</h4>
                  </header>
                  <dl className="detail-list">
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
                <article className="money-record" key={row.id} data-testid="space-inflow-roundup" data-id={row.id}>
                  <header>
                    <h4>{t('roundup', { amount: amount(row.amount, row.assetId) })}</h4>
                  </header>
                  <dl className="detail-list">
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
    const result = await api.query('bank', 'statements.export', { from: range.from, to, spaceId: space.id, format }, statementFileSchema);
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
      className="money-statement"
      aria-label={t('statement')}
      onSubmit={(event) => {
        event.preventDefault();
        void download();
      }}
    >
      <h2 className="money-statement__h">{t('statement')}</h2>
      <p className="money-detail__note">{t('statementHint')}</p>
      <div className="money-statement__row">
        <label className="money-bar__field">
          <span>{t('month')}</span>
          <input type="month" value={month} max={monthOf(now)} onChange={(event) => setMonth(event.target.value)} />
        </label>
        <label className="money-bar__field">
          <span>{t('format')}</span>
          <select value={format} onChange={(event) => setFormat(event.target.value as 'pdf' | 'csv')}>
            <option value="csv">CSV</option>
            <option value="pdf">PDF</option>
          </select>
        </label>
        <Button type="submit" variant="secondary" disabled={busy || problem !== null}>
          <Download size={16} aria-hidden="true" />
          {t('download')}
        </Button>
      </div>
      <p className="money-detail__note" role="status" aria-live="polite">
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
