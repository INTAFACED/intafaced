import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { z, type ZodType } from 'zod';
import { Button } from '@intafaced/ui';
import { FlowTemplate, type RoomState } from '@intafaced/ui/lit/templates';
import {
  businessBulkRunSchema,
  businessContractorBatchSchema,
  businessContractorInviteInfoSchema,
  businessContractorInviteSchema,
  businessContractorJoinedSchema,
  businessContractorSchema,
  businessCryptoPayrollSchema,
  businessPayrollWalletOfferSchema,
  businessPayrollWalletSchema,
  type BusinessBulkRun,
  type BusinessContractor,
  type BusinessContractorBatch,
  type BusinessCryptoPayroll,
  type BusinessPayrollRun,
} from '@intafaced/contracts/bank-business-payouts';
import { businessTeamOverviewSchema } from '@intafaced/contracts/bank-business-team';
import { defineCopy } from '../../../shared/i18n';
import type { ApiResult } from '../../../shared/api';
import { useResource, type Resource } from '../../../shared/resource';
import { useSession } from '../../session/session';
import { useHeldId, type HeldId } from '../business-team/held-id';

/**
 * A business pays its team and contractors in bulk (J-bank-21; BK-bpay-01, BK-bpay-02, RC-bank-05), on the flow template.
 *
 * `/bank/business/payouts`: in Business mode, the business picked in the account menu. A bulk payment file is imported
 * with its validation report (nothing is held), funded and confirmed as one instruction to the partner bank; contractors
 * and their invoices are paid as a batch through the partner's payout rail; recurring crypto payroll is signed by the
 * business's own wallet, with payslips. `/bank/business/contractor-join?token=`: a contractor adds themselves.
 *
 * The business's money is the partner bank's, and crypto payroll is the business's own wallet's: INTAFACED holds no vault
 * and posts nothing to its own books. Every check is the bank's; this page shows what it reports and its refusals by name.
 */
