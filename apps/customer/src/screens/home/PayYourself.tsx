/**
 * Pay yourself from your trading, on Home (J-bank-31). "Spendable now" is the partner balance, the venue's withdrawable
 * figure and the wallet's stablecoins, each with its own source and time, with "Locked in trades" apart, from the venue.
 * Paying yourself is ONE venue withdrawal, signed once in the person's own wallet after a fresh second factor, straight
 * to their own account at the partner (its pay-in); the room then shows where the money is at every moment, as each
 * source last reported it: the venue's withdrawal, the partner's credit, the card. INTAFACED holds none of it and the
 * ledger posts nothing. A weekly rule prepares a move that waits for the same one signature; nothing moves without it.
 */
// hand-declared-ok: svc-bank's cards.list and cards.partnerHeld answers have no browser-safe schema in packages/contracts; this narrows them
import { useId, useMemo, useState } from 'react';
import { z } from 'zod';
import { Button } from '@intafaced/ui';
import { Field } from '../../shared/ui';
import { displayAmount } from '../../shared/money';
import { useSession } from '../../features/session/session';
import { StepUpConfirm } from '../../features/money/StepUpConfirm';
import type { StepUpBegin } from '../../features/account/security-step-up';
import { useWallet } from '../../features/protocol/wallet/WalletProvider';
import type { TypedDataDocument } from '../../features/protocol/wallet/eip1193';
import { usePolled } from '../../features/protocol/wallet/use-polled';
import {
  canonicalAmount,
  createVenueAccountApi,
  withDomainTypes,
  type VenueWithdrawal,
  type VenueWithdrawalTerms,
} from '../../features/protocol/venue-wallet/venue-account-api';
import type { VenueUp } from '../../features/trade/venue-api';
import type { PartnerRead } from '../money/standing-data';
import type { VenueRow, WalletRead } from '../money/where-it-sits';
import { payYourselfCopy } from './pay-yourself-copy';
import {
  PAY_ASSET,
  creditFor,
  lockedInTrades,
  manualMoveKey,
  onItsWay,
  payRefusal,
  payYourselfSummarySchema,
  sourceFigure,
  spendableNow,
  venueFigures,
  type PayMove,
  type PayYourselfSummary,
} from './pay-yourself';

type T = ReturnType<typeof payYourselfCopy.useCopy>['t'];
const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;
const READ_EVERY_MS = 2_000;

const moveSchema = payYourselfSummarySchema.shape.moves.element;
const ruleSchema = payYourselfSummarySchema.shape.rule.unwrap();
const cardRowsSchema = z.array(z.object({ id: z.string(), assetId: z.string(), status: z.string() }));
const cardHeldSchema = z.object({
  heldBy: z.enum(['ledger', 'partner', 'none']),
  figures: z.object({ assetId: z.string(), available: z.string().nullable() }).passthrough().nullable(),
});

function At({ iso }: { iso: string | null | undefined }) {
  if (!iso) return null;
  return <time dateTime={iso}>{new Date(iso).toLocaleTimeString()}</time>;
}

interface Ask {
  readonly moveKey: string;
  readonly amount: string;
  readonly terms: VenueWithdrawalTerms | null;
  readonly phase: 'review' | 'stepUp';
}

