import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { z, type ZodType } from 'zod';
import { Button } from '@intafaced/ui';
import { FlowTemplate, type RoomState } from '@intafaced/ui/lit/templates';
import {
  BUSINESS_BOOK_FORMATS,
  businessAccountingConnectionSchema,
  businessBookLineSchema,
  businessBookStatementSchema,
  businessBooksOverviewSchema,
  businessCodingRuleSchema,
  type BusinessBookFormat,
  type BusinessBookLine,
  type BusinessBookStatement,
} from '@intafaced/contracts/bank-business-books';
import { defineCopy } from '../../../shared/i18n';
import type { ApiResult } from '../../../shared/api';
import { useResource, type Resource } from '../../../shared/resource';
import { useSession } from '../../session/session';
import { StepUpConfirm } from '../StepUpConfirm';
import { useHeldId } from '../business-team/held-id';

/**
 * A business keeps its books in order (J-bank-23; BK-bexp-03, BK-bexp-04, BK-bexp-05), on the flow template.
 *
 * `/bank/business/books`: in Business mode, the business picked in the account menu. Every line is the partner bank's
 * own record of the business's account. Connecting accounting software needs `vendor.accounting`, switched off in this
 * build: the record is kept, and the bank feed downloads as a file. A rule "payee contains … sets …" is tested before it
 * is saved; lines are coded one at a time or in bulk, with GL codes. A month's statement downloads in CSV, MT940,
 * CAMT.053 and QIF, each checked by the bank against the partner's own statement. A month further back than the partner's
 * strong customer authentication age asks for a fresh confirmation first. Every check is the bank's.
 */
const copy = defineCopy('money.business-books', {
  title: 'Books and statements',
  description: 'Code your lines, export statements and connect accounting',
  personalTitle: 'Choose a business',
  personalBody: 'You are in your personal profile. Pick a business in the account menu to see its books.',
  signedOutTitle: 'Sign in to continue',
  signedOutBody: 'A business’s books belong to its members.',
  signIn: 'Sign in',
  readFailedTitle: 'This could not be read',
  refusedTitle: 'It was not done',
  heldBy: 'Every line is {label}’s own record of this account.',
  month: 'Month',
  accountingTitle: 'Accounting software',
  connect: 'Connect accounting',
  switchedOff: 'Needs vendor.accounting, switched off in this build. Nothing was connected.',
  connectionKept: 'Connection record kept: switched off, asked {attempts} times, last on {at}.',
  feedTitle: 'Bank feed by file',
  feedBody: 'Import this file into your accounting software: every line of the month with its id, payee and coding.',
  feed: 'Download bank feed file (CSV)',
  feedDone: 'Bank feed file downloaded: {lines} lines.',
  rulesTitle: 'Coding rules',
  payeeContains: 'Payee contains',
  category: 'Category',
  glCode: 'GL code',
  testRule: 'Test rule',
  saveRule: 'Save rule',
  matches: 'Test run: {count} matches this month. Nothing is coded until you save.',
  saved: 'Rule saved. Matching lines are coded now and as they arrive.',
  rule: 'Payee contains “{text}” sets {category}',
  ruleGl: ' (GL {gl})',
  rulesEmpty: 'No rules yet.',
  linesTitle: 'Lines',
  linesEmpty: 'No lines this month.',
  select: 'Select line {id}',
  pick: 'Select',
  bulkTitle: 'Code the selected lines',
  bulk: 'Code {count} selected',
  coded: '{count} lines coded.',
  uncoded: 'Not coded',
  byRule: 'by rule',
  byPerson: 'by hand',
  statementTitle: 'Statements',
  statementBody: 'Each file is checked against {label}’s own statement of the month: the same closing balance and line count.',
  exportAs: 'Export {format}',
  exported: '{file}: closing balance {closing} {asset}, {lines} lines. {label}’s statement: {theirClosing}, {theirLines} lines.',
  window: '{label} keeps {days} days of history. A month further back than {sca} days needs a fresh confirmation.',
  needsSca: 'This month is further back than {sca} days: confirm it’s you before exporting.',
  scaWhy: 'Statements further back than {sca} days need strong customer authentication.',
  scaCode: 'Authenticator code',
  scaHint: 'The 6-digit code from your authenticator app',
  scaShort: 'Enter the 6-digit code',
  scaNoFactor: 'You have no authenticator app or passkey, so no fresh confirmation can be given.',
  scaSendWithout: 'Export without it',
  scaDone: 'Confirmed for this month’s export.',
});
type T = ReturnType<typeof copy.useCopy>['t'];
type Failed = Extract<ApiResult<unknown>, { ok: false }>;