const copy = defineCopy('money.business-payouts', {
  title: 'Bulk payments',
  description: 'Pay your team and contractors in bulk',
  joinTitle: 'Join as a contractor',
  joinDescription: 'Add your own payout details for a business',
  personalTitle: 'Choose a business',
  personalBody: 'You are in your personal profile. Pick a business in the account menu to pay its team.',
  signedOutTitle: 'Sign in to continue',
  signedOutBody: 'A business’s payments belong to its members.',
  signIn: 'Sign in',
  readFailedTitle: 'This could not be read',
  refusedTitle: 'It was not done',
  balance: 'Balance at {label}',
  balanceNotKnown: 'Not known: {label} has not reported it',
  balanceNone: 'This business’s money is not held at a partner bank.',
  threshold: 'Approval needed at or above {amount} {asset}',
  bulkTitle: 'Bulk payment',
  bulkBody:
    'Import a CSV with the columns name, iban, amount, currency and reference. Every line is checked first; nothing is held or sent until you confirm.',
  file: 'Payments file (CSV)',
  import: 'Import file',
  imported: 'File imported. Check the validation report.',
  reportTitle: 'Validation report',
  reportClean: 'Every line is valid.',
  reportHeld: 'Nothing is held: these lines send nothing.',
  lineCode: 'Line {line}: {code}',
  linesTitle: 'Lines to pay',
  fundingTitle: 'Funding',
  fundingBody: 'The run is one payment to the partner bank for every valid line, sent once.',
  runTotal: 'Total to send: {amount} {asset}',
  needsApproval: 'This total is at or above the approval threshold: another approver must approve it before it is sent.',
  noApproval: 'This total is under the approval threshold: it is sent when you confirm.',
  confirm: 'Confirm and send',
  confirmForApproval: 'Confirm and send for approval',
  confirmed: 'Run confirmed.',
  approveRun: 'Approve run',
  runApproved: 'Approval recorded.',
  run_draft: 'Imported: not sent',
  run_awaiting_approval: 'Waiting for an approver',
  run_sending: 'Sending to the partner bank: its answer is not known yet',
  run_sent: 'Sent once to {label}',
  run_declined: 'Declined by the partner bank: nothing moved',
  runKey: 'Run key',
  partnerRef: 'Partner reference',
  partnerPayees: 'Recipients in the one instruction: {count}',
  contractorsTitle: 'Contractors',
  contractorsEmpty: 'No contractors yet.',
  name: 'Name',
  email: 'Email (optional)',
  iban: 'Payout IBAN',
  wallet: 'Wallet address for crypto payroll (optional)',
  addContractor: 'Add contractor',
  contractorAdded: 'Contractor added.',
  self: 'added themselves',
  noIban: 'no payout IBAN',
  invoiceNumber: 'Invoice number',
  invoiceAmount: 'Amount',
  invoiceDue: 'Due date (optional)',
  storeInvoice: 'Store invoice',
  invoiceStored: 'Invoice stored.',
  inv_open: 'Open',
  inv_in_batch: 'In a batch',
  inv_paid: 'Paid',
  pick: 'Pay invoice {number}',
  payBatch: 'Pay selected invoices',
  batchMade: 'Batch recorded.',
  batchesTitle: 'Contractor batches',
  batchesEmpty: 'No batches yet.',
  batch_awaiting_approval: 'Waiting for {n} approval(s) under your approval rules',
  batch_sending: 'Sending through the partner’s payout rail: its answer is not known yet',
  batch_sent: 'Paid through {label}’s payout rail',
  batch_declined: 'Declined by the partner bank: nothing moved',
  batch_refused: 'Not paid: no partner payout rail carries it here (rail.bank). The payment intent is kept; nothing moved.',
  approveBatch: 'Approve batch',
  inviteTitle: 'Contractor self-onboarding',
  inviteBody: 'A one-use link a contractor opens to add their own payout details and wallet.',
  createInvite: 'Create onboarding link',
  inviteLink: 'Onboarding link (shown once)',
  cryptoTitle: 'Recurring crypto payroll',
  cryptoBody:
    'Each run is signed by the business’s own wallet. INTAFACED holds no key and no vault, and sends nothing on chain: the signed run is your wallet’s to send.',
  walletConnected: 'Business wallet: {address}',
  walletNone: 'No business wallet is connected.',
  walletAddress: 'Business wallet address',
  walletOffer: 'Get the message to sign',
  signThis: 'Sign this message with the business’s own wallet',
  signature: 'Signature',
  signWithWallet: 'Sign with my browser wallet',
  noBrowserWallet: 'No browser wallet found: sign the message in your wallet and paste the signature.',
  connect: 'Connect wallet',
  connected: 'Wallet connected.',
  payrollName: 'Payroll name',
  payrollDay: 'Day of the month (1 to 28)',
  memberAmount: 'Amount for {name}',
  createPayroll: 'Set up payroll',
  payrollMade: 'Payroll set up.',
  payrollsEmpty: 'No crypto payroll yet.',
  everyMonth: 'Monthly on day {day}, in {asset}',
  period: 'Month (YYYY-MM)',
  prepareRun: 'Prepare run',
  runPrepared: 'Run prepared: sign it with the business’s wallet.',
  payslipsTitle: 'Payslips',
  payslip: '{name}: {amount} {asset} to {address}',
  pr_awaiting_signature: 'Waiting for the business wallet’s signature',
  pr_signed: 'Signed by the business’s own wallet {address}',
  signRun: 'Submit signature',
  runSigned: 'Run signed by your wallet.',
  railCrypto: 'No chain rail is connected here (rail.crypto): your own wallet sends the signed run. INTAFACED holds no vault.',
  joinFor: 'Add your details for {name}',
  joinClosed: 'This link was already used or the business is closed.',
  joinNoToken: 'This page needs an onboarding link.',
  join: 'Add my details',
  joined: 'You are now a contractor of {name}.',
});
type T = ReturnType<typeof copy.useCopy>['t'];
type Failed = Extract<ApiResult<unknown>, { ok: false }>;

function Refused({ out, t }: { out: Failed | null; t: T }) {
  if (!out) return null;
  return (
    <p role="alert" data-testid="payouts-refusal" data-code={out.code ?? ''}>
      {t('refusedTitle')}: {out.message}
    </p>
  );
}

