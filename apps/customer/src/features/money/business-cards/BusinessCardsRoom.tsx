import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { z, type ZodType } from 'zod';
import { Button } from '@intafaced/ui';
import { FlowTemplate, type RoomState } from '@intafaced/ui/lit/templates';
import {
  BUSINESS_CARD_API_PATHS,
  BUSINESS_RECEIPT_TYPES,
  businessCardLimitRequestSchema,
  businessCardPurchaseSchema,
  businessCardSchema,
  businessExpensePolicySchema,
  businessExpensesOverviewSchema,
  businessReceiptsZipSchema,
  businessReimbursementSchema,
  type BusinessCard,
  type BusinessCardPurchase,
  type BusinessReimbursement,
} from '@intafaced/contracts/bank-business-cards';
import { businessTeamMemberSchema, businessTeamOverviewSchema } from '@intafaced/contracts/bank-business-team';
import { defineCopy } from '../../../shared/i18n';
import type { ApiResult } from '../../../shared/api';
import { useResource, type Resource } from '../../../shared/resource';
import { useSession } from '../../session/session';
import { useHeldId, type HeldId } from '../business-team/held-id';

/**
 * A business gives its team cards and handles their expenses (J-bank-22; BK-bcard-01, BK-bexp-01, BK-bexp-02), on the
 * flow template.
 *
 * `/bank/business/cards`: in Business mode, the business picked in the account menu. An admin issues a TEST card to a
 * member with a per-purchase limit; the member sees it and spends on the TEST card network (`rail.card` is not
 * connected). Over the limit the card declines `over_limit` and asks the admin. A capture over the business's receipt
 * rule needs a receipt, with one reminder queued; every receipt downloads as one ZIP. A member claims back what they paid
 * themselves; an approver approves and pays it as one transfer at the partner bank. The money is the partner bank's:
 * INTAFACED posts nothing to its own books. Every check is the bank's; this page shows what it reports and its refusals.
 */
