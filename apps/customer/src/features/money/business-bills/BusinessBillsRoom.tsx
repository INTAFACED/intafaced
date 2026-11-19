import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { z, type ZodType } from 'zod';
import { Button } from '@intafaced/ui';
import { FlowTemplate, type RoomState } from '@intafaced/ui/lit/templates';
import {
  businessBillLimitsSchema,
  businessBillSchema,
  businessBillSettingsSchema,
  businessBillVendorSchema,
  type BusinessBill,
  type BusinessBillPayment,
} from '@intafaced/contracts/bank-business-bills';
import { businessTeamOverviewSchema } from '@intafaced/contracts/bank-business-team';
import { defineCopy } from '../../../shared/i18n';
import type { ApiResult } from '../../../shared/api';
import { useResource, type Resource } from '../../../shared/resource';
import { useSession } from '../../session/session';
import { useHeldId, type HeldId } from '../business-team/held-id';

/**
 * A business pays its suppliers' bills (J-bank-20; BK-bill-01 to BK-bill-03), on the flow template.
 *
 * `/bank/business/bills`: in Business mode, the business picked in the account menu: its bill inbox (by approval status,
 * then due date), the upload, pre-approved vendors and Bill Pay limits. `/bank/business/bill?id=`: one bill: the review of
 * what it says, a possible duplicate, its approvals, paying or scheduling it with a split, and each payment's answer.
 *
 * The business's money is the partner bank's. Paying a bill is one instruction to the partner, sent once; a split is the
 * business's own record beside it; nothing is posted to INTAFACED's own books. Every check is the bank's: this page shows
 * what the bank reports and the refusals it gives, by name.
 */
const copy = defineCopy('money.business-bills', {
  title: 'Bills',
  description: 'Your suppliers’ bills: the inbox, approvals and payments',
  billTitle: 'Bill',
  billDescription: 'Review the bill, its approvals and its payments',
  personalTitle: 'Choose a business',
  personalBody: 'You are in your personal profile. Pick a business in the account menu to see its bills.',
  signedOutTitle: 'Sign in to continue',
  signedOutBody: 'A business’s bills belong to its members.',
  signIn: 'Sign in',
  readFailedTitle: 'This could not be read',
  refusedTitle: 'It was not done',
  noId: 'This page needs a bill.',
  balance: 'Balance at {label}',
  balanceNotKnown: 'Not known: {label} has not reported it',
  balanceNone: 'This business’s money is not held at a partner bank.',
  uploadTitle: 'Add a bill',
  uploadBody: 'Upload the bill’s file. Email forwarding needs email delivery, which is not connected in this build.',
  file: 'Bill file',
  upload: 'Upload bill',
  uploaded: 'Bill added to the inbox.',
  inboxTitle: 'Inbox',
  inboxEmpty: 'No bills yet.',
  noVendor: 'Vendor not filled in',
  noAmount: 'amount not filled in',
  due: 'due {date}',
  noDue: 'no due date',
  maybeDuplicate: 'May be a duplicate of',
  duplicateCleared: 'Checked: not a duplicate',
  open: 'Open',
  status_inbox: 'In the inbox: to review',
  status_awaiting_approval: 'Waiting for {left} more approval(s)',
  status_approved: 'Approved: ready to pay',
  status_scheduled: 'Payment scheduled',
  status_paying: 'Sending to the partner bank: its answer is not known yet',
  status_paid: 'Paid through {label}',
  vendorsTitle: 'Pre-approved vendors',
  vendorsBody: 'A bill from a pre-approved vendor at or under its cap goes straight to payment. Any other bill goes to approvers.',
  vendorsEmpty: 'No pre-approved vendors.',
  vendorName: 'Vendor name',
  vendorCap: 'Cap',
  saveVendor: 'Save vendor',
  vendorSaved: 'Vendor saved.',
  upTo: 'up to {amount} {asset}',
  limitsTitle: 'Bill Pay limits',
  limitsBody: 'Every limit must be set before any bill is paid. A blank limit is not set, never unlimited.',
  perPayment: 'Per payment',
  daily: 'Per day',
  monthly: 'Per month',
  notSet: 'not set',
  saveLimits: 'Save limits',
  limitsSaved: 'Limits saved.',
  reviewTitle: 'What the bill says',
  reviewBody: 'Check every field before the bill goes on. Nothing is paid until a person has reviewed it.',
  readerNone: 'No bill reader is set: type each field from the bill.',
  readTitle: 'Read from the file',
  vendor: 'Vendor',
  reference: 'Reference',
  amount: 'Amount',
  dueDate: 'Due date',
  notRead: 'not read',
  saveReview: 'Save review',
  reviewSaved: 'Review saved.',
  duplicateTitle: 'Possible duplicate',
  duplicateBody: 'This bill looks like one already received. It cannot be paid until someone who manages the team checks it.',
  notDuplicate: 'Not a duplicate',
  submit: 'Send on for payment',
  submitted: 'Sent on.',
  backTitle: 'Back in the inbox',
  approvalTitle: 'Approval',
  preapproved: 'From a pre-approved vendor at or under its cap: no approvers needed.',
  needs: 'Needs {n} approver(s), none of them the person who sent it on.',
  ruleApplied: 'Rule that applied: over {amount}',
  sentOnBy: 'Sent on by @{handle}',
  approvedBy: '@{handle} approved',
  approve: 'Approve',
  approved: 'Approval recorded.',
  payTitle: 'Pay this bill',
  payBody: 'One payment to the partner bank for the whole bill. Categories are your own record beside it and add up to the bill.',
  payOn: 'Pay on (leave blank to pay now)',
  category: 'Category',
  lineAmount: 'Line amount',
  addLine: 'Add a line',
  removeLine: 'Remove line',
  payNow: 'Pay now',
  schedule: 'Schedule payment',
  paidDone: 'Payment sent to the partner bank.',
  scheduledDone: 'Payment scheduled.',
  paymentsTitle: 'Payments',
  paymentsEmpty: 'No payments yet.',
  attempt: 'Attempt {n}',
  pay_scheduled: 'Scheduled for {date}',
  pay_sending: 'Sending to the partner bank: its answer is not known yet',
  pay_sent: 'Sent to {label}',
  pay_cancelled: 'Cancelled before it was sent: it never reached the partner bank',
  pay_declined: 'Declined by the partner bank: nothing moved',
  pay_returned: 'Returned: the amount came back to the business’s account once',
  partnerSaid: 'The partner bank said',
  partnerRef: 'Partner reference',
  returnRef: 'Return reference',
  splitLine: '{category}: {amount} {asset}',
  cancel: 'Cancel payment',
  cancelled: 'Payment cancelled.',
  tryAgain: 'Try sending again',
  backToInbox: 'Back to the inbox',
});
type T = ReturnType<typeof copy.useCopy>['t'];