function Notice({ text }: { text: string }) {
  return text ? (
    <p role="status" data-testid="payouts-notice">
      {text}
    </p>
  ) : null;
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={`payouts-${id}`} data-testid={`payouts-${id}`}>
      <h2 id={`payouts-${id}`}>{title}</h2>
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
    `payouts:${procedure}:${userId ?? 'out'}:${base}:${rev}`,
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

/** The browser wallet's `personal_sign`, when one is present. */
async function browserSign(message: string, address: string): Promise<string | null> {
  const eth = (globalThis as { ethereum?: { request: (a: { method: string; params: unknown[] }) => Promise<unknown> } }).ethereum;
  if (!eth) return null;
  const out = await eth.request({ method: 'personal_sign', params: [message, address] });
  return typeof out === 'string' ? out : null;
}

const ready = <S,>(r: Resource<S>): S | null => (r.status === 'ready' ? r.data : null);

/** `/bank/business/payouts`. */
export function BusinessPayoutsRoom() {
  const { t } = copy.useCopy();
  const { userId, profiles } = useSession();
  const business = profiles.business;
  const accountId = business?.accountId ?? null;
  const overview = useBank('businessTeam.overview', accountId ? { accountId } : null, businessTeamOverviewSchema, accountId ?? '-');
  let state: RoomState = { kind: 'ready' };
  if (!userId) state = signedOutState(t, '/bank/business/payouts');
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
          <div data-testid="payouts-room" data-account={accountId}>
            <p data-testid="payouts-business">{o.account.name}</p>
            <p data-testid="payouts-balance" data-amount={o.partner?.amount ?? ''}>
              {!o.partner
                ? t('balanceNone')
                : o.partner.amount === null
                  ? t('balanceNotKnown', { label: o.partner.label })
                  : `${t('balance', { label: o.partner.label })}: ${o.partner.amount} ${o.account.assetId}`}
            </p>
            <Parts
              accountId={accountId}
              label={o.partner?.label ?? ''}
              partnerAmount={o.partner?.amount ?? null}
              reloadTop={overview.reload}
              t={t}
            />
          </div>
        ) : null
      }
      summary={
        <div>
          <h2>{t('bulkTitle')}</h2>
          <p>{t('fundingBody')}</p>
          <p>{t('cryptoBody')}</p>
        </div>
      }
    />
  );
}

function Parts({
  accountId,
  label,
  partnerAmount,
  reloadTop,
  t,
}: {
  accountId: string;
  label: string;
  partnerAmount: string | null;
  reloadTop: () => void;
  t: T;
}) {
  const { userId } = useSession();
  const [rev, setRev] = useState(0);
  const input = { accountId };
  const runs = useBank('businessPayouts.runs', input, z.array(businessBulkRunSchema), accountId, rev);
  const contractors = useBank('businessPayouts.contractors', input, z.array(businessContractorSchema), accountId, rev);
  const batches = useBank('businessPayouts.batches', input, z.array(businessContractorBatchSchema), accountId, rev);
  const wallet = useBank('businessPayouts.wallet', input, businessPayrollWalletSchema.nullable(), accountId, rev);
  const payrolls = useBank('businessPayouts.payrolls', input, z.array(businessCryptoPayrollSchema), accountId, rev);
  const change = useChange(() => {
    setRev((n) => n + 1);
    reloadTop();
  });
  const runId = useHeldId();
  const [file, setFile] = useState<File | null>(null);
  const latest = ready(runs.resource)?.[0] ?? null;
  const people = ready(contractors.resource) ?? [];
  const w = ready(wallet.resource);

  return (
    <>
      <Notice text={change.notice} />
      <Refused out={change.failed} t={t} />

      <Section id="bulk" title={t('bulkTitle')}>
        <p>{t('bulkBody')}</p>
        <form
          aria-label={t('import')}
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (!file) return;
            void file
              .text()
              .then((csv) =>
                change.run(
                  'businessPayouts.importRun',
                  { accountId, runId: runId.id, csv },
                  businessBulkRunSchema,
                  () => t('imported'),
                  runId,
                ),
              );
          }}
        >
          <label className="field">
            <span>{t('file')}</span>
            <input type="file" name="payments" accept=".csv,text/csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </label>
          <Button type="submit" variant="primary" disabled={change.busy || !file}>
            {t('import')}
          </Button>
        </form>
        {latest ? <RunView run={latest} label={label} partnerAmount={partnerAmount} me={userId} change={change} t={t} /> : null}
      </Section>

      <Section id="contractors" title={t('contractorsTitle')}>
        <ContractorParts accountId={accountId} people={people} change={change} t={t} />
      </Section>

      <Section id="batches" title={t('batchesTitle')}>
        {(ready(batches.resource) ?? []).length === 0 ? <p>{t('batchesEmpty')}</p> : null}
        <ul>
          {(ready(batches.resource) ?? []).map((b) => (
            <BatchRow key={b.id} b={b} label={label} me={userId} change={change} t={t} />
          ))}
        </ul>
      </Section>

      <Section id="invite" title={t('inviteTitle')}>
        <InviteParts accountId={accountId} change={change} t={t} />
      </Section>

      <Section id="crypto" title={t('cryptoTitle')}>
        <p>{t('cryptoBody')}</p>
        <WalletParts accountId={accountId} wallet={w} change={change} t={t} />
        {w ? <PayrollSetup accountId={accountId} people={people} change={change} t={t} /> : null}
        {(ready(payrolls.resource) ?? []).length === 0 ? <p>{t('payrollsEmpty')}</p> : null}
        {(ready(payrolls.resource) ?? []).map((p) => (
          <PayrollView key={p.id} p={p} change={change} t={t} />
        ))}
      </Section>
    </>
  );
}