const FORMAT_NAMES: Record<BusinessBookFormat, string> = { csv: 'CSV', mt940: 'MT940', camt053: 'CAMT.053', qif: 'QIF' };
const DAY_MS = 24 * 60 * 60 * 1000;

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={`books-${id}`} data-testid={`books-${id}`}>
      <h2 id={`books-${id}`}>{title}</h2>
      {children}
    </section>
  );
}

/** One read of the bank; while a reload of the same read is on its way the last answer stays on screen. */
function useBank<S>(procedure: string, input: unknown, schema: ZodType<S>, base: string, rev = 0) {
  const { api, userId } = useSession();
  const read = useResource<S>(
    (signal) =>
      userId && input !== null
        ? api.query('bank', procedure, input, schema, { signal })
        : Promise.resolve({ ok: false as const, reason: 'unauthorized' as const, message: '' }),
    `books:${procedure}:${userId ?? 'out'}:${base}:${rev}`,
  );
  const kept = useRef<{ base: string; data: S } | null>(null);
  const keyed = `${userId ?? 'out'}:${base}`;
  if (read.resource.status === 'ready') kept.current = { base: keyed, data: read.resource.data };
  if (read.resource.status === 'loading' && kept.current?.base === keyed) {
    return { resource: { status: 'ready', data: kept.current.data } as Resource<S>, reload: read.reload };
  }
  return read;
}

const ready = <S,>(r: Resource<S>): S | null => (r.status === 'ready' ? r.data : null);

/** The month `YYYY-MM` as the period the bank reads: its first instant, and the next month's first (exclusive). */
function monthPeriod(month: string): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return { from: new Date(Date.UTC(y, m - 1, 1)).toISOString(), to: new Date(Date.UTC(y, m, 1)).toISOString() };
}

function save(file: BusinessBookStatement) {
  const bytes = Uint8Array.from(atob(file.bodyBase64), (ch) => ch.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: file.contentType }));
  const a = document.createElement('a');
  a.href = url;
  a.download = file.fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** `/bank/business/books`. */
export function BusinessBooksRoom() {
  const { t } = copy.useCopy();
  const { userId, profiles } = useSession();
  const business = profiles.business;
  const accountId = business?.accountId ?? null;
  const [rev, setRev] = useState(0);
  const overview = useBank('businessBooks.overview', accountId ? { accountId } : null, businessBooksOverviewSchema, accountId ?? '-', rev);
  let state: RoomState = { kind: 'ready' };
  if (!userId)
    state = {
      kind: 'refused',
      refusal: {
        variant: 'refused',
        title: t('signedOutTitle'),
        body: t('signedOutBody'),
        action: { label: t('signIn'), href: `/login?redirect=${encodeURIComponent('/bank/business/books')}` },
      },
    };
  else if (!business) state = { kind: 'refused', refusal: { variant: 'refused', title: t('personalTitle'), body: t('personalBody') } };
  else if (overview.resource.status === 'failed')
    state = { kind: 'refused', refusal: { variant: 'refused', title: t('readFailedTitle'), body: overview.resource.failure.message } };
  else if (overview.resource.status !== 'ready') state = { kind: 'loading' };
  const o = ready(overview.resource);
  return (
    <FlowTemplate
      title={t('title')}
      description={t('description')}
      state={state}
      step={
        o && accountId ? (
          <div data-testid="books-room" data-account={accountId}>
            <p data-testid="books-business">{o.account.name}</p>
            {o.partnerLabel ? <p>{t('heldBy', { label: o.partnerLabel })}</p> : null}
            <Books overview={o} reloadTop={() => setRev((n) => n + 1)} t={t} />
          </div>
        ) : null
      }
    />
  );
}