type Failed = Extract<ApiResult<unknown>, { ok: false }>;

function Refused({ out, t }: { out: Failed | null; t: T }) {
  if (!out) return null;
  return (
    <p role="alert" data-testid="bills-refusal" data-code={out.code ?? ''}>
      {t('refusedTitle')}: {out.message}
    </p>
  );
}

function Notice({ text }: { text: string }) {
  return text ? (
    <p role="status" data-testid="bills-notice">
      {text}
    </p>
  ) : null;
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={`bills-${id}`} data-testid={`bills-${id}`}>
      <h2 id={`bills-${id}`}>{title}</h2>
      {children}
    </section>
  );
}

function signedOutState(t: T, path: string): RoomState {
  return {
    kind: 'refused',
    refusal: {
      variant: 'refused',
      title: t('signedOutTitle'),
      body: t('signedOutBody'),
      action: { label: t('signIn'), href: `/login?redirect=${encodeURIComponent(path)}` },
    },
  };
}

/** One read of the bank; while a reload of the same read is on its way the last answer stays on screen. */
function useBank<S>(
  procedure: string,
  input: unknown,
  schema: ZodType<S>,
  base: string,
  rev = 0,
): { resource: Resource<S>; reload: () => void } {
  const { api, userId } = useSession();
  const read = useResource<S>(
    (signal) =>
      userId && input !== null
        ? api.query('bank', procedure, input, schema, { signal })
        : Promise.resolve({ ok: false as const, reason: 'unauthorized' as const, message: '' }),
    `bills:${procedure}:${userId ?? 'out'}:${base}:${rev}`,
  );
  const kept = useRef<{ base: string; data: S } | null>(null);
  const keyed = `${userId ?? 'out'}:${base}`;
  if (read.resource.status === 'ready') kept.current = { base: keyed, data: read.resource.data };
  if (read.resource.status === 'loading' && kept.current?.base === keyed) {
    return { resource: { status: 'ready', data: kept.current.data }, reload: read.reload };
  }
  return read;
}