const copy = defineCopy('money.business-cards', {
  title: 'Team cards and expenses',
  description: 'Give your team cards, chase receipts and pay back expenses',
  personalTitle: 'Choose a business',
  personalBody: 'You are in your personal profile. Pick a business in the account menu to see its team cards.',
  signedOutTitle: 'Sign in to continue',
  signedOutBody: 'A business’s cards and expenses belong to its members.',
  signIn: 'Sign in',
  readFailedTitle: 'This could not be read',
  refusedTitle: 'It was not done',
  testCards: 'TEST cards on the TEST card network: no card scheme is connected here (rail.card), and no card number, CVC or PIN exists.',
  issueTitle: 'Issue a card',
  member: 'Team member',
  limit: 'Per-purchase limit',
  issue: 'Issue card',
  issued: 'Card issued.',
  cardsTitle: 'Cards',
  cardsEmpty: 'No cards yet.',
  card: 'TEST card •••• {tail} for {who}: up to {limit} {asset} a purchase',
  you: 'you',
  spendTitle: 'Spend on the TEST card network',
  merchant: 'Merchant',
  amount: 'Amount',
  spend: 'Pay with this card',
  spent: 'The card network answered.',
  purchasesTitle: 'Purchases',
  purchasesEmpty: 'No purchases yet.',
  purchase: '{merchant}: {amount} {asset} on •••• {tail}',
  p_captured: 'Captured at the partner bank',
  p_capturing: 'Being captured: the partner’s answer is not known yet',
  p_declined: 'Declined: {reason}',
  overLimitAsked: 'An over-limit request was sent to your admin.',
  needsReceipt: 'Needs receipt',
  reminderQueued: 'One reminder queued',
  receiptGiven: 'Receipt given',
  receiptFile: 'Receipt file',
  attach: 'Give receipt',
  attached: 'Receipt given.',
  requestsTitle: 'Over-limit requests',
  requestsEmpty: 'No over-limit requests.',
  request: '{amount} on card •••• {tail}: {status}',
  r_open: 'waiting for you',
  r_approved: 'approved: the limit was raised',
  r_declined: 'declined',
  approveRequest: 'Raise the limit',
  declineRequest: 'Decline',
  decided: 'Request answered.',
  policyTitle: 'Receipt rule',
  policyNone: 'No receipt rule: no purchase needs a receipt.',
  policy: 'A purchase over {amount} {asset} needs a receipt.',
  receiptOver: 'Receipt needed over',
  setPolicy: 'Save rule',
  policySaved: 'Receipt rule saved.',
  download: 'Download all receipts',
  downloaded: '{count} receipt(s) downloaded.',
  claimTitle: 'Claim back an expense',
  claimBody: 'For something you paid yourself. Attach the receipt; an approver pays it back to your own account.',
  claimFor: 'What it was for',
  submitClaim: 'Submit claim',
  claimSubmitted: 'Claim submitted for review.',
  claimsTitle: 'Reimbursement claims',
  claimsEmpty: 'No claims yet.',
  claim: '{amount} {asset}: {description}',
  c_submitted: 'A claim for review',
  c_paying: 'Being paid: the partner’s answer is not known yet',
  c_paid: 'Paid and closed: one transfer at {label}',
  c_declined: 'Declined',
  approvePay: 'Approve and pay',
  paid: 'Claim paid.',
  memberBalance: 'Member’s balance at {label}: {before} → {after} {asset}',
  myBalance: 'Your balance at {label}: {amount} {asset}',
  myBalanceUnknown: 'Your balance at {label}: not known',
  partnerRef: 'Partner reference',
  apiTitle: 'Card API',
  apiBody: 'The same doors this page uses, with your API session. Listed under Developers.',
  apiDocs: 'Developers',
});
type T = ReturnType<typeof copy.useCopy>['t'];
type Failed = Extract<ApiResult<unknown>, { ok: false }>;

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={`cards-${id}`} data-testid={`cards-${id}`}>
      <h2 id={`cards-${id}`}>{title}</h2>
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
    `cards:${procedure}:${userId ?? 'out'}:${base}:${rev}`,
  );
  const kept = useRef<{ base: string; data: S } | null>(null);
  const keyed = `${userId ?? 'out'}:${base}`;
  if (read.resource.status === 'ready') kept.current = { base: keyed, data: read.resource.data };
  if (read.resource.status === 'loading' && kept.current?.base === keyed) {
    return { resource: { status: 'ready', data: kept.current.data } as Resource<S>, reload: read.reload };
  }
  return read;
}

function useChange(after: () => void) {
  const { api } = useSession();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<Failed | null>(null);
  const [notice, setNotice] = useState('');
  async function run<S>(procedure: string, body: unknown, schema: ZodType<S>, done: (data: S) => string, held?: HeldId) {
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
    setNotice(done(out.data));
    after();
    return out.data;
  }
  return { busy, failed, notice, setNotice, setFailed, run };
}
type Change = ReturnType<typeof useChange>;

const ready = <S,>(r: Resource<S>): S | null => (r.status === 'ready' ? r.data : null);

/** A file as base64, for a receipt. */
async function fileBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
const receiptType = (file: File) =>
  (BUSINESS_RECEIPT_TYPES as readonly string[]).includes(file.type) ? file.type : file.name.endsWith('.txt') ? 'text/plain' : file.type;