function Books({ overview: o, reloadTop, t }: { overview: z.infer<typeof businessBooksOverviewSchema>; reloadTop: () => void; t: T }) {
  const { api } = useSession();
  const accountId = o.account.id;
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [rev, setRev] = useState(0);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<Failed | null>(null);
  const [notice, setNotice] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const p = monthPeriod(month);
  const lines = useBank(
    'businessBooks.lines',
    { accountId, ...p },
    z.object({ items: z.array(businessBookLineSchema) }),
    `${accountId}:${month}`,
    rev,
  );
  const items = ready(lines.resource)?.items ?? [];
  const admin = o.permissions.includes('manage_team');
  const bookkeeper = o.permissions.includes('export');
  const label = o.partnerLabel ?? '';
  const rules = o.historyRules;
  const needsSca = rules !== null && Date.parse(p.from) < Date.now() - rules.scaAfterDays * DAY_MS;

  async function act<S>(go: () => Promise<ApiResult<S>>, done: (data: S) => string): Promise<S | null> {
    if (busy) return null;
    setBusy(true);
    setFailed(null);
    setNotice('');
    const out = await go();
    setBusy(false);
    if (!out.ok) {
      setFailed(out);
      return null;
    }
    setNotice(done(out.data));
    return out.data;
  }
  const refresh = () => {
    setRev((n) => n + 1);
    reloadTop();
  };

  return (
    <>
      {notice ? (
        <p role="status" data-testid="books-notice">
          {notice}
        </p>
      ) : null}
      {failed ? (
        <p role="alert" data-testid="books-refusal" data-code={failed.code ?? ''}>
          {t('refusedTitle')}: {failed.message}
        </p>
      ) : null}
      <label className="field">
        <span>{t('month')}</span>
        <input
          type="month"
          value={month}
          onChange={(e) => {
            if (/^\d{4}-\d{2}$/.test(e.target.value)) {
              setMonth(e.target.value);
              setSelected([]);
            }
          }}
        />
      </label>

      <Section id="accounting" title={t('accountingTitle')}>
        {o.connection ? (
          <p data-testid="books-connection" data-status={o.connection.status} data-needs={o.connection.needs}>
            {t('switchedOff')}{' '}
            {t('connectionKept', { attempts: String(o.connection.attempts), at: o.connection.requestedAt.slice(0, 16).replace('T', ' ') })}
          </p>
        ) : null}
        {admin ? (
          <Button
            type="button"
            disabled={busy}
            onClick={() =>
              void act(
                () => api.mutate('bank', 'businessBooks.connectAccounting', { accountId }, businessAccountingConnectionSchema),
                () => {
                  refresh();
                  return t('switchedOff');
                },
              )
            }
          >
            {t('connect')}
          </Button>
        ) : null}
        <h3>{t('feedTitle')}</h3>
        <p>{t('feedBody')}</p>
        {bookkeeper ? <FeedButton accountId={accountId} period={p} busy={busy} act={act} t={t} /> : null}
      </Section>

      {bookkeeper ? (
        <Section id="rules" title={t('rulesTitle')}>
          <RuleForm accountId={accountId} period={p} busy={busy} act={act} onSaved={refresh} t={t} />
        </Section>
      ) : null}
      <ul data-testid="books-rule-list">
        {o.rules.length === 0 ? <li>{t('rulesEmpty')}</li> : null}
        {o.rules.map((r) => (
          <li key={r.id} data-testid="books-rule" data-rule={r.id}>
            {t('rule', { text: r.payeeContains, category: r.category })}
            {r.glCode ? t('ruleGl', { gl: r.glCode }) : ''}
          </li>
        ))}
      </ul>

      <Section id="lines" title={t('linesTitle')}>
        {lines.resource.status === 'failed' ? <p role="alert">{lines.resource.failure.message}</p> : null}
        {items.length === 0 && lines.resource.status === 'ready' ? <p>{t('linesEmpty')}</p> : null}
        <ul>
          {items.map((l) => (
            <Line
              key={l.id}
              line={l}
              asset={o.account.assetId}
              selectable={bookkeeper}
              checked={selected.includes(l.id)}
              onToggle={(on) => setSelected((s) => (on ? [...s, l.id] : s.filter((x) => x !== l.id)))}
              t={t}
            />
          ))}
        </ul>
        {bookkeeper && items.length > 0 ? (
          <BulkForm
            accountId={accountId}
            period={p}
            selected={selected}
            busy={busy}
            act={act}
            onDone={() => {
              setSelected([]);
              refresh();
            }}
            t={t}
          />
        ) : null}
      </Section>

      {bookkeeper ? (
        <Section id="statements" title={t('statementTitle')}>
          <p>{t('statementBody', { label })}</p>
          {rules ? (
            <p data-testid="books-window" data-history-days={rules.historyDays} data-sca-days={rules.scaAfterDays}>
              {t('window', { label: rules.label, days: String(rules.historyDays), sca: String(rules.scaAfterDays) })}
            </p>
          ) : null}
          <Statements
            key={month}
            accountId={accountId}
            period={p}
            needsSca={needsSca}
            sca={rules?.scaAfterDays ?? 0}
            asset={o.account.assetId}
            busy={busy}
            act={act}
            t={t}
          />
        </Section>
      ) : null}
    </>
  );
}