/** A change through the bank: the refusal it gives is kept to show, and every read reloads after it. */
function useChange(after: () => void) {
  const { api } = useSession();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<Failed | null>(null);
  const [notice, setNotice] = useState('');
  async function run<S>(
    procedure: string,
    body: unknown,
    schema: ZodType<S>,
    done?: (data: S) => string,
    held?: HeldId,
  ): Promise<S | null> {
    if (busy) return null;
    setBusy(true);
    setFailed(null);
    setNotice('');
    const out = await api.mutate('bank', procedure, body, schema);
    setBusy(false);
    held?.settle(out);
    if (!out.ok) {
      setFailed(out);
      after();
      return null;
    }
    if (done) setNotice(done(out.data));
    after();
    return out.data;
  }
  return { busy, failed, notice, run };
}

function billStatus(b: BusinessBill, label: string, t: T): string {
  if (b.status === 'awaiting_approval') return t('status_awaiting_approval', { left: Math.max(0, b.approvalsNeeded - b.approvals.length) });
  if (b.status === 'paid') return t('status_paid', { label });
  return t(`status_${b.status}`);
}

function paymentStatus(p: BusinessBillPayment, label: string, t: T): string {
  if (p.status === 'scheduled') return t('pay_scheduled', { date: p.scheduledFor ?? '' });
  if (p.status === 'sent') return t('pay_sent', { label });
  return t(`pay_${p.status}`);
}

/** The business picked in the account menu, its partner figure, and the room's state. */
function useBusiness(path: string, t: T) {
  const { userId, profiles } = useSession();
  const business = profiles.business;
  const accountId = business?.accountId ?? null;
  const overview = useBank('businessTeam.overview', accountId ? { accountId } : null, businessTeamOverviewSchema, accountId ?? '-');
  let state: RoomState = { kind: 'ready' };
  if (!userId) state = signedOutState(t, path);
  else if (!business) state = { kind: 'refused', refusal: { variant: 'refused', title: t('personalTitle'), body: t('personalBody') } };
  else if (overview.resource.status === 'failed')
    state = { kind: 'refused', refusal: { variant: 'refused', title: t('readFailedTitle'), body: overview.resource.failure.message } };
  else if (overview.resource.status !== 'ready') state = { kind: 'loading' };
  const o = overview.resource.status === 'ready' ? overview.resource.data : null;
  return { accountId, o, state, reloadTop: overview.reload };
}

function Balance({ o, t }: { o: z.infer<typeof businessTeamOverviewSchema>; t: T }) {
  if (!o.partner) return <p data-testid="bills-balance">{t('balanceNone')}</p>;
  return (
    <p data-testid="bills-balance" data-amount={o.partner.amount ?? ''}>
      {o.partner.amount === null
        ? t('balanceNotKnown', { label: o.partner.label })
        : `${t('balance', { label: o.partner.label })}: ${o.partner.amount} ${o.account.assetId}`}
    </p>
  );
}

async function base64Of(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let raw = '';
  for (let i = 0; i < bytes.length; i += 0x8000) raw += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(raw);
}

/** `/bank/business/bills`. */
export function BusinessBillsRoom() {
  const { t } = copy.useCopy();
  const { accountId, o, state, reloadTop } = useBusiness('/bank/business/bills', t);
  return (
    <FlowTemplate
      title={t('title')}
      description={t('description')}
      state={state}
      step={
        o && accountId ? (
          <div data-testid="bills-room" data-account={accountId}>
            <p data-testid="bills-business">{o.account.name}</p>
            <Balance o={o} t={t} />
            <InboxParts accountId={accountId} label={o.partner?.label ?? ''} reloadTop={reloadTop} t={t} />
          </div>
        ) : null
      }
      summary={
        <div>
          <h2>{t('vendorsTitle')}</h2>
          <p>{t('vendorsBody')}</p>
          <p>{t('limitsBody')}</p>
        </div>
      }
    />
  );
}