type Change = ReturnType<typeof useChange>;

function RunView({
  run,
  label,
  partnerAmount,
  me,
  change,
  t,
}: {
  run: BusinessBulkRun;
  label: string;
  partnerAmount: string | null;
  me: string | null;
  change: Change;
  t: T;
}) {
  const status = run.status === 'sent' ? t('run_sent', { label }) : t(`run_${run.status}`);
  return (
    <div data-testid="bulk-run" data-id={run.id} data-status={run.status}>
      <p data-testid="bulk-status">{status}</p>
      <h3>{t('reportTitle')}</h3>
      <div data-testid="bulk-report">
        {run.issues.length === 0 ? (
          <p>{t('reportClean')}</p>
        ) : (
          <>
            <p>{t('reportHeld')}</p>
            <ul>
              {run.issues.map((i) => (
                <li key={i.line} data-testid="bulk-issue" data-line={i.line} data-code={i.code}>
                  {t('lineCode', { line: i.line, code: i.code })} · {i.detail}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
      <h3>{t('linesTitle')}</h3>
      <ul>
        {run.lines.map((l) => (
          <li key={l.line} data-testid="bulk-line" data-line={l.line}>
            {l.line}. {l.name} · …{l.iban.slice(-4)} · {l.amount} {run.assetId}
            {l.reference ? ` · ${l.reference}` : ''}
          </li>
        ))}
      </ul>
      {run.status === 'draft' ? (
        <div data-testid="bulk-funding">
          <h3>{t('fundingTitle')}</h3>
          <p>{t('fundingBody')}</p>
          <p data-testid="bulk-total" data-amount={run.total}>
            {t('runTotal', { amount: run.total, asset: run.assetId })}
          </p>
          <p>{partnerAmount === null ? t('balanceNotKnown', { label }) : `${t('balance', { label })}: ${partnerAmount} ${run.assetId}`}</p>
          <Button
            variant="primary"
            disabled={change.busy}
            onClick={() => void change.run('businessPayouts.confirmRun', { runId: run.id }, businessBulkRunSchema, () => t('confirmed'))}
          >
            {t('confirm')}
          </Button>
        </div>
      ) : null}
      {run.threshold !== null ? (
        <p data-testid="bulk-approval">
          {t('threshold', { amount: run.threshold, asset: run.assetId })}: {run.approvalsNeeded > 0 ? t('needsApproval') : t('noApproval')}
        </p>
      ) : null}
      {run.status === 'awaiting_approval' && run.confirmedBy !== me ? (
        <Button
          variant="primary"
          disabled={change.busy}
          onClick={() => void change.run('businessPayouts.approveRun', { runId: run.id }, businessBulkRunSchema, () => t('runApproved'))}
        >
          {t('approveRun')}
        </Button>
      ) : null}
      <p>
        {t('runKey')}: <code data-testid="bulk-key">{run.partnerKey}</code>
        {run.partnerMoveId ? (
          <>
            {' '}
            · {t('partnerRef')}: <code data-testid="bulk-move">{run.partnerMoveId}</code>
          </>
        ) : null}
        {run.partnerPayees !== null ? (
          <>
            {' '}
            ·{' '}
            <span data-testid="bulk-payees" data-count={run.partnerPayees}>
              {t('partnerPayees', { count: String(run.partnerPayees) })}
            </span>
          </>
        ) : null}
      </p>
      {run.partnerReasonText ? <p>{run.partnerReasonText}</p> : null}
    </div>
  );
}

function ContractorParts({ accountId, people, change, t }: { accountId: string; people: BusinessContractor[]; change: Change; t: T }) {
  const contractorId = useHeldId();
  const [form, setForm] = useState({ name: '', email: '', iban: '', wallet: '' });
  const [picked, setPicked] = useState<string[]>([]);
  const batchId = useHeldId();
  const open = people.flatMap((c) => c.invoices.filter((i) => i.status === 'open').map((i) => ({ ...i, who: c.name })));
  return (
    <>
      {people.length === 0 ? <p>{t('contractorsEmpty')}</p> : null}
      <ul>
        {people.map((c) => (
          <ContractorRow key={c.id} c={c} change={change} t={t} />
        ))}
      </ul>
      <form
        aria-label={t('addContractor')}
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          void change
            .run(
              'businessPayouts.addContractor',
              {
                accountId,
                contractorId: contractorId.id,
                name: form.name.trim(),
                email: form.email.trim() || null,
                iban: form.iban.trim() || null,
                walletAddress: form.wallet.trim() || null,
              },
              businessContractorSchema,
              () => t('contractorAdded'),
              contractorId,
            )
            .then((c) => {
              if (c) setForm({ name: '', email: '', iban: '', wallet: '' });
            });
        }}
      >
        <label className="field">
          <span>{t('name')}</span>
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </label>
        <label className="field">
          <span>{t('email')}</span>
          <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </label>
        <label className="field">
          <span>{t('iban')}</span>
          <input value={form.iban} onChange={(e) => setForm({ ...form, iban: e.target.value })} />
        </label>
        <label className="field">
          <span>{t('wallet')}</span>
          <input value={form.wallet} onChange={(e) => setForm({ ...form, wallet: e.target.value })} />
        </label>
        <Button type="submit" variant="primary" disabled={change.busy || !form.name.trim()}>
          {t('addContractor')}
        </Button>
      </form>
      {open.length > 0 ? (
        <form
          aria-label={t('payBatch')}
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            void change
              .run(
                'businessPayouts.payBatch',
                { accountId, batchId: batchId.id, invoiceIds: picked },
                businessContractorBatchSchema,
                () => t('batchMade'),
                batchId,
              )
              .then((b) => {
                if (b) setPicked([]);
              });
          }}
        >
          {open.map((i) => (
            <label key={i.id} className="field">
              <input
                type="checkbox"
                checked={picked.includes(i.id)}
                onChange={(e) => setPicked(e.target.checked ? [...picked, i.id] : picked.filter((x) => x !== i.id))}
              />
              <span>
                {t('pick', { number: i.number })} · {i.who} · {i.amount} {i.assetId}
              </span>
            </label>
          ))}
          <Button type="submit" variant="primary" disabled={change.busy || picked.length === 0}>
            {t('payBatch')}
          </Button>
        </form>
      ) : null}
    </>
  );
}

function ContractorRow({ c, change, t }: { c: BusinessContractor; change: Change; t: T }) {
  const invoiceId = useHeldId();
  const [inv, setInv] = useState({ number: '', amount: '', due: '' });
  return (
    <li data-testid="contractor-row" data-id={c.id} data-name={c.name}>
      <strong>{c.name}</strong> · {c.ibanLast4 ? `IBAN …${c.ibanLast4}` : t('noIban')}
      {c.walletAddress ? ` · ${c.walletAddress}` : ''}
      {c.onboarded === 'self' ? ` · ${t('self')}` : ''}
      <ul>
        {c.invoices.map((i) => (
          <li key={i.id} data-testid="invoice-row" data-number={i.number} data-amount={i.amount} data-status={i.status}>
            {i.number} · {i.amount} {i.assetId}
            {i.dueDate ? ` · ${i.dueDate}` : ''} · {t(`inv_${i.status}`)}
          </li>
        ))}
      </ul>
      <form
        aria-label={`${t('storeInvoice')} ${c.name}`}
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          void change
            .run(
              'businessPayouts.addInvoice',
              {
                contractorId: c.id,
                invoiceId: invoiceId.id,
                number: inv.number.trim(),
                amount: inv.amount.trim(),
                dueDate: inv.due || null,
              },
              businessContractorSchema,
              () => t('invoiceStored'),
              invoiceId,
            )
            .then((r) => {
              if (r) setInv({ number: '', amount: '', due: '' });
            });
        }}
      >
        <label className="field">
          <span>{t('invoiceNumber')}</span>
          <input value={inv.number} onChange={(e) => setInv({ ...inv, number: e.target.value })} />
        </label>
        <label className="field">
          <span>{t('invoiceAmount')}</span>
          <input inputMode="decimal" value={inv.amount} onChange={(e) => setInv({ ...inv, amount: e.target.value })} />
        </label>
        <label className="field">
          <span>{t('invoiceDue')}</span>
          <input type="date" value={inv.due} onChange={(e) => setInv({ ...inv, due: e.target.value })} />
        </label>
        <Button type="submit" disabled={change.busy || !inv.number.trim() || !inv.amount.trim()}>
          {t('storeInvoice')}
        </Button>
      </form>
    </li>
  );
}