type Act = <S>(go: () => Promise<ApiResult<S>>, done: (data: S) => string) => Promise<S | null>;
type Period = { from: string; to: string };

function Line({
  line: l,
  asset,
  selectable,
  checked,
  onToggle,
  t,
}: {
  line: BusinessBookLine;
  asset: string;
  selectable: boolean;
  checked: boolean;
  onToggle: (on: boolean) => void;
  t: T;
}) {
  return (
    <li
      data-testid="books-line"
      data-line={l.id}
      data-payee={l.payee}
      data-amount={l.amount}
      data-category={l.category ?? ''}
      data-gl={l.glCode ?? ''}
      data-coded-by={l.codedBy ?? ''}
    >
      {selectable ? (
        <label className="money-check">
          <input type="checkbox" aria-label={t('select', { id: l.id })} checked={checked} onChange={(e) => onToggle(e.target.checked)} />
          <span>{t('pick')}</span>
        </label>
      ) : null}{' '}
      <span>{l.bookedAt.slice(0, 10)}</span> <span>{l.payee}</span> <span>{`${l.amount} ${asset}`}</span>{' '}
      <span>
        {l.category || l.glCode
          ? `${[l.category, l.glCode ? `GL ${l.glCode}` : null].filter(Boolean).join(' · ')} (${l.codedBy === 'rule' ? t('byRule') : t('byPerson')})`
          : t('uncoded')}
      </span>{' '}
      <code>{l.id}</code>
    </li>
  );
}

function FeedButton({ accountId, period, busy, act, t }: { accountId: string; period: Period; busy: boolean; act: Act; t: T }) {
  const { api } = useSession();
  return (
    <Button
      type="button"
      disabled={busy}
      onClick={() =>
        void act(
          () =>
            api.mutate(
              'bank',
              'businessBooks.exportStatement',
              { accountId, ...period, format: 'csv', exportId: crypto.randomUUID() },
              businessBookStatementSchema,
            ),
          (file) => {
            save(file);
            return t('feedDone', { lines: String(file.lineCount) });
          },
        )
      }
    >
      {t('feed')}
    </Button>
  );
}

function RuleForm({
  accountId,
  period,
  busy,
  act,
  onSaved,
  t,
}: {
  accountId: string;
  period: Period;
  busy: boolean;
  act: Act;
  onSaved: () => void;
  t: T;
}) {
  const { api } = useSession();
  const held = useHeldId();
  const [text, setText] = useState('');
  const [category, setCategory] = useState('');
  const [gl, setGl] = useState('');
  const [tested, setTested] = useState<BusinessBookLine[] | null>(null);
  return (
    <form
      aria-label={t('rulesTitle')}
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        void act(
          () =>
            api.mutate(
              'bank',
              'businessBooks.saveRule',
              { accountId, ruleId: held.id, payeeContains: text.trim(), category: category.trim(), glCode: gl.trim() || null },
              businessCodingRuleSchema,
            ),
          () => {
            held.settle({ ok: true });
            setTested(null);
            onSaved();
            return t('saved');
          },
        );
      }}
    >
      <label className="field">
        <span>{t('payeeContains')}</span>
        <input value={text} onChange={(e) => (setText(e.target.value), setTested(null))} required maxLength={80} />
      </label>
      <label className="field">
        <span>{t('category')}</span>
        <input value={category} onChange={(e) => setCategory(e.target.value)} required maxLength={60} />
      </label>
      <label className="field">
        <span>{t('glCode')}</span>
        <input value={gl} onChange={(e) => setGl(e.target.value)} maxLength={32} />
      </label>
      <Button
        type="button"
        disabled={busy || !text.trim()}
        onClick={() =>
          void act(
            () =>
              api.query(
                'bank',
                'businessBooks.testRule',
                { accountId, ...period, payeeContains: text.trim() },
                z.object({ matches: z.array(businessBookLineSchema) }),
              ),
            (r) => {
              setTested(r.matches);
              return t('matches', { count: String(r.matches.length) });
            },
          )
        }
      >
        {t('testRule')}
      </Button>
      {tested ? (
        <ul data-testid="books-rule-matches" data-count={tested.length}>
          {tested.map((l) => (
            <li key={l.id} data-testid="books-rule-match" data-line={l.id}>
              {l.payee} {l.amount}
            </li>
          ))}
        </ul>
      ) : null}
      <Button type="submit" variant="primary" disabled={busy || !text.trim() || !category.trim()}>
        {t('saveRule')}
      </Button>
    </form>
  );
}