/** `/bank/business/cards`. */
export function BusinessCardsRoom() {
  const { t } = copy.useCopy();
  const { userId, profiles } = useSession();
  const business = profiles.business;
  const accountId = business?.accountId ?? null;
  const overview = useBank('businessTeam.overview', accountId ? { accountId } : null, businessTeamOverviewSchema, accountId ?? '-');
  let state: RoomState = { kind: 'ready' };
  if (!userId)
    state = {
      kind: 'refused',
      refusal: {
        variant: 'refused',
        title: t('signedOutTitle'),
        body: t('signedOutBody'),
        action: { label: t('signIn'), href: `/login?redirect=${encodeURIComponent('/bank/business/cards')}` },
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
          <div data-testid="cards-room" data-account={accountId}>
            <p data-testid="cards-business">{o.account.name}</p>
            <p>{t('testCards')}</p>
            <Parts accountId={accountId} assetId={o.account.assetId} label={o.partner?.label ?? ''} reloadTop={overview.reload} t={t} />
          </div>
        ) : null
      }
      summary={
        <div data-testid="cards-api" id="card-api">
          <h2>{t('apiTitle')}</h2>
          <p>{t('apiBody')}</p>
          <ul>
            {Object.entries(BUSINESS_CARD_API_PATHS).map(([door, path]) => (
              <li key={door} data-testid="card-api-path" data-door={door}>
                <code>{path}</code>
              </li>
            ))}
          </ul>
          <a className="text-link" href="/developers/business-cards">
            {t('apiDocs')}
          </a>
        </div>
      }
    />
  );
}