export default function PayYourself({
  owner,
  status,
  partner,
  venue,
  wallet: walletRead,
}: {
  owner: string;
  status: VenueUp;
  partner: PartnerRead;
  venue: { data: { asOf: string; rows: VenueRow[] } | null; failure: unknown };
  wallet: { data: WalletRead | null };
}) {
  const { t } = payYourselfCopy.useCopy();
  const { api, userId } = useSession();
  const wallet = useWallet();
  const account = useMemo(() => createVenueAccountApi(api), [api]);
  const summary = usePolled(
    (signal) => api.query('bank', 'payYourself.summary', undefined, payYourselfSummarySchema, { signal }),
    `payYourself:${userId}`,
    READ_EVERY_MS,
  );
  const [amount, setAmount] = useState<string | null>(null);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [refusal, setRefusal] = useState<{ title: string; body: string; code?: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const partnerName = partner.state === 'read' ? partner.label : t('partPartnerUnnamed');
  const venueRows = venue.data?.rows ?? [];
  const { withdrawable } = venueFigures(venueRows);
  const parts = spendableNow([
    sourceFigure('partner', partner.state === 'read' ? { state: 'read', asOf: partner.asOf, rows: partner.rows } : partner),
    sourceFigure(
      'venue',
      venue.data
        ? { state: 'read', asOf: venue.data.asOf, rows: venueRows.map((r) => ({ asset: r.asset, amount: r.withdrawable })) }
        : { state: venue.failure ? 'unread' : 'reading' },
    ),
    sourceFigure(
      'wallet',
      !walletRead.data
        ? { state: 'reading' }
        : walletRead.data.ok
          ? { state: 'read', asOf: walletRead.data.asOf, rows: walletRead.data.rows.map((r) => ({ asset: r.symbol, amount: r.amount })) }
          : { state: 'unread' },
    ),
  ]);
  const s = summary.data;
  const realised = s && !('unread' in s.realised) ? s.realised : null;
  const shownAmount = amount ?? (realised && /[1-9]/.test(realised.amount) && !realised.amount.startsWith('-') ? realised.amount : '');

  async function begin(moveKey: string, value: string) {
    if (busy) return;
    setRefusal(null);
    setBusy(true);
    try {
      const terms = await account.withdrawalTerms(owner, PAY_ASSET);
      const published = terms.ok ? terms.data.value : null;
      const fee = published && published.fee.known ? published.fee.value : null;
      const why = payRefusal(value, withdrawable, fee);
      if (why === 'amount') return setRefusal({ title: t('amountTitle'), body: t('amountBody') });
      if (why === 'above_withdrawable')
        return setRefusal({
          title: t('aboveTitle'),
          body: t('aboveBody', { withdrawable: displayAmount(withdrawable) }),
          code: 'bank.above_withdrawable',
        });
      setAsk({ moveKey, amount: canonicalAmount(value) ?? value, terms: published, phase: 'review' });
    } finally {
      setBusy(false);
    }
  }

  const stepUp = (a: Ask, destination: string): StepUpBegin => ({
    scope: 'trade.step_up.venue.withdraw',
    purpose: 'venue.withdraw',
    target: a.moveKey,
    amount: a.amount,
    fields: { withdrawalKey: a.moveKey, owner, subAccount: '', asset: PAY_ASSET, amount: a.amount, destination },
  });

  async function send(a: Ask, destination: string, stepUpApprovalId: string | null) {
    if (busy) return;
    setBusy(true);
    try {
      const prepared = await account.prepareWithdrawal({
        owner,
        asset: PAY_ASSET,
        amount: a.amount,
        destination,
        withdrawalKey: a.moveKey,
        stepUpApprovalId,
      });
      if (!prepared.ok) {
        setAsk(null);
        return setRefusal({ title: t('refusedTitle'), body: t('refusedBody', { detail: prepared.message }), code: prepared.code });
      }
      const typedData = withDomainTypes(prepared.data.prepared.typedData) as TypedDataDocument;
      const signed = await wallet.sign({ kind: 'typedData', typedData });
      if (signed.status !== 'signed') {
        setAsk(null);
        return setRefusal({ title: t('refusedTitle'), body: signed.status === 'rejected' ? t('signRejected') : t('signFailed') });
      }
      const submitted = await account.submit(prepared.data.actionKey, {
        digest: prepared.data.prepared.digest,
        signature: signed.signature,
        signedBy: owner,
      });
      setAsk(null);
      if (!submitted.ok)
        return setRefusal({ title: t('refusedTitle'), body: t('refusedBody', { detail: submitted.message }), code: submitted.code });
      const outcome = submitted.data.outcome;
      if (outcome.definite && !outcome.accepted)
        return setRefusal({
          title: t('refusedTitle'),
          body: t('refusedBody', { detail: outcome.refusal.detail }),
          code: `trade.venue.${outcome.refusal.code}`,
        });
      // The venue took it (or may have): the move is recorded by its key and the venue's nonce; the venue's record decides.
      await api.mutate(
        'bank',
        'payYourself.record',
        { moveKey: a.moveKey, owner, nonce: prepared.data.prepared.nonce, amount: a.amount },
        moveSchema,
      );
      setAmount(null);
      summary.reload();
    } finally {
      setBusy(false);
    }
  }

  const payIn = s && !('unset' in s.payIn) ? s.payIn : null;
  const lastSent = s?.moves.find((m) => m.status === 'sent') ?? null;
  const prepared = s?.moves.filter((m) => m.status === 'prepared') ?? [];

  return (
    <div className="form-stack" data-testid="pay-yourself-home">
      <section aria-label={t('spendableTitle')} data-testid="spendable-now" className="form-stack">
        <h2>{t('spendableTitle')}</h2>
        <p data-testid="spendable-total">
          {parts.total !== null ? t('spendableTotal', { amount: displayAmount(parts.total) }) : t('spendableNoTotal')}
        </p>
        <p className="muted">{t('spendableNote')}</p>
        <ul>
          {parts.parts.map((part) => (
            <li key={part.id} data-spendable={part.id}>
              <span data-part-name>
                {part.id === 'partner'
                  ? t('partPartner', { name: partnerName })
                  : part.id === 'venue'
                    ? t('partVenue', { name: status.venue.displayName })
                    : t('partWallet')}
              </span>{' '}
              {part.state === 'read' ? (
                <>
                  <strong data-part-amount>{displayAmount(part.amount)} USD</strong>{' '}
                  <span className="muted" data-part-source>
                    {part.id === 'partner' ? t('sourcePartner') : part.id === 'venue' ? t('sourceVenue') : t('sourceWallet')}, {t('asOf')}
                    <At iso={part.asOf} />
                  </span>
                </>
              ) : (
                <span className="muted">{part.state === 'reading' ? t('partReading') : t('partUnread')}</span>
              )}
            </li>
          ))}
        </ul>
        {s && onItsWay(s.credits).length > 0 ? (
          <div data-testid="on-its-way">
            <h3>{t('onItsWayTitle')}</h3>
            <p className="muted">{t('onItsWayNote')}</p>
            <ul>
              {onItsWay(s.credits).map((c) => (
                <li key={c.key} data-credit={c.txHash}>
                  {c.held
                    ? t('onItsWayHeld', { amount: displayAmount(c.amount), partner: partnerName })
                    : t('onItsWayLine', { amount: displayAmount(c.amount), partner: partnerName })}{' '}
                  <At iso={c.seenAt} />
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      <section aria-label={t('lockedTitle')} data-testid="locked-in-trades">
        <h3>{t('lockedTitle')}</h3>
        {venue.data ? (
          <p>
            <strong data-locked-amount>{displayAmount(lockedInTrades(venueRows))} USD</strong>{' '}
            <span className="muted">
              {t('sourceVenue')}, {t('asOf')}
              <At iso={venue.data.asOf} />
            </span>
          </p>
        ) : (
          <p className="muted">{venue.failure ? t('partUnread') : t('partReading')}</p>
        )}
        <p className="muted">{t('lockedNote')}</p>
      </section>

      <section aria-label={t('payTitle')} data-testid="pay-yourself" className="form-stack">
        <h2>{t('payTitle')}</h2>
        {!s ? (
          <p className="muted">{t('partReading')}</p>
        ) : !payIn ? (
          <p data-testid="pay-in-unset">{t('payInUnset')}</p>
        ) : 'unread' in s.realised ? (
          <p data-testid="realised-unread">
            {t('realisedUnread')} <code>{s.realised.unread}</code>
          </p>
        ) : (
          <>
            <p data-testid="realised-profit">
              {t('realised', { amount: displayAmount(s.realised.amount) })} ({lastSent ? t('realisedSince') : t('realisedEver')}),{' '}
              {t('asOf')}
              <At iso={s.realised.asOf} />
            </p>
            {shownAmount === '' && !ask ? <p className="muted">{t('realisedNone')}</p> : null}
            {!ask ? (
              <div className="form-stack">
                <Field label={t('amountLabel')} inputMode="decimal" value={shownAmount} onChange={(e) => setAmount(e.target.value)} />
                <Button disabled={busy} onClick={() => void begin(manualMoveKey(owner, Date.now()), shownAmount)}>
                  {t('payButton', { amount: displayAmount(canonicalAmount(shownAmount) ?? '0', 2) })}
                </Button>
              </div>
            ) : null}
          </>
        )}
        {refusal ? (
          <div role="alert" data-testid="pay-refusal">
            <strong>{refusal.title}</strong>
            <p>{refusal.body}</p>
            {refusal.code ? <code>{refusal.code}</code> : null}
          </div>
        ) : null}
        {ask && payIn ? (
          <Review ask={ask} t={t} partner={partnerName} partnerFee={s?.partnerFee ?? null}>
            {ask.phase === 'review' ? (
              <div className="form-stack">
                <Button disabled={busy} onClick={() => setAsk({ ...ask, phase: 'stepUp' })}>
                  {t('continue')}
                </Button>
                <Button variant="secondary" disabled={busy} onClick={() => setAsk(null)}>
                  {t('cancel')}
                </Button>
              </div>
            ) : (
              <div data-pay-step-up>
                <StepUpConfirm
                  key={ask.moveKey}
                  request={() => stepUp(ask, payIn.address)}
                  words={{
                    why: t('stepUpWhy'),
                    code: t('stepUpCode'),
                    codeHint: t('stepUpCodeHint'),
                    codeShort: t('stepUpCodeShort'),
                    noFactor: t('stepUpNoFactor'),
                    sendWithout: t('stepUpSendWithout'),
                  }}
                  disabled={busy}
                  onApproved={(id) => void send(ask, payIn.address, id)}
                />
                <Button variant="secondary" disabled={busy} onClick={() => setAsk(null)}>
                  {t('cancel')}
                </Button>
              </div>
            )}
          </Review>
        ) : null}
        {lastSent && s ? <Tracker move={lastSent} summary={s} owner={owner} t={t} partner={partnerName} account={account} /> : null}
        {prepared.map((m) => (
          <div key={m.id} data-testid="prepared-move" className="form-stack">
            <h3>{t('preparedTitle')}</h3>
            <p>
              {t('preparedLine', {
                amount: displayAmount(m.amount),
                from: m.windowFrom ? new Date(m.windowFrom).toLocaleString() : '',
                to: m.windowTo ? new Date(m.windowTo).toLocaleString() : '',
              })}
            </p>
            {!ask ? (
              <Button disabled={busy} onClick={() => void begin(m.moveKey, m.amount)}>
                {t('preparedSign', { amount: displayAmount(m.amount, 2) })}
              </Button>
            ) : null}
          </div>
        ))}
        {s && payIn ? <Rule summary={s} t={t} onSaved={() => summary.reload()} /> : null}
      </section>
    </div>
  );
}

function Review({
  ask,
  t,
  partner,
  partnerFee,
  children,
}: {
  ask: Ask;
  t: T;
  partner: string;
  partnerFee: string | null;
  children: React.ReactNode;
}) {
  const terms = ask.terms;
  return (
    <div data-testid="pay-review" className="form-stack">
      <h3>{t('reviewTitle')}</h3>
      <dl>
        <dt>{t('reviewAmount')}</dt>
        <dd data-review="amount">{displayAmount(ask.amount)} USDC</dd>
        <dt>{t('reviewTo')}</dt>
        <dd data-review="to">{t('reviewToValue', { partner })}</dd>
        <dt>{t('reviewVenueFee')}</dt>
        <dd data-review="venue-fee">{terms && terms.fee.known ? `${displayAmount(terms.fee.value)} USDC` : t('notKnown')}</dd>
        <dt>{t('reviewNetworkFee')}</dt>
        <dd data-review="network-fee">
          {terms && terms.networkFee.known ? `${displayAmount(terms.networkFee.value)} USDC` : t('notKnown')}
        </dd>
        <dt>{t('reviewPartnerFee')}</dt>
        <dd data-review="partner-fee">{partnerFee !== null ? `${displayAmount(partnerFee)} USDC` : t('notKnown')}</dd>
        <dt>{t('reviewArrival')}</dt>
        <dd data-review="arrival">
          {terms && terms.arrivalSeconds !== null ? t('reviewArrivalValue', { seconds: String(terms.arrivalSeconds) }) : t('notPublished')}
        </dd>
      </dl>
      <p className="muted">{t('reviewSign')}</p>
      {children}
    </div>
  );
}

/** Where the last move's money is, as each source last reported it: the venue's withdrawal, the partner's credit, the card. */
function Tracker({
  move,
  summary,
  owner,
  t,
  partner,
  account,
}: {
  move: PayMove;
  summary: PayYourselfSummary;
  owner: string;
  t: T;
  partner: string;
  account: ReturnType<typeof createVenueAccountApi>;
}) {
  const { api, userId } = useSession();
  const [seen, setSeen] = useState<{ pending?: string; done?: string }>({});
  const withdrawal = usePolled(
    async (signal) => {
      if (!move.venueNonce) return null;
      const read = await account.withdrawal(move.owner ?? owner, move.venueNonce, signal);
      if (read.ok && read.data.value) {
        const at = read.data.asOf;
        const state = read.data.value.status;
        setSeen((before) => ({
          pending: before.pending ?? read.data.value!.requestedAt ?? at,
          done: state === 'done' ? (before.done ?? at) : before.done,
        }));
      }
      return read;
    },
    `payYourself:withdrawal:${move.venueNonce}`,
    READ_EVERY_MS,
  );
  const record: VenueWithdrawal | null = withdrawal.data?.value ?? null;
  const credit = creditFor(summary.credits, record?.txHash);
  const card = usePolled<{ held: z.infer<typeof cardHeldSchema> | null }>(
    async (signal) => {
      const cards = await api.query('bank', 'cards.list', { limit: 50 }, cardRowsSchema, { signal });
      if (!cards.ok) return cards;
      const first = cards.data.find((c) => c.assetId === PAY_ASSET && c.status !== 'closed');
      if (!first) return { ok: true as const, data: { held: null } };
      const held = await api.query('bank', 'cards.partnerHeld', { cardId: first.id, limit: 1 }, cardHeldSchema, { signal });
      return held.ok ? { ok: true as const, data: { held: held.data } } : held;
    },
    `payYourself:card:${userId}`,
    READ_EVERY_MS,
  );
  const venueState = !record
    ? t('stateNotYet')
    : record.status === 'done'
      ? t('stateDone')
      : record.status === 'failed'
        ? t('stateFailed')
        : t('statePending');
  const partnerState = !credit
    ? t('stateNotYet')
    : credit.status === 'available'
      ? t('stateAvailable')
      : credit.held
        ? t('stateHeld')
        : t('statePending');
  const held = card.data?.held ?? null;
  const available = held?.figures?.available ?? null;
  return (
    <div data-testid="pay-tracker" className="form-stack">
      <h3>{t('trackerTitle')}</h3>
      <dl>
        <dt>{t('trackVenue')}</dt>
        <dd data-track="venue">
          <span data-track-state>{venueState}</span> {displayAmount(move.amount)} USDC{' '}
          {seen.pending ? (
            <span data-track-pending-at>
              {t('statePending')} <At iso={seen.pending} />
            </span>
          ) : null}{' '}
          {seen.done ? (
            <span data-track-done-at>
              {t('stateDone')} <At iso={seen.done} />
            </span>
          ) : null}
        </dd>
        <dt>{t('trackPartner')}</dt>
        <dd data-track="partner">
          <span data-track-state>{partnerState}</span>{' '}
          {credit ? (
            <>
              {displayAmount(credit.amount)} USDC{' '}
              <span data-track-pending-at>
                {t('statePending')} <At iso={credit.seenAt} />
              </span>{' '}
              {credit.availableAt ? (
                <span data-track-available-at>
                  {t('stateAvailable')} <At iso={credit.availableAt} />
                </span>
              ) : (
                <span className="muted">{t('partnerConfirmations', { n: String(credit.confirmations), m: String(credit.required) })}</span>
              )}
            </>
          ) : null}
        </dd>
        <dt>{t('trackCard')}</dt>
        <dd data-track="card">
          {card.data === null && !card.failure
            ? t('partReading')
            : held && held.figures
              ? t('cardAvailable', { amount: available !== null ? displayAmount(available) : t('cardNotKnown'), partner })
              : t('cardNone')}
        </dd>
      </dl>
    </div>
  );
}

function Rule({ summary, t, onSaved }: { summary: PayYourselfSummary; t: T; onSaved: () => void }) {
  const { api } = useSession();
  const [weekday, setWeekday] = useState<(typeof WEEKDAYS)[number]>(summary.rule?.weekday ?? 'friday');
  const [cap, setCap] = useState(summary.rule?.cap ?? '');
  const [note, setNote] = useState<string | null>(null);
  const dayId = useId();
  async function save() {
    const saved = await api.mutate('bank', 'payYourself.setRule', { weekday, cap: cap.trim() }, ruleSchema);
    setNote(saved.ok ? t('ruleSaved') : `${saved.message}${saved.code ? ` (${saved.code})` : ''}`);
    if (saved.ok) onSaved();
  }
  const rule = summary.rule;
  return (
    <div data-testid="pay-rule" className="form-stack">
      <h3>{t('ruleTitle')}</h3>
      <p data-rule-now>
        {rule
          ? t('ruleNow', { weekday: t(rule.weekday), cap: displayAmount(rule.cap), next: new Date(rule.nextRunAt).toUTCString() })
          : t('ruleNone')}
      </p>
      <div>
        <label htmlFor={dayId}>{t('ruleWeekday')}</label>{' '}
        <select id={dayId} value={weekday} onChange={(e) => setWeekday(e.target.value as (typeof WEEKDAYS)[number])}>
          {WEEKDAYS.map((d) => (
            <option key={d} value={d}>
              {t(d)}
            </option>
          ))}
        </select>
      </div>
      <Field label={t('ruleCap')} inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value)} />
      <Button onClick={() => void save()}>{t('ruleSave')}</Button>
      {note ? <p role="status">{note}</p> : null}
    </div>
  );
}