function InboxParts({ accountId, label, reloadTop, t }: { accountId: string; label: string; reloadTop: () => void; t: T }) {
  const [rev, setRev] = useState(0);
  const input = { accountId };
  const bills = useBank('businessBills.list', input, z.array(businessBillSchema), accountId, rev);
  const settings = useBank('businessBills.settings', input, businessBillSettingsSchema, accountId, rev);
  const billId = useHeldId();
  const change = useChange(() => {
    setRev((n) => n + 1);
    reloadTop();
  });
  const [file, setFile] = useState<File | null>(null);
  const [vendorName, setVendorName] = useState('');
  const [vendorCap, setVendorCap] = useState('');
  const [limits, setLimits] = useState<{ perPayment: string; daily: string; monthly: string } | null>(null);
  const list = bills.resource.status === 'ready' ? bills.resource.data : [];
  const s = settings.resource.status === 'ready' ? settings.resource.data : null;
  const asset = s?.assetId ?? '';
  const shownLimits = limits ?? {
    perPayment: s?.limits.perPayment ?? '',
    daily: s?.limits.daily ?? '',
    monthly: s?.limits.monthly ?? '',
  };

  return (
    <>
      <Notice text={change.notice} />
      <Refused out={change.failed} t={t} />

      <Section id="upload" title={t('uploadTitle')}>
        <p>{t('uploadBody')}</p>
        <form
          aria-label={t('upload')}
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (!file) return;
            void base64Of(file).then((contentBase64) =>
              change.run(
                'businessBills.upload',
                { accountId, billId: billId.id, fileName: file.name, contentType: file.type || 'application/octet-stream', contentBase64 },
                businessBillSchema,
                () => t('uploaded'),
                billId,
              ),
            );
          }}
        >
          <label className="field">
            <span>{t('file')}</span>
            <input type="file" name="bill" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </label>
          <Button type="submit" variant="primary" disabled={change.busy || !file}>
            {t('upload')}
          </Button>
        </form>
      </Section>

      <Section id="inbox" title={t('inboxTitle')}>
        {list.length === 0 ? <p>{t('inboxEmpty')}</p> : null}
        <ul>
          {list.map((b) => (
            <li key={b.id} data-testid="bill-row" data-id={b.id} data-status={b.status} data-duplicate-of={b.duplicateOf?.id ?? ''}>
              <a href={`/bank/business/bill?id=${b.id}`}>
                <strong>{b.vendor ?? t('noVendor')}</strong>
              </a>{' '}
              · {b.reference ?? ''} · {b.amount ? `${b.amount} ${b.assetId}` : t('noAmount')} ·{' '}
              {b.dueDate ? t('due', { date: b.dueDate }) : t('noDue')} · <span data-testid="bill-status">{billStatus(b, label, t)}</span>
              {b.duplicateOf ? (
                <span data-testid="bill-duplicate">
                  {' '}
                  ·{' '}
                  {b.duplicateCleared ? (
                    t('duplicateCleared')
                  ) : (
                    <>
                      {t('maybeDuplicate')}{' '}
                      <a href={`/bank/business/bill?id=${b.duplicateOf.id}`}>
                        {b.duplicateOf.vendor ?? t('noVendor')} {b.duplicateOf.reference ?? ''}
                      </a>
                    </>
                  )}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      </Section>

      <Section id="vendors" title={t('vendorsTitle')}>
        <p>{t('vendorsBody')}</p>
        {s && s.vendors.length === 0 ? <p>{t('vendorsEmpty')}</p> : null}
        <ul>
          {(s?.vendors ?? []).map((v) => (
            <li key={v.name} data-testid="bill-vendor" data-name={v.name} data-cap={v.cap}>
              <strong>{v.name}</strong> · {t('upTo', { amount: v.cap, asset })}
            </li>
          ))}
        </ul>
        <form
          aria-label={t('saveVendor')}
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            void change
              .run('businessBills.setVendor', { accountId, name: vendorName.trim(), cap: vendorCap.trim() }, businessBillVendorSchema, () =>
                t('vendorSaved'),
              )
              .then((v) => {
                if (v) {
                  setVendorName('');
                  setVendorCap('');
                }
              });
          }}
        >
          <label className="field">
            <span>{t('vendorName')}</span>
            <input name="vendorName" value={vendorName} onChange={(e) => setVendorName(e.target.value)} />
          </label>
          <label className="field">
            <span>{t('vendorCap')}</span>
            <input name="vendorCap" inputMode="decimal" value={vendorCap} onChange={(e) => setVendorCap(e.target.value)} />
          </label>
          <Button type="submit" disabled={change.busy || !vendorName.trim() || !vendorCap.trim()}>
            {t('saveVendor')}
          </Button>
        </form>
      </Section>

      <Section id="limits" title={t('limitsTitle')}>
        <p>{t('limitsBody')}</p>
        {s ? (
          <dl data-testid="bill-limits">
            {(['perPayment', 'daily', 'monthly'] as const).map((k) => (
              <div key={k} data-testid={`bill-limit-${k}`} data-value={s.limits[k] ?? ''}>
                <dt>{t(k)}</dt>
                <dd>{s.limits[k] === null ? t('notSet') : `${s.limits[k]} ${asset}`}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        <form
          aria-label={t('saveLimits')}
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            const v = (x: string) => (x.trim() ? x.trim() : null);
            void change
              .run(
                'businessBills.setLimits',
                { accountId, perPayment: v(shownLimits.perPayment), daily: v(shownLimits.daily), monthly: v(shownLimits.monthly) },
                businessBillLimitsSchema,
                () => t('limitsSaved'),
              )
              .then((saved) => {
                if (saved) setLimits(null);
              });
          }}
        >
          {(['perPayment', 'daily', 'monthly'] as const).map((k) => (
            <label key={k} className="field">
              <span>{t(k)}</span>
              <input
                name={k}
                inputMode="decimal"
                value={shownLimits[k]}
                onChange={(e) => setLimits({ ...shownLimits, [k]: e.target.value })}
              />
            </label>
          ))}
          <Button type="submit" disabled={change.busy}>
            {t('saveLimits')}
          </Button>
        </form>
      </Section>
    </>
  );
}

/** `/bank/business/bill?id=`. */
export function BusinessBillRoom({ search }: { search: string }) {
  const { t } = copy.useCopy();
  const id = new URLSearchParams(search).get('id');
  const path = `/bank/business/bill${search}`;
  const { userId } = useSession();
  const [rev, setRev] = useState(0);
  const bill = useBank('businessBills.get', id ? { billId: id } : null, businessBillSchema, id ?? '-', rev);
  const b = bill.resource.status === 'ready' ? bill.resource.data : null;
  const overview = useBank(
    'businessTeam.overview',
    b ? { accountId: b.accountId } : null,
    businessTeamOverviewSchema,
    b?.accountId ?? '-',
    rev,
  );
  const o = overview.resource.status === 'ready' ? overview.resource.data : null;
  let state: RoomState = { kind: 'ready' };
  if (!userId) state = signedOutState(t, path);
  else if (!id) state = { kind: 'refused', refusal: { variant: 'refused', title: t('readFailedTitle'), body: t('noId') } };
  else if (bill.resource.status === 'failed')
    state = { kind: 'refused', refusal: { variant: 'refused', title: t('readFailedTitle'), body: bill.resource.failure.message } };
  else if (!b) state = { kind: 'loading' };
  return (
    <FlowTemplate
      title={t('billTitle')}
      description={t('billDescription')}
      state={state}
      step={b ? <BillParts b={b} o={o} reload={() => setRev((n) => n + 1)} t={t} /> : null}
      summary={
        <div>
          <h2>{t('payTitle')}</h2>
          <p>{t('payBody')}</p>
          <p>
            <a href="/bank/business/bills">{t('backToInbox')}</a>
          </p>
        </div>
      }
    />
  );
}

function BillParts({
  b,
  o,
  reload,
  t,
}: {
  b: BusinessBill;
  o: z.infer<typeof businessTeamOverviewSchema> | null;
  reload: () => void;
  t: T;
}) {
  const change = useChange(reload);
  const paymentId = useHeldId();
  const label = o?.partner?.label ?? '';
  const [review, setReview] = useState<{ vendor: string; reference: string; amount: string; dueDate: string } | null>(null);
  const shown = review ?? { vendor: b.vendor ?? '', reference: b.reference ?? '', amount: b.amount ?? '', dueDate: b.dueDate ?? '' };
  const [payOn, setPayOn] = useState('');
  const [lines, setLines] = useState<Array<{ category: string; amount: string }>>([]);
  const v = (x: string) => (x.trim() ? x.trim() : null);
  const sending = b.payments.find((p) => p.status === 'sending');

  return (
    <div data-testid="bill-detail" data-id={b.id} data-status={b.status} data-round={b.round}>
      <Notice text={change.notice} />
      <Refused out={change.failed} t={t} />
      {o ? <Balance o={o} t={t} /> : null}
      <p data-testid="bill-state">
        {b.fileName} · {billStatus(b, label, t)}
      </p>

      {b.back ? (
        <Section id="back" title={t('backTitle')}>
          <p data-testid="bill-back" data-reason={b.back.reason}>
            {t('partnerSaid')}: {b.back.text}
          </p>
        </Section>
      ) : null}

      {b.duplicateOf ? (
        <Section id="duplicate" title={t('duplicateTitle')}>
          <p data-testid="bill-duplicate-of" data-id={b.duplicateOf.id} data-cleared={String(b.duplicateCleared)}>
            {b.duplicateCleared ? t('duplicateCleared') : t('duplicateBody')} {t('maybeDuplicate')}{' '}
            <a href={`/bank/business/bill?id=${b.duplicateOf.id}`}>
              {b.duplicateOf.vendor ?? t('noVendor')} {b.duplicateOf.reference ?? ''} · {b.duplicateOf.amount ?? ''}
            </a>
          </p>
          {!b.duplicateCleared ? (
            <Button
              type="button"
              disabled={change.busy}
              onClick={() => void change.run('businessBills.clearDuplicate', { billId: b.id }, businessBillSchema)}
            >
              {t('notDuplicate')}
            </Button>
          ) : null}
        </Section>
      ) : null}

      <Section id="review" title={t('reviewTitle')}>
        <p>{t('reviewBody')}</p>
        {b.extracted ? (
          <div data-testid="bill-extracted" data-label={b.extracted.label}>
            <h3>
              {t('readTitle')} · {b.extracted.label}
            </h3>
            <ul>
              <li>
                {t('vendor')}: {b.extracted.vendor ?? t('notRead')}
              </li>
              <li>
                {t('reference')}: {b.extracted.reference ?? t('notRead')}
              </li>
              <li>
                {t('amount')}: {b.extracted.amount ?? t('notRead')}
              </li>
              <li>
                {t('dueDate')}: {b.extracted.dueDate ?? t('notRead')}
              </li>
            </ul>
          </div>
        ) : (
          <p>{t('readerNone')}</p>
        )}
        <form
          aria-label={t('saveReview')}
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            void change
              .run(
                'businessBills.review',
                {
                  billId: b.id,
                  vendor: v(shown.vendor),
                  reference: v(shown.reference),
                  amount: v(shown.amount),
                  dueDate: v(shown.dueDate),
                },
                businessBillSchema,
                () => t('reviewSaved'),
              )
              .then((r) => {
                if (r) setReview(null);
              });
          }}
        >
          {(
            [
              ['vendor', 'text'],
              ['reference', 'text'],
              ['amount', 'text'],
              ['dueDate', 'date'],
            ] as const
          ).map(([k, type]) => (
            <label key={k} className="field">
              <span>{t(k)}</span>
              <input
                name={k}
                type={type}
                disabled={b.status !== 'inbox'}
                value={shown[k]}
                onChange={(e) => setReview({ ...shown, [k]: e.target.value })}
              />
            </label>
          ))}
          <Button type="submit" disabled={change.busy || b.status !== 'inbox'}>
            {t('saveReview')}
          </Button>
        </form>
        {b.status === 'inbox' ? (
          <Button
            type="button"
            variant="primary"
            disabled={change.busy}
            onClick={() => void change.run('businessBills.submit', { billId: b.id }, businessBillSchema, () => t('submitted'))}
          >
            {t('submit')}
          </Button>
        ) : null}
      </Section>

      {b.status !== 'inbox' ? (
        <Section id="approval" title={t('approvalTitle')}>
          <p data-testid="bill-approval" data-preapproved={String(b.preapproved)} data-needed={b.approvalsNeeded}>
            {b.preapproved ? t('preapproved') : t('needs', { n: b.approvalsNeeded })}
            {b.rule ? ` ${t('ruleApplied', { amount: b.rule.overAmount })}` : ''}
          </p>
          {b.submittedByHandle ? <p>{t('sentOnBy', { handle: b.submittedByHandle })}</p> : null}
          <ul>
            {b.approvals.map((a) => (
              <li key={a.userId} data-testid="bill-approved-by">
                {t('approvedBy', { handle: a.handle })}
              </li>
            ))}
          </ul>
          {b.status === 'awaiting_approval' ? (
            <Button
              type="button"
              variant="primary"
              disabled={change.busy}
              onClick={() => void change.run('businessBills.approve', { billId: b.id }, businessBillSchema, () => t('approved'))}
            >
              {t('approve')}
            </Button>
          ) : null}
        </Section>
      ) : null}

      {b.status === 'approved' ? (
        <Section id="pay" title={t('payTitle')}>
          <p>{t('payBody')}</p>
          <form
            aria-label={t('payTitle')}
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              const scheduledFor = payOn || null;
              void change
                .run(
                  'businessBills.pay',
                  {
                    billId: b.id,
                    paymentId: paymentId.id,
                    scheduledFor,
                    splits: lines.map((l) => ({ category: l.category.trim(), amount: l.amount.trim() })),
                  },
                  businessBillSchema,
                  () => (scheduledFor ? t('scheduledDone') : t('paidDone')),
                  paymentId,
                )
                .then((r) => {
                  if (r) {
                    setLines([]);
                    setPayOn('');
                  }
                });
            }}
          >
            <label className="field">
              <span>{t('payOn')}</span>
              <input name="payOn" type="date" value={payOn} onChange={(e) => setPayOn(e.target.value)} />
            </label>
            {lines.map((l, i) => (
              <fieldset key={i} data-testid="bill-split-line">
                <label className="field">
                  <span>{t('category')}</span>
                  <input
                    name={`category-${i}`}
                    value={l.category}
                    onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, category: e.target.value } : x)))}
                  />
                </label>
                <label className="field">
                  <span>{t('lineAmount')}</span>
                  <input
                    name={`lineAmount-${i}`}
                    inputMode="decimal"
                    value={l.amount}
                    onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))}
                  />
                </label>
                <Button type="button" onClick={() => setLines(lines.filter((_, j) => j !== i))}>
                  {t('removeLine')}
                </Button>
              </fieldset>
            ))}
            <Button type="button" onClick={() => setLines([...lines, { category: '', amount: '' }])}>
              {t('addLine')}
            </Button>
            <Button type="submit" variant="primary" disabled={change.busy}>
              {payOn ? t('schedule') : t('payNow')}
            </Button>
          </form>
        </Section>
      ) : null}

      <Section id="payments" title={t('paymentsTitle')}>
        {b.payments.length === 0 ? <p>{t('paymentsEmpty')}</p> : null}
        <ul>
          {b.payments.map((p) => (
            <li
              key={p.id}
              data-testid="bill-payment"
              data-id={p.id}
              data-status={p.status}
              data-attempt={p.attempt}
              data-key={p.partnerKey}
            >
              <strong>{t('attempt', { n: p.attempt })}</strong> · {p.amount} {p.assetId} · <span>{paymentStatus(p, label, t)}</span>
              {p.partnerReasonText ? (
                <span data-testid="bill-payment-reason" data-reason={p.partnerReason ?? ''}>
                  {' '}
                  · {t('partnerSaid')}: {p.partnerReasonText}
                </span>
              ) : null}
              {p.partnerMoveId ? (
                <span>
                  {' '}
                  · {t('partnerRef')}: <code>{p.partnerMoveId}</code>
                </span>
              ) : null}
              {p.returnMoveId ? (
                <span>
                  {' '}
                  · {t('returnRef')}: <code>{p.returnMoveId}</code>
                </span>
              ) : null}
              {p.splits.length > 0 ? (
                <ul data-testid="bill-payment-splits">
                  {p.splits.map((s, i) => (
                    <li key={i} data-testid="bill-payment-split" data-category={s.category} data-amount={s.amount}>
                      {t('splitLine', { category: s.category, amount: s.amount, asset: p.assetId })}
                    </li>
                  ))}
                </ul>
              ) : null}
              {p.status === 'scheduled' ? (
                <Button
                  type="button"
                  disabled={change.busy}
                  onClick={() => void change.run('businessBills.cancel', { paymentId: p.id }, businessBillSchema, () => t('cancelled'))}
                >
                  {t('cancel')}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
        {sending ? (
          <Button
            type="button"
            disabled={change.busy}
            onClick={() => void change.run('businessBills.resend', { paymentId: sending.id }, businessBillSchema)}
          >
            {t('tryAgain')}
          </Button>
        ) : null}
      </Section>
    </div>
  );
}