function BulkForm({
  accountId,
  period,
  selected,
  busy,
  act,
  onDone,
  t,
}: {
  accountId: string;
  period: Period;
  selected: string[];
  busy: boolean;
  act: Act;
  onDone: () => void;
  t: T;
}) {
  const { api } = useSession();
  const [category, setCategory] = useState('');
  const [gl, setGl] = useState('');
  return (
    <form
      aria-label={t('bulkTitle')}
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        void act(
          () =>
            api.mutate(
              'bank',
              'businessBooks.codeLines',
              { accountId, ...period, lineIds: selected, category: category.trim() || null, glCode: gl.trim() || null },
              z.object({ items: z.array(businessBookLineSchema) }),
            ),
          (r) => {
            onDone();
            return t('coded', { count: String(r.items.length) });
          },
        );
      }}
    >
      <h3>{t('bulkTitle')}</h3>
      <label className="field">
        <span>{t('category')}</span>
        <input value={category} onChange={(e) => setCategory(e.target.value)} maxLength={60} />
      </label>
      <label className="field">
        <span>{t('glCode')}</span>
        <input value={gl} onChange={(e) => setGl(e.target.value)} maxLength={32} />
      </label>
      <Button type="submit" disabled={busy || selected.length === 0 || (!category.trim() && !gl.trim())}>
        {t('bulk', { count: String(selected.length) })}
      </Button>
    </form>
  );
}

function Statements({
  accountId,
  period,
  needsSca,
  sca,
  asset,
  busy,
  act,
  t,
}: {
  accountId: string;
  period: Period;
  needsSca: boolean;
  sca: number;
  asset: string;
  busy: boolean;
  act: Act;
  t: T;
}) {
  const { api } = useSession();
  // One export id for the month: a fresh confirmation is bound to it and the exact period, and covers all four formats.
  const [exportId] = useState(() => crypto.randomUUID());
  const [approval, setApproval] = useState<string | null | undefined>(undefined);
  const [files, setFiles] = useState<BusinessBookStatement[]>([]);
  const confirmed = !needsSca || approval !== undefined;
  return (
    <>
      {needsSca ? <p data-testid="books-needs-sca">{t('needsSca', { sca: String(sca) })}</p> : null}
      {needsSca && approval === undefined ? (
        <StepUpConfirm
          request={() => ({
            scope: 'bank.step_up.businessBooks.exportStatement',
            purpose: 'businessBooks.exportStatement',
            target: accountId,
            fields: { accountId, exportId, from: period.from, to: period.to },
          })}
          words={{
            why: t('scaWhy', { sca: String(sca) }),
            code: t('scaCode'),
            codeHint: t('scaHint'),
            codeShort: t('scaShort'),
            noFactor: t('scaNoFactor'),
            sendWithout: t('scaSendWithout'),
          }}
          disabled={busy}
          onApproved={(id) => setApproval(id)}
        />
      ) : null}
      {needsSca && approval ? <p data-testid="books-sca-done">{t('scaDone')}</p> : null}
      <div>
        {BUSINESS_BOOK_FORMATS.map((format) => (
          <Button
            key={format}
            type="button"
            disabled={busy || !confirmed}
            onClick={() =>
              void act(
                () =>
                  api.mutate(
                    'bank',
                    'businessBooks.exportStatement',
                    { accountId, ...period, format, exportId, ...(approval ? { stepUpApprovalId: approval } : {}) },
                    businessBookStatementSchema,
                  ),
                (file) => {
                  save(file);
                  setFiles((f) => [...f.filter((x) => x.format !== file.format), file]);
                  return t('exported', {
                    file: file.fileName,
                    closing: file.closing,
                    asset,
                    lines: String(file.lineCount),
                    label: file.partner.label,
                    theirClosing: file.partner.closing,
                    theirLines: String(file.partner.lines),
                  });
                },
              )
            }
          >
            {t('exportAs', { format: FORMAT_NAMES[format] })}
          </Button>
        ))}
      </div>
      <ul data-testid="books-files">
        {files.map((f) => (
          <li
            key={f.format}
            data-testid="books-file"
            data-format={f.format}
            data-closing={f.closing}
            data-lines={f.lineCount}
            data-partner-closing={f.partner.closing}
            data-partner-lines={f.partner.lines}
          >
            {t('exported', {
              file: f.fileName,
              closing: f.closing,
              asset,
              lines: String(f.lineCount),
              label: f.partner.label,
              theirClosing: f.partner.closing,
              theirLines: String(f.partner.lines),
            })}
          </li>
        ))}
      </ul>
    </>
  );
}