function BatchRow({ b, label, me, change, t }: { b: BusinessContractorBatch; label: string; me: string | null; change: Change; t: T }) {
  const status =
    b.status === 'awaiting_approval'
      ? t('batch_awaiting_approval', { n: Math.max(0, b.approvalsNeeded - b.approvals.length) })
      : b.status === 'sent'
        ? t('batch_sent', { label })
        : t(`batch_${b.status}`);
  return (
    <li data-testid="batch-row" data-id={b.id} data-status={b.status} data-refusal={b.refusalCode ?? ''}>
      <span data-testid="batch-status">{status}</span> · {b.total} {b.assetId} ·{' '}
      {b.lines.map((l) => `${l.contractorName} ${l.number}`).join(', ')} · <code>{b.partnerKey}</code>
      {b.partnerPayees !== null ? (
        <>
          {' '}
          ·{' '}
          <span data-testid="batch-payees" data-count={b.partnerPayees}>
            {t('partnerPayees', { count: String(b.partnerPayees) })}
          </span>
        </>
      ) : null}
      {b.partnerReasonText ? ` · ${b.partnerReasonText}` : ''}
      {b.status === 'awaiting_approval' && b.createdBy !== me ? (
        <Button
          variant="primary"
          disabled={change.busy}
          onClick={() =>
            void change.run('businessPayouts.approveBatch', { batchId: b.id }, businessContractorBatchSchema, () => t('runApproved'))
          }
        >
          {t('approveBatch')}
        </Button>
      ) : null}
    </li>
  );
}