function Parts({
  accountId,
  assetId,
  label,
  reloadTop,
  t,
}: {
  accountId: string;
  assetId: string;
  label: string;
  reloadTop: () => void;
  t: T;
}) {
  const { userId, api } = useSession();
  const [rev, setRev] = useState(0);
  const input = { accountId };
  const data = useBank('businessCards.overview', input, businessExpensesOverviewSchema, accountId, rev);
  const o = ready(data.resource);
  const admin = o?.permissions.includes('manage_team') ?? false;
  const approver = o?.permissions.includes('approve') ?? false;
  const exporter = o?.permissions.includes('export') ?? false;
  const members = useBank('businessTeam.members', admin ? input : null, z.array(businessTeamMemberSchema), `${accountId}:${admin}`, rev);
  const change = useChange(() => {
    setRev((n) => n + 1);
    reloadTop();
  });
  if (data.resource.status === 'failed') return <p role="alert">{data.resource.failure.message}</p>;
  if (!o) return null;
  const tails = new Map(o.cards.map((c) => [c.id, c.panTail]));
  const mine = o.cards.filter((c) => c.memberUserId === userId);

  async function download() {
    change.setFailed(null);
    const out = await api.query('bank', 'businessCards.receiptsZip', { accountId }, businessReceiptsZipSchema);
    if (!out.ok) {
      change.setFailed(out);
      return;
    }
    const bytes = Uint8Array.from(atob(out.data.zipBase64), (ch) => ch.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = out.data.fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    change.setNotice(t('downloaded', { count: String(out.data.count) }));
  }

  return (
    <>
      {change.notice ? (
        <p role="status" data-testid="cards-notice">
          {change.notice}
        </p>
      ) : null}
      {change.failed ? (
        <p role="alert" data-testid="cards-refusal" data-code={change.failed.code ?? ''}>
          {t('refusedTitle')}: {change.failed.message}
        </p>
      ) : null}
      {o.myBalance ? (
        <p data-testid="cards-my-balance" data-amount={o.myBalance.amount ?? ''}>
          {o.myBalance.amount === null
            ? t('myBalanceUnknown', { label: o.myBalance.label })
            : t('myBalance', { label: o.myBalance.label, amount: o.myBalance.amount, asset: assetId })}
        </p>
      ) : null}

      {admin ? (
        <Section id="issue" title={t('issueTitle')}>
          <IssueForm accountId={accountId} members={ready(members.resource) ?? []} change={change} t={t} />
        </Section>
      ) : null}

      <Section id="cards" title={t('cardsTitle')}>
        {o.cards.length === 0 ? <p>{t('cardsEmpty')}</p> : null}
        <ul>
          {o.cards.map((c) => (
            <li key={c.id} data-testid="business-card" data-card={c.id} data-limit={c.perPurchaseLimit} data-member={c.memberUserId}>
              {t('card', {
                tail: c.panTail,
                who: c.memberUserId === userId ? t('you') : (c.memberHandle ?? c.memberUserId),
                limit: c.perPurchaseLimit,
                asset: c.assetId,
              })}
            </li>
          ))}
        </ul>
        {mine.length > 0 ? <SpendForm cards={mine} change={change} t={t} /> : null}
      </Section>

      <Section id="purchases" title={t('purchasesTitle')}>
        {o.purchases.length === 0 ? <p>{t('purchasesEmpty')}</p> : null}
        <ul>
          {o.purchases.map((p) => (
            <PurchaseRow key={p.id} p={p} tail={tails.get(p.cardId) ?? p.panTail} mine={p.memberUserId === userId} change={change} t={t} />
          ))}
        </ul>
      </Section>

      {admin ? (
        <Section id="requests" title={t('requestsTitle')}>
          {o.limitRequests.length === 0 ? <p>{t('requestsEmpty')}</p> : null}
          <ul>
            {o.limitRequests.map((r) => (
              <li key={r.purchaseId} data-testid="limit-request" data-purchase={r.purchaseId} data-status={r.status} data-amount={r.amount}>
                {t('request', { amount: r.amount, tail: tails.get(r.cardId) ?? '', status: t(`r_${r.status}`) })}
                {r.status === 'open' ? (
                  <>
                    <Button
                      type="button"
                      disabled={change.busy}
                      onClick={() =>
                        void change.run(
                          'businessCards.decideLimitRequest',
                          { purchaseId: r.purchaseId, approve: true },
                          businessCardLimitRequestSchema,
                          () => t('decided'),
                        )
                      }
                    >
                      {t('approveRequest')}
                    </Button>
                    <Button
                      type="button"
                      disabled={change.busy}
                      onClick={() =>
                        void change.run(
                          'businessCards.decideLimitRequest',
                          { purchaseId: r.purchaseId, approve: false },
                          businessCardLimitRequestSchema,
                          () => t('decided'),
                        )
                      }
                    >
                      {t('declineRequest')}
                    </Button>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <Section id="policy" title={t('policyTitle')}>
        <p data-testid="receipt-policy" data-over={o.policy.receiptOver ?? ''}>
          {o.policy.receiptOver === null ? t('policyNone') : t('policy', { amount: o.policy.receiptOver, asset: assetId })}
        </p>
        {admin ? <PolicyForm accountId={accountId} change={change} t={t} /> : null}
        {exporter ? (
          <Button type="button" disabled={change.busy} onClick={() => void download()}>
            {t('download')}
          </Button>
        ) : null}
      </Section>

      <Section id="claim" title={t('claimTitle')}>
        <p>{t('claimBody')}</p>
        <ClaimForm accountId={accountId} change={change} t={t} />
      </Section>

      <Section id="claims" title={t('claimsTitle')}>
        {o.claims.length === 0 ? <p>{t('claimsEmpty')}</p> : null}
        <ul>
          {o.claims.map((c) => (
            <ClaimRow key={c.id} c={c} label={label} me={userId} approver={approver} change={change} t={t} />
          ))}
        </ul>
      </Section>
    </>
  );
}

function IssueForm({
  accountId,
  members,
  change,
  t,
}: {
  accountId: string;
  members: Array<z.infer<typeof businessTeamMemberSchema>>;
  change: Change;
  t: T;
}) {
  const held = useHeldId();
  const [who, setWho] = useState('');
  const [limit, setLimit] = useState('');
  return (
    <form
      aria-label={t('issueTitle')}
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        void change.run(
          'businessCards.issueCard',
          { accountId, cardId: held.id, memberUserId: who, perPurchaseLimit: limit.trim() },
          businessCardSchema,
          () => t('issued'),
          held,
        );
      }}
    >
      <label className="field">
        <span>{t('member')}</span>
        <select value={who} onChange={(e) => setWho(e.target.value)} required>
          <option value="" />
          {members.map((m) => (
            <option key={m.userId} value={m.userId}>
              {m.handle}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>{t('limit')}</span>
        <input inputMode="decimal" value={limit} onChange={(e) => setLimit(e.target.value)} required />
      </label>
      <Button type="submit" variant="primary" disabled={change.busy || !who || !limit.trim()}>
        {t('issue')}
      </Button>
    </form>
  );
}

function SpendForm({ cards, change, t }: { cards: BusinessCard[]; change: Change; t: T }) {
  const held = useHeldId();
  const [cardId, setCardId] = useState(cards[0]!.id);
  const [merchant, setMerchant] = useState('');
  const [amount, setAmount] = useState('');
  return (
    <form
      aria-label={t('spendTitle')}
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        void change.run(
          'businessCards.testPurchase',
          { cardId, purchaseId: held.id, merchant: merchant.trim(), amount: amount.trim() },
          businessCardPurchaseSchema,
          () => t('spent'),
          held,
        );
      }}
    >
      <h3>{t('spendTitle')}</h3>
      {cards.length > 1 ? (
        <select value={cardId} onChange={(e) => setCardId(e.target.value)} aria-label={t('cardsTitle')}>
          {cards.map((c) => (
            <option key={c.id} value={c.id}>
              •••• {c.panTail}
            </option>
          ))}
        </select>
      ) : null}
      <label className="field">
        <span>{t('merchant')}</span>
        <input value={merchant} onChange={(e) => setMerchant(e.target.value)} required />
      </label>
      <label className="field">
        <span>{t('amount')}</span>
        <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required />
      </label>
      <Button type="submit" variant="primary" disabled={change.busy || !merchant.trim() || !amount.trim()}>
        {t('spend')}
      </Button>
    </form>
  );
}

function PurchaseRow({ p, tail, mine, change, t }: { p: BusinessCardPurchase; tail: string; mine: boolean; change: Change; t: T }) {
  const held = useHeldId();
  const [file, setFile] = useState<File | null>(null);
  return (
    <li
      data-testid="card-purchase"
      data-purchase={p.id}
      data-status={p.status}
      data-reason={p.declineReason ?? ''}
      data-amount={p.amount}
      data-needs-receipt={String(p.needsReceipt)}
      data-reminders={p.reminders}
    >
      <span>{t('purchase', { merchant: p.merchant, amount: p.amount, asset: p.assetId, tail })}</span>{' '}
      <span data-testid="purchase-state">
        {p.status === 'declined' ? t('p_declined', { reason: p.declineReason ?? '' }) : t(`p_${p.status}`)}
      </span>
      {p.limitRequest ? <p data-testid="purchase-request">{t('overLimitAsked')}</p> : null}
      {p.needsReceipt ? (
        <p data-testid="purchase-receipt">
          <strong>{t('needsReceipt')}</strong>
          {p.reminders > 0 ? ` · ${t('reminderQueued')}` : ''}
        </p>
      ) : p.receiptId ? (
        <p data-testid="purchase-receipt">{t('receiptGiven')}</p>
      ) : null}
      {p.needsReceipt && mine ? (
        <form
          aria-label={`${t('attach')} ${p.merchant}`}
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (!file) return;
            void fileBase64(file).then((contentBase64) =>
              change.run(
                'businessCards.attachReceipt',
                { purchaseId: p.id, receiptId: held.id, fileName: file.name, contentType: receiptType(file), contentBase64 },
                businessCardPurchaseSchema,
                () => t('attached'),
                held,
              ),
            );
          }}
        >
          <label className="field">
            <span>{t('receiptFile')}</span>
            <input type="file" accept={BUSINESS_RECEIPT_TYPES.join(',')} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </label>
          <Button type="submit" disabled={change.busy || !file}>
            {t('attach')}
          </Button>
        </form>
      ) : null}
    </li>
  );
}

function PolicyForm({ accountId, change, t }: { accountId: string; change: Change; t: T }) {
  const [over, setOver] = useState('');
  return (
    <form
      aria-label={t('policyTitle')}
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        void change.run('businessCards.setPolicy', { accountId, receiptOver: over.trim() }, businessExpensePolicySchema, () =>
          t('policySaved'),
        );
      }}
    >
      <label className="field">
        <span>{t('receiptOver')}</span>
        <input inputMode="decimal" value={over} onChange={(e) => setOver(e.target.value)} required />
      </label>
      <Button type="submit" disabled={change.busy || !over.trim()}>
        {t('setPolicy')}
      </Button>
    </form>
  );
}

function ClaimForm({ accountId, change, t }: { accountId: string; change: Change; t: T }) {
  const claim = useHeldId();
  const receipt = useHeldId();
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [file, setFile] = useState<File | null>(null);
  return (
    <form
      aria-label={t('claimTitle')}
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        if (!file) return;
        void fileBase64(file).then(async (contentBase64) => {
          const body = {
            accountId,
            claimId: claim.id,
            amount: amount.trim(),
            description: description.trim(),
            receiptId: receipt.id,
            fileName: file.name,
            contentType: receiptType(file),
            contentBase64,
          };
          const out = await change.run('businessCards.submitClaim', body, businessReimbursementSchema, () => t('claimSubmitted'), claim);
          if (out) receipt.settle({ ok: true });
        });
      }}
    >
      <label className="field">
        <span>{t('amount')}</span>
        <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required />
      </label>
      <label className="field">
        <span>{t('claimFor')}</span>
        <input value={description} onChange={(e) => setDescription(e.target.value)} required />
      </label>
      <label className="field">
        <span>{t('receiptFile')}</span>
        <input type="file" accept={BUSINESS_RECEIPT_TYPES.join(',')} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </label>
      <Button type="submit" variant="primary" disabled={change.busy || !file || !amount.trim() || !description.trim()}>
        {t('submitClaim')}
      </Button>
    </form>
  );
}

function ClaimRow({
  c,
  label,
  me,
  approver,
  change,
  t,
}: {
  c: BusinessReimbursement;
  label: string;
  me: string | null;
  approver: boolean;
  change: Change;
  t: T;
}) {
  return (
    <li
      data-testid="claim"
      data-claim={c.id}
      data-status={c.status}
      data-amount={c.amount}
      data-before={c.memberBefore ?? ''}
      data-after={c.memberAfter ?? ''}
      data-partner-move={c.partnerMoveId ?? ''}
    >
      <span>{t('claim', { amount: c.amount, asset: c.assetId, description: c.description })}</span>{' '}
      <span data-testid="claim-state">{c.status === 'paid' ? t('c_paid', { label }) : t(`c_${c.status}`)}</span>
      {c.refusalCode ? <span data-testid="claim-refusal"> ({c.refusalCode})</span> : null}
      {c.partnerMoveId ? (
        <p>
          {t('partnerRef')}: <code data-testid="claim-partner-ref">{c.partnerMoveId}</code>
        </p>
      ) : null}
      {c.status === 'paid' && c.memberBefore !== null && c.memberAfter !== null ? (
        <p data-testid="claim-member-balance">
          {t('memberBalance', { label, before: c.memberBefore, after: c.memberAfter, asset: c.assetId })}
        </p>
      ) : null}
      {approver && c.memberUserId !== me && (c.status === 'submitted' || c.status === 'paying') ? (
        <Button
          type="button"
          variant="primary"
          disabled={change.busy}
          onClick={() => void change.run('businessCards.approveAndPay', { claimId: c.id }, businessReimbursementSchema, () => t('paid'))}
        >
          {t('approvePay')}
        </Button>
      ) : null}
    </li>
  );
}