function InviteParts({ accountId, change, t }: { accountId: string; change: Change; t: T }) {
  const [link, setLink] = useState('');
  return (
    <>
      <p>{t('inviteBody')}</p>
      <Button
        disabled={change.busy}
        onClick={() =>
          void change.run('businessPayouts.createInvite', { accountId }, businessContractorInviteSchema).then((made) => {
            if (made) setLink(`${location.origin}/bank/business/contractor-join?token=${encodeURIComponent(made.token)}`);
          })
        }
      >
        {t('createInvite')}
      </Button>
      {link ? (
        <p>
          {t('inviteLink')}: <code data-testid="invite-link">{link}</code>
        </p>
      ) : null}
    </>
  );
}

function SignatureField({
  message,
  address,
  value,
  onChange,
  t,
}: {
  message: string;
  address: string;
  value: string;
  onChange: (v: string) => void;
  t: T;
}) {
  const [missing, setMissing] = useState(false);
  return (
    <>
      <p>{t('signThis')}</p>
      <pre data-testid="sign-message">{message}</pre>
      <Button
        type="button"
        onClick={() =>
          void browserSign(message, address).then((sig) => {
            if (sig) onChange(sig);
            else setMissing(true);
          })
        }
      >
        {t('signWithWallet')}
      </Button>
      {missing ? <p>{t('noBrowserWallet')}</p> : null}
      <label className="field">
        <span>{t('signature')}</span>
        <input value={value} onChange={(e) => onChange(e.target.value.trim())} />
      </label>
    </>
  );
}

function WalletParts({
  accountId,
  wallet,
  change,
  t,
}: {
  accountId: string;
  wallet: z.infer<typeof businessPayrollWalletSchema> | null;
  change: Change;
  t: T;
}) {
  const [address, setAddress] = useState('');
  const [offer, setOffer] = useState<{ offerId: string; message: string } | null>(null);
  const [sig, setSig] = useState('');
  return (
    <div data-testid="payroll-wallet" data-address={wallet?.address ?? ''}>
      <p>{wallet ? t('walletConnected', { address: wallet.address }) : t('walletNone')}</p>
      <form
        aria-label={t('walletOffer')}
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          void change
            .run('businessPayouts.walletOffer', { accountId, address: address.trim() }, businessPayrollWalletOfferSchema)
            .then((o) => {
              if (o) setOffer(o);
            });
        }}
      >
        <label className="field">
          <span>{t('walletAddress')}</span>
          <input value={address} onChange={(e) => setAddress(e.target.value)} />
        </label>
        <Button type="submit" disabled={change.busy || !address.trim()}>
          {t('walletOffer')}
        </Button>
      </form>
      {offer ? (
        <form
          aria-label={t('connect')}
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            void change
              .run('businessPayouts.connectWallet', { offerId: offer.offerId, signature: sig }, businessPayrollWalletSchema, () =>
                t('connected'),
              )
              .then((r) => {
                if (r) setOffer(null);
              });
          }}
        >
          <SignatureField message={offer.message} address={address.trim()} value={sig} onChange={setSig} t={t} />
          <Button type="submit" variant="primary" disabled={change.busy || !sig}>
            {t('connect')}
          </Button>
        </form>
      ) : null}
    </div>
  );
}

function PayrollSetup({ accountId, people, change, t }: { accountId: string; people: BusinessContractor[]; change: Change; t: T }) {
  const payrollId = useHeldId();
  const [name, setName] = useState('');
  const [day, setDay] = useState('');
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const withWallet = people.filter((c) => c.walletAddress);
  if (withWallet.length === 0) return null;
  const members = withWallet
    .filter((c) => (amounts[c.id] ?? '').trim())
    .map((c) => ({ contractorId: c.id, amount: amounts[c.id]!.trim() }));
  return (
    <form
      aria-label={t('createPayroll')}
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        void change.run(
          'businessPayouts.createPayroll',
          { accountId, payrollId: payrollId.id, name: name.trim(), dayOfMonth: Number(day), members },
          businessCryptoPayrollSchema,
          () => t('payrollMade'),
          payrollId,
        );
      }}
    >
      <label className="field">
        <span>{t('payrollName')}</span>
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="field">
        <span>{t('payrollDay')}</span>
        <input inputMode="numeric" value={day} onChange={(e) => setDay(e.target.value)} />
      </label>
      {withWallet.map((c) => (
        <label key={c.id} className="field">
          <span>{t('memberAmount', { name: c.name })}</span>
          <input inputMode="decimal" value={amounts[c.id] ?? ''} onChange={(e) => setAmounts({ ...amounts, [c.id]: e.target.value })} />
        </label>
      ))}
      <Button type="submit" variant="primary" disabled={change.busy || !name.trim() || !day || members.length === 0}>
        {t('createPayroll')}
      </Button>
    </form>
  );
}

function PayrollView({ p, change, t }: { p: BusinessCryptoPayroll; change: Change; t: T }) {
  const [period, setPeriod] = useState('');
  return (
    <div data-testid="payroll-row" data-id={p.id} data-name={p.name}>
      <h3>{p.name}</h3>
      <p>{t('everyMonth', { day: p.dayOfMonth, asset: p.assetId })}</p>
      <ul>
        {p.members.map((m) => (
          <li key={m.contractorId}>
            {m.name} · {m.amount} {p.assetId}
          </li>
        ))}
      </ul>
      <form
        aria-label={`${t('prepareRun')} ${p.name}`}
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          void change.run('businessPayouts.prepareRun', { payrollId: p.id, period: period.trim() }, businessCryptoPayrollSchema, () =>
            t('runPrepared'),
          );
        }}
      >
        <label className="field">
          <span>{t('period')}</span>
          <input value={period} onChange={(e) => setPeriod(e.target.value)} />
        </label>
        <Button type="submit" disabled={change.busy || !period.trim()}>
          {t('prepareRun')}
        </Button>
      </form>
      {p.runs.map((r) => (
        <PayrollRunView key={r.id} r={r} change={change} t={t} />
      ))}
    </div>
  );
}

function PayrollRunView({ r, change, t }: { r: BusinessPayrollRun; change: Change; t: T }) {
  const [sig, setSig] = useState('');
  return (
    <div data-testid="payroll-run" data-period={r.period} data-status={r.status} data-key={r.runKey}>
      <h4>
        {r.period} · {r.total}
      </h4>
      <p data-testid="payroll-run-status">{r.status === 'signed' ? t('pr_signed', { address: r.walletAddress }) : t(`pr_${r.status}`)}</p>
      <h5>{t('payslipsTitle')}</h5>
      <ul>
        {r.payslips.map((s) => (
          <li key={s.contractorId} data-testid="payslip-row" data-name={s.name} data-amount={s.amount}>
            {t('payslip', { name: s.name, amount: s.amount, asset: s.assetId, address: s.walletAddress })}
          </li>
        ))}
      </ul>
      <p>
        {t('runKey')}: <code>{r.runKey}</code>
      </p>
      {r.status === 'awaiting_signature' ? (
        <form
          aria-label={`${t('signRun')} ${r.period}`}
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            void change.run('businessPayouts.signRun', { runId: r.id, signature: sig }, businessCryptoPayrollSchema, () => t('runSigned'));
          }}
        >
          <SignatureField message={r.message} address={r.walletAddress} value={sig} onChange={setSig} t={t} />
          <Button type="submit" variant="primary" disabled={change.busy || !sig}>
            {t('signRun')}
          </Button>
        </form>
      ) : (
        <p data-testid="payroll-rail">{t('railCrypto')}</p>
      )}
    </div>
  );
}

/** `/bank/business/contractor-join?token=`. */
export function ContractorJoinRoom({ search }: { search: string }) {
  const { t } = copy.useCopy();
  const { userId } = useSession();
  const token = new URLSearchParams(search).get('token');
  const path = `/bank/business/contractor-join${search}`;
  const [rev, setRev] = useState(0);
  const info = useBank('businessPayouts.inviteInfo', token ? { token } : null, businessContractorInviteInfoSchema, token ?? '-', rev);
  const change = useChange(() => setRev((n) => n + 1));
  const [form, setForm] = useState({ name: '', email: '', iban: '', wallet: '' });
  const [joined, setJoined] = useState<string | null>(null);
  let state: RoomState = { kind: 'ready' };
  if (!userId) state = signedOutState(t, path);
  else if (!token) state = { kind: 'refused', refusal: { variant: 'refused', title: t('joinTitle'), body: t('joinNoToken') } };
  else if (info.resource.status === 'failed')
    state = { kind: 'refused', refusal: { variant: 'refused', title: t('readFailedTitle'), body: info.resource.failure.message } };
  else if (info.resource.status !== 'ready') state = { kind: 'loading' };
  const i = ready(info.resource);
  return (
    <FlowTemplate
      title={t('joinTitle')}
      description={t('joinDescription')}
      state={state}
      step={
        i && token ? (
          <div data-testid="contractor-join">
            <Notice text={joined ? t('joined', { name: joined }) : change.notice} />
            <Refused out={change.failed} t={t} />
            <p>{t('joinFor', { name: i.businessName })}</p>
            {!i.open && !joined ? <p>{t('joinClosed')}</p> : null}
            {i.open && !joined ? (
              <form
                aria-label={t('join')}
                onSubmit={(e: FormEvent) => {
                  e.preventDefault();
                  void change
                    .run(
                      'businessPayouts.joinAsContractor',
                      {
                        token,
                        name: form.name.trim(),
                        email: form.email.trim() || null,
                        iban: form.iban.trim() || null,
                        walletAddress: form.wallet.trim() || null,
                      },
                      businessContractorJoinedSchema,
                    )
                    .then((r) => {
                      if (r) setJoined(r.businessName);
                    });
                }}
              >
                <label className="field">
                  <span>{t('name')}</span>
                  <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
                </label>
                <label className="field">
                  <span>{t('email')}</span>
                  <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
                </label>
                <label className="field">
                  <span>{t('iban')}</span>
                  <input value={form.iban} onChange={(e) => setForm({ ...form, iban: e.target.value })} />
                </label>
                <label className="field">
                  <span>{t('wallet')}</span>
                  <input value={form.wallet} onChange={(e) => setForm({ ...form, wallet: e.target.value })} />
                </label>
                <Button type="submit" variant="primary" disabled={change.busy || !form.name.trim()}>
                  {t('join')}
                </Button>
              </form>
            ) : null}
          </div>
        ) : null
      }
      summary={<p>{t('inviteBody')}</p>}
    />
  );
}
