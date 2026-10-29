import { useEffect, useRef, useState } from 'react';
import { myRewardsSchema } from '@intafaced/contracts/campaigns-catalogue';
import type { ApiResult } from '../../shared/api';
import { Button, Failure, Loading } from '../../shared/ui';
import { useResource } from '../../shared/resource';
import { displayAmount } from '../../shared/money';
import { usePreferences } from '../../shared/preferences';
import { useSession } from '../session/session';
import { date, useBankRead } from './components';
import type { Destination } from './contracts';
import { DepthPanel, DisabledAction, Fact } from './DepthParts';
import { useHoldings } from './holdings';
import { INTERNAL_RAIL, useWithdrawDestination, type DestinationRead } from './withdraw-destination';
import { SAVED_STATE_WORDS, checkAddress, checkAmount, coolingOf, shortenAddress, shownState } from './withdraw-model';
import {
  above,
  createWithdrawSend,
  quoteCovers,
  rulesProblem,
  sendRefusalKey,
  type WithdrawLimits,
  type WithdrawNetworkRules,
  type WithdrawQuote,
  type WithdrawSend,
} from './withdraw-send';
import { withdrawalSchema, type WithdrawalRecord } from './withdrawal-reads';
import { withdrawalCopy } from './withdrawal-copy';
import { WithdrawStepUp } from './WithdrawStepUp';
import './bank-depth.css';

const AMOUNT_ERROR = { invalid: 'fAmountInvalid', zero: 'fAmountZero', tooMuch: 'fAmountTooMuch', unknown: 'fBalanceUnknown' } as const;
// A person's ask has no business id before svc-pay records it, so its client reference is minted once per ask here and kept
// (in this tab too) while its answer is unknown; svc-pay replays the same reference instead of opening a second withdrawal.
const newRef = () => crypto.randomUUID();

type Copy = ReturnType<typeof withdrawalCopy.useCopy>['t'];
type Failed = Extract<ApiResult<unknown>, { ok: false }>;
/** The answer to a send to an outside wallet: recorded, refused by name with nothing held, or not known. */
type Outcome =
  { kind: 'sent'; record: WithdrawalRecord } | { kind: 'refused'; failure: Failed; asset: string } | { kind: 'unknown'; failure: Failed };

/**
 * Whether a failed send is a definite "no" from svc-pay. A lost answer, a gateway error or an answer that could not be
 * read may follow a withdrawal svc-pay recorded, so it is never shown as "nothing is held".
 */
const definite = (failure: Failed) =>
  (failure.status === 503 && GUARD_REFUSAL.test(failure.code ?? '')) ||
  (failure.status !== undefined &&
    failure.status < 500 &&
    failure.reason !== 'uncertain' &&
    failure.reason !== 'invalid_response' &&
    !MAY_BE_HELD.has(failure.code ?? ''));

/**
 * svc-pay's guards answer inside the claim's own transaction, before its row is written, so a guard refusal rolls the claim
 * back: nothing is claimed or held. One that could not decide (no screening list, say) is svc-pay's 503 with its own
 * `pay.guard_*` code, still a definite no; a 503 without that code may come from anywhere and stays uncertain.
 */
const GUARD_REFUSAL = /^pay\.guard_/;

/**
 * svc-pay answers that leave a claimed withdrawal behind, possibly with its hold: an outcome it does not know yet, or a fee the
 * ledger refused after the hold was placed. Never shown as "nothing is held"; the reference is kept so it is finished, not resent.
 */
const MAY_BE_HELD = new Set(['pay.rail_outcome_unknown', 'pay.ledger_outcome_unknown', 'pay.withdrawal_fee_unbound']);

/** svc-pay's quote refusals at send: it checks the quote only when no withdrawal exists under the reference yet. */
const NO_CLAIM_UNDER_REFERENCE = /^withdrawal_quote\./;

/** A saved wallet can take money once the bank calls it active and its cooling-off has ended. */
const ready = (row: Destination, now: number) => shownState(row.state ?? 'pending', coolingOf(row, now).state) === 'active';

/** A send inside INTAFACED being confirmed: the terms asked under its client reference, and whether an ask went unanswered. */
interface OpenSend {
  assetId: string;
  amount: string;
  ref: string;
  clientRef: string;
  unanswered: boolean;
}

const openKey = (userId: string) => `intafaced:withdraw-inside:${userId}`;

/** A send whose answer was lost, kept in this tab so a reload finishes it under the same reference instead of starting another. */
function storedOpen(userId: string | null): OpenSend | null {
  if (!userId) return null;
  try {
    const raw = sessionStorage.getItem(openKey(userId));
    const kept = raw ? (JSON.parse(raw) as Partial<OpenSend>) : null;
    if (!kept || [kept.assetId, kept.amount, kept.ref, kept.clientRef].some((v) => typeof v !== 'string' || v === '')) return null;
    return { assetId: kept.assetId!, amount: kept.amount!, ref: kept.ref!, clientRef: kept.clientRef!, unanswered: true };
  } catch {
    return null;
  }
}

function keepOpen(userId: string | null, open: OpenSend | null) {
  if (!userId) return;
  try {
    if (open?.unanswered) sessionStorage.setItem(openKey(userId), JSON.stringify(open));
    else sessionStorage.removeItem(openKey(userId));
  } catch {
    // Storage blocked: the reference still lives in this page until it closes.
  }
}

/** A send to an outside wallet whose answer was lost: its terms and client reference, kept until svc-pay answers for it. */
interface OpenOut {
  assetId: string;
  networkId: string;
  destinationId: string;
  amount: string;
  clientRef: string;
  /** The quote the send was made under: svc-pay keeps it with the withdrawal, so finishing it names the same one. */
  quoteRef: string;
  /** What that quote takes from the balance, so finishing the send says what it takes, not what a newer quote shows. */
  totalDebit?: string;
}

const outKey = (userId: string) => `intafaced:withdraw-out:${userId}`;
const outTerms = (send: Omit<OpenOut, 'clientRef' | 'quoteRef'>) =>
  JSON.stringify([send.assetId, send.networkId, send.destinationId, send.amount]);

function storedOut(userId: string | null): OpenOut | null {
  if (!userId) return null;
  try {
    const raw = sessionStorage.getItem(outKey(userId));
    const kept = raw ? (JSON.parse(raw) as Partial<OpenOut>) : null;
    const fields = [kept?.assetId, kept?.networkId, kept?.destinationId, kept?.amount, kept?.clientRef, kept?.quoteRef];
    if (!kept || fields.some((v) => typeof v !== 'string' || v === '')) return null;
    return {
      assetId: kept.assetId!,
      networkId: kept.networkId!,
      destinationId: kept.destinationId!,
      amount: kept.amount!,
      clientRef: kept.clientRef!,
      quoteRef: kept.quoteRef!,
      ...(typeof kept.totalDebit === 'string' && kept.totalDebit !== '' ? { totalDebit: kept.totalDebit } : {}),
    };
  } catch {
    return null;
  }
}

function keepOut(userId: string | null, open: OpenOut | null) {
  if (!userId) return;
  try {
    if (open) sessionStorage.setItem(outKey(userId), JSON.stringify(open));
    else sessionStorage.removeItem(outKey(userId));
  } catch {
    // Storage blocked: the reference still lives in this page until it closes.
  }
}

/** What the form says about where the typed address leads, or nothing for an address outside INTAFACED. */
function DestinationNote({ place, t }: { place: DestinationRead; t: Copy }) {
  if (place.state === 'idle' || (place.state === 'known' && place.kind === 'external')) return null;
  const kind = place.state === 'known' ? place.kind : place.state;
  const words =
    place.state === 'checking'
      ? t('dChecking')
      : place.state === 'failed'
        ? t('dFailed')
        : place.kind === 'internal'
          ? t('dInternal')
          : place.kind === 'self'
            ? t('dSelf')
            : place.kind === 'unavailable'
              ? t(place.reason === 'expired' ? 'dExpired' : 'dUnavailable')
              : null;
  const refused = place.state === 'known' && (place.kind === 'self' || place.kind === 'unavailable');
  return (
    <div
      className={refused ? 'failure' : 'bd-address'}
      role={refused ? 'alert' : 'status'}
      data-testid="withdraw-destination"
      data-kind={kind}
    >
      {place.state === 'known' && place.kind === 'internal' && <strong>{t('dInternalTitle')}</strong>}
      <p>{words}</p>
    </div>
  );
}

/**
 * The whole "send money out" form, shown first on `/uc/withdraw` (J-wallet-05, J-wallet-07). The person picks an asset they
 * hold and an amount, judged against their real available balance and the limit line svc-pay reads for their account level.
 *
 * - To an outside wallet: a network the asset list opens for the asset, and one of their saved addresses on it once its
 *   cooling-off has ended. "Get the fee" stores a quote and shows its fee, what arrives, what leaves the balance and when it
 *   expires. Confirming asks for a fresh step-up and sends once, under a reference fixed when the confirmation opened and
 *   kept while an answer is unknown. A refusal says why in plain words and that nothing is held, with the balance read again.
 * - To another INTAFACED account's address (W-withdraw-14), typed in: it settles inside at once with no fee. Its client
 *   reference and terms are kept while the answer is unknown, in this tab too, so a reload or confirming again finishes the
 *   same withdrawal and never sends twice; the fields stay locked until svc-pay answers.
 *
 * Nothing here invents a fee, a limit, a network or a saved address: a blank one refuses in words.
 */
export function WithdrawForm() {
  const { t } = withdrawalCopy.useCopy();
  const { hideBalances } = usePreferences();
  const { api, userId } = useSession();
  const held = useHoldings();
  const networks = useBankRead('ramps.destinations.networks', undefined);
  const book = useBankRead('ramps.destinations.list', undefined);
  const assets = held.resource.status === 'ready' ? held.resource.data.assets : [];
  // The send inside INTAFACED being confirmed: its terms and its client reference. Kept until svc-pay gives a final answer,
  // so a send whose answer was lost is finished by confirming again with the same reference and the same terms.
  const [open, setOpenState] = useState<OpenSend | null>(() => storedOpen(userId));
  const setOpen = (next: OpenSend | null) => {
    setOpenState(next);
    keepOpen(userId, next);
  };
  // A send to an outside wallet whose answer was lost, kept the same way: its terms stay locked until svc-pay answers for it.
  const [openOut, setOpenOutState] = useState<OpenOut | null>(() => (open ? null : storedOut(userId)));
  const setOpenOut = (next: OpenOut | null) => {
    setOpenOutState(next);
    keepOut(userId, next);
  };
  const [picked, setPicked] = useState(() => open?.assetId ?? openOut?.assetId ?? '');
  const [pickedNetwork, setPickedNetwork] = useState(() => openOut?.networkId ?? '');
  const [savedId, setSavedId] = useState(() => openOut?.destinationId ?? '');
  const [amount, setAmount] = useState(() => open?.amount ?? openOut?.amount ?? '');
  const [address, setAddress] = useState(() => open?.ref ?? '');
  const [quote, setQuote] = useState<
    { status: 'idle' } | { status: 'busy' } | { status: 'ready'; quote: WithdrawQuote } | { status: 'failed'; failure: Failed }
  >({ status: 'idle' });
  const [confirmingInside, setConfirmingInside] = useState(false);
  const [confirmingOut, setConfirmingOut] = useState<{ send: WithdrawSend; destinationId: string; totalDebit: string; why: string } | null>(
    null,
  );
  const [sentInside, setSentInside] = useState<WithdrawalRecord | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  // Each answered send counts once, so the limit line is read again after every one.
  const [answered, setAnswered] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const quoting = useRef(false);
  // One reference per send to an outside wallet: kept while the terms stay the same and the last answer was not definite,
  // so a retry after a lost answer resumes that withdrawal in svc-pay instead of opening a second one.
  const sendRef = useRef<{ terms: string; ref: string } | null>(openOut ? { terms: outTerms(openOut), ref: openOut.clientRef } : null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  // The form looks at the clock again the moment the quote in hand expires, so confirm goes off on time.
  useEffect(() => {
    if (quote.status !== 'ready') return;
    const wait = Date.parse(quote.quote.expiresAt) - Date.now();
    if (!(wait > 0)) return;
    const timer = setTimeout(() => setNow(Date.now()), wait + 50);
    return () => clearTimeout(timer);
  }, [quote]);
  // And the moment the next saved address's cooling-off ends, so it can be chosen without a reload.
  const nextCoolingEnd =
    book.resource.status === 'ready'
      ? Math.min(...book.resource.data.map((row) => Date.parse(row.coolingOffEndsAt ?? '')).filter((end) => end > now))
      : Infinity;
  useEffect(() => {
    if (!Number.isFinite(nextCoolingEnd)) return;
    // setTimeout holds at most about 24.8 days; a later end is looked at again then.
    const timer = setTimeout(() => setNow(Date.now()), Math.min(nextCoolingEnd - Date.now() + 50, 2 ** 31 - 1));
    return () => clearTimeout(timer);
  }, [nextCoolingEnd]);

  const asset = assets.some((entry) => entry.assetId === picked) ? picked : (assets[0]?.assetId ?? '');
  const available = assets.find((entry) => entry.assetId === asset)?.available ?? null;
  const catalogue = networks.resource.status === 'ready' ? networks.resource.data.find((entry) => entry.assetId === asset) : undefined;
  const offered = catalogue?.networks ?? [];
  const network = offered.some((entry) => entry.networkId === pickedNetwork)
    ? pickedNetwork
    : (offered.find((entry) => entry.networkId === catalogue?.defaultNetworkId)?.networkId ?? offered[0]?.networkId ?? '');
  const networkLabel = offered.find((entry) => entry.networkId === network)?.label ?? '';
  const saved =
    book.resource.status === 'ready'
      ? book.resource.data.filter(
          (row) => row.kind === 'crypto' && row.assetId === asset && row.network === network && row.state !== 'archived',
        )
      : [];
  const chosen = saved.find((row) => row.destinationId === savedId && ready(row, now)) ?? null;
  const limits = useResource(
    async (signal): Promise<ApiResult<WithdrawLimits>> =>
      asset ? createWithdrawSend(api).limits(asset, signal) : { ok: false, reason: 'not_supported', message: '' },
    `withdraw-limits:${asset}:${answered}`,
  );
  const limit = limits.resource.status === 'ready' ? limits.resource.data : null;
  // The owner's rules for this asset on this network (W-withdraw-02): read before any fee, so an amount they refuse is never quoted.
  const networkRules = useResource(
    async (signal): Promise<ApiResult<WithdrawNetworkRules>> =>
      asset && network ? createWithdrawSend(api).networkRules(asset, network, signal) : { ok: false, reason: 'not_supported', message: '' },
    `withdraw-network-rules:${asset}:${network}`,
  );
  const rules = networkRules.resource.status === 'ready' ? networkRules.resource.data : null;

  const check = checkAmount(amount, available);
  const overLimit = check === 'ok' && limit !== null && above(amount, limit.maxNow);
  const outsideRules = check === 'ok' && rules !== null ? rulesProblem(amount, rules) : null;
  // While balances load there is nothing to say yet; once they fail or come back empty the amount cannot be judged.
  const problem =
    check in AMOUNT_ERROR && !(check === 'unknown' && held.resource.status === 'loading')
      ? t(AMOUNT_ERROR[check as keyof typeof AMOUNT_ERROR])
      : overLimit
        ? t('fOverLimit', { amount: displayAmount(limit?.maxNow), asset })
        : outsideRules && rules
          ? t(outsideRules, {
              amount: displayAmount(outsideRules === 'nrBelow' ? rules.minimum : outsideRules === 'nrAbove' ? rules.maximum : rules.step),
              asset,
            })
          : undefined;
  const shown = (value: string) => (hideBalances ? '••••' : displayAmount(value));
  const words = (failure: Failed) => {
    const key = sendRefusalKey(failure.code);
    return key ? t(key) : failure.message;
  };
  const notChosen = t('rNotChosen');
  /** The balance after a refusal, as the ledger reads it again; a read that has no line for the asset says so, never 0. */
  const refusedBalance = (refused: string) => {
    if (held.resource.status !== 'ready') return null;
    const line = held.resource.data.assets.find((entry) => entry.assetId === refused);
    return line ? t('sBalance', { amount: shown(line.available), asset: refused }) : t('fBalanceUnknown');
  };

  // Where the typed address leads. Another INTAFACED account's address takes the send inside; any other address is only
  // checked here, because money goes out only to a saved address.
  const place = useWithdrawDestination(address);
  const inside = place.state === 'known' && place.kind === 'internal';
  // An unanswered send inside locks the form on its own terms: only finishing it is offered, whatever the address reads as now.
  // An unanswered send out locks what it sends (asset, network, address, amount) until svc-pay answers for its reference.
  const resuming = open?.unanswered === true;
  const resumingOut = openOut !== null;
  const locked = resuming || resumingOut;
  const insideNow = inside || resuming;
  const canSendInside = resuming || (inside && check === 'ok' && !overLimit && Boolean(asset));
  const typedCheck = address.trim() ? checkAddress(address.trim()) : 'empty';
  const typedSaved =
    typedCheck === 'ok' && !insideNow ? saved.find((row) => row.ref.toLowerCase() === address.trim().toLowerCase()) : undefined;
  const typedSavedLabel = typedSaved ? (typedSaved.label ?? shortenAddress(typedSaved.ref)) : '';
  const typedSavedWords = !typedSaved
    ? ''
    : typedSaved.destinationId === chosen?.destinationId
      ? t('fNewSaved', { label: typedSavedLabel })
      : ready(typedSaved, now)
        ? t('fNewSavedPick', { label: typedSavedLabel })
        : t('fNewSavedWait', {
            label: typedSavedLabel,
            state: t(SAVED_STATE_WORDS[shownState(typedSaved.state ?? 'pending', coolingOf(typedSaved, now).state)]),
          });

  const terms = { assetId: asset, networkId: network, amount };
  const current = quote.status === 'ready' && quoteCovers(quote.quote, terms, now) ? quote.quote : null;
  const debitTooMuch = current !== null && available !== null && above(current.totalDebit, available);
  // A send out needs the network's rules, an amount inside them, and a network that takes no tag (a send carries none).
  const rulesAllow = rules !== null && rules.tag === 'none' && outsideRules === null;
  const canQuote = !insideNow && check === 'ok' && !overLimit && rulesAllow && Boolean(asset && network) && quote.status !== 'busy';
  const canSendOut =
    !insideNow &&
    chosen !== null &&
    current !== null &&
    !debitTooMuch &&
    check === 'ok' &&
    !overLimit &&
    // A send whose answer was lost is finished on its own terms, so svc-pay answers for its reference whatever the rules read now.
    (rulesAllow || resumingOut) &&
    limit !== null;

  /** Any change to what would be sent drops the quote in hand, so a fee is never shown for other terms. */
  const change = (apply: () => void) => {
    apply();
    setQuote({ status: 'idle' });
    setOutcome(null);
    setRefusal(null);
  };

  function startInside() {
    if (!canSendInside) return;
    setRefusal(null);
    setSentInside(null);
    if (!resuming)
      setOpen({
        assetId: asset,
        amount: amount.trim(),
        ref: address.trim(),
        clientRef: `internal-${newRef()}`,
        unanswered: false,
      });
    setConfirmingInside(true);
  }

  async function sendInside(token: string, send: OpenSend) {
    // Kept in the tab before the ask leaves, so a reload or a crash while it is in flight finishes it, never starts another.
    keepOpen(userId, { ...send, unanswered: true });
    const answer = await api.mutate(
      'pay',
      'withdrawal.create',
      {
        assetId: send.assetId,
        amount: send.amount,
        railId: INTERNAL_RAIL,
        destination: { kind: 'crypto', ref: send.ref },
        clientRef: send.clientRef,
      },
      withdrawalSchema,
      { bearer: token },
    );
    if (answer.ok) {
      setSentInside(answer.data);
      setOpen(null);
      held.reload();
      return answer;
    }
    // svc-pay's own code, from the error data or the front of its message (a guard refusal carries it there).
    const payCode = [answer.code, answer.message].map((v) => /^pay\.[a-z0-9_.]+/.exec(v ?? '')?.[0]).find(Boolean);
    const said =
      payCode === 'pay.withdrawal_self_send'
        ? t('dSelf')
        : payCode === 'pay.guard_screening_unavailable'
          ? `${t('sScreening')} ${t('sReference', { code: payCode })}`
          : payCode
            ? `${t('sRefused')} ${t('sReference', { code: payCode })}`
            : null;
    // A named refusal of a first ask is final: nothing was claimed, the dialog closes and the form says why. A new send is a
    // new one. After an ask whose answer was lost, the earlier send may still have landed, so the reference is kept, unless
    // svc-bank itself answered that the transfer was refused (it checks its book first, so nothing moved).
    const final = said && payCode !== 'pay.rail_outcome_unknown' && (!send.unanswered || payCode === 'pay.internal_settlement_refused');
    if (final) {
      setRefusal(said);
      setOpen(null);
      return { ok: true as const, data: null };
    }
    // No answer, or svc-pay does not know yet: the send may have happened. Keep the reference so confirming again finishes it.
    setOpen({ ...send, unanswered: true });
    return { ...answer, message: said && payCode !== 'pay.rail_outcome_unknown' ? `${said} ${t('sUnknown')}` : t('sUnknown') };
  }

  /** Opens the confirmation for exactly these terms, unless the quote expired since the page last looked. */
  function reviewOut() {
    if (!chosen || !current) return;
    if (!quoteCovers(current, terms, Date.now())) {
      setNow(Date.now());
      return;
    }
    const key = outTerms({ assetId: asset, networkId: network, destinationId: chosen.destinationId, amount: amount.trim() });
    if (sendRef.current?.terms !== key) sendRef.current = { terms: key, ref: `withdraw:${newRef()}` };
    // A send whose answer was lost is finished under the quote it was made with; svc-pay keeps that one, and its fee, with it.
    // When that is not the quote on the page, the confirmation says what the earlier one takes, not what the page shows.
    const resumed = openOut?.clientRef === sendRef.current.ref ? openOut : null;
    const earlier = resumed !== null && resumed.quoteRef !== current.quoteRef;
    setConfirmingOut({
      send: {
        assetId: asset,
        networkId: network,
        address: chosen.ref,
        amount: amount.trim(),
        clientRef: sendRef.current.ref,
        quoteRef: resumed ? resumed.quoteRef : current.quoteRef,
      },
      destinationId: chosen.destinationId,
      totalDebit: resumed ? (resumed.totalDebit ?? '') : current.totalDebit,
      why: !earlier
        ? t('fConfirmWhy')
        : resumed.totalDebit
          ? t('fConfirmResume', { total: shown(resumed.totalDebit), asset })
          : t('fConfirmResumeUnknown'),
    });
  }

  async function getQuote() {
    if (!canQuote || quoting.current) return;
    quoting.current = true;
    setQuote({ status: 'busy' });
    const answer = await createWithdrawSend(api).quote({ quoteRef: `withdraw-quote:${newRef()}`, ...terms, amount: amount.trim() });
    quoting.current = false;
    if (!alive.current) return;
    setNow(Date.now());
    setQuote(answer.ok ? { status: 'ready', quote: answer.data } : { status: 'failed', failure: answer });
  }

  async function sendOut(input: WithdrawSend, destinationId: string, totalDebit: string, token: string): Promise<ApiResult<unknown>> {
    // After an ask whose answer was lost, the earlier send may have been recorded, so no refusal of a retry is final: the
    // reference is kept until svc-pay records that withdrawal.
    const wasUnanswered = openOut !== null;
    const open: OpenOut = {
      assetId: input.assetId,
      networkId: input.networkId,
      destinationId,
      amount: input.amount,
      clientRef: input.clientRef,
      quoteRef: input.quoteRef,
      ...(totalDebit ? { totalDebit } : {}),
    };
    // Kept in the tab before the ask leaves, so a reload or a crash while it is in flight finishes it, never starts another.
    keepOut(userId, open);
    const answer = await createWithdrawSend(api).send(input, token);
    // A refusal of the quote proves svc-pay holds no withdrawal under this reference: it reads the quote only for a reference
    // it has never claimed. So even after a lost answer, such a refusal lets the reference go and the fee can be got afresh.
    const settled = answer.ok || (definite(answer) && (!wasUnanswered || NO_CLAIM_UNDER_REFERENCE.test(answer.code ?? '')));
    // Only a recorded withdrawal or a definite first refusal lets the reference go, even if the page has gone since.
    if (settled) keepOut(userId, null);
    if (!alive.current) return { ok: true, data: null };
    // The answer is shown on the page, with the balance and the limit line as svc-pay reads them now.
    held.reload();
    setAnswered((count) => count + 1);
    if (answer.ok) {
      sendRef.current = null;
      setOpenOut(null);
      setOutcome({ kind: 'sent', record: answer.data });
    } else if (settled) {
      sendRef.current = null;
      setOpenOut(null);
      setOutcome({ kind: 'refused', failure: answer, asset: input.assetId });
    } else {
      setOpenOut(open);
      setOutcome({ kind: 'unknown', failure: answer });
    }
    setQuote({ status: 'idle' });
    return { ok: true, data: null };
  }

  return (
    <div className="bd-stack" data-testid="withdraw-form">
      <DepthPanel title={t('formTitle')} lead={t('formLead')}>
        <div className="bd-address" role="status">
          <strong>{t('unavailable')}</strong>
          <p>{t('unavailableNote')}</p>
        </div>
        <form className="bd-stack" onSubmit={(event) => event.preventDefault()} noValidate>
          {held.resource.status === 'loading' ? (
            <Loading />
          ) : held.resource.status === 'failed' ? (
            <Failure result={held.resource.failure} retry={held.reload} />
          ) : (
            <label className="field">
              <span>{t('fAsset')}</span>
              <select
                value={asset}
                onChange={(event) => change(() => setPicked(event.target.value))}
                disabled={assets.length === 0 || locked}
              >
                {assets.length === 0 && <option value="">—</option>}
                {assets.map((entry) => (
                  <option key={entry.assetId} value={entry.assetId}>
                    {entry.assetId}
                  </option>
                ))}
              </select>
              <small>{assets.length === 0 ? t('fNoAssets') : t('fAssetHint')}</small>
            </label>
          )}
          {networks.resource.status === 'failed' ? (
            <Failure result={networks.resource.failure} retry={networks.reload} />
          ) : (
            <label className="field">
              <span>{t('fNetwork')}</span>
              <select
                value={network}
                onChange={(event) => change(() => setPickedNetwork(event.target.value))}
                disabled={offered.length === 0 || insideNow || resumingOut}
                aria-describedby="withdraw-network-why"
              >
                {offered.length === 0 && <option value="">{t('fNetworkNone')}</option>}
                {offered.map((entry) => (
                  <option key={entry.networkId} value={entry.networkId}>
                    {entry.label}
                  </option>
                ))}
              </select>
              <small id="withdraw-network-why">{t('fNetworkWhy')}</small>
            </label>
          )}
          {!insideNow && asset && network && (
            <div className="bd-stack" data-testid="withdraw-network-rules">
              <strong>{t('nrTitle')}</strong>
              {networkRules.resource.status === 'loading' ? (
                <Loading />
              ) : networkRules.resource.status === 'failed' ? (
                <p className="failure" role="status">
                  {words(networkRules.resource.failure)}
                </p>
              ) : (
                <>
                  <p>{t(networkRules.resource.data.tag === 'none' ? 'nrNoTag' : 'nrTagRequired')}</p>
                  <dl className="bd-facts">
                    {(
                      [
                        ['nrMinimum', networkRules.resource.data.minimum],
                        ['nrMaximum', networkRules.resource.data.maximum],
                        ['nrStep', networkRules.resource.data.step],
                      ] as const
                    ).map(([label, value]) => (
                      <Fact key={label} label={t(label)}>
                        <span className="numeric" lang="und">
                          {displayAmount(value)} {asset}
                        </span>
                      </Fact>
                    ))}
                  </dl>
                </>
              )}
            </div>
          )}
          <fieldset className="bd-stack">
            <legend className="bd-subhead">{t('fWhere')}</legend>
            {book.resource.status === 'failed' ? (
              <Failure result={book.resource.failure} retry={book.reload} />
            ) : (
              <label className="field">
                <span>{t('fSaved')}</span>
                <select
                  value={chosen?.destinationId ?? ''}
                  onChange={(event) => change(() => setSavedId(event.target.value))}
                  disabled={saved.length === 0 || insideNow || resumingOut}
                  aria-describedby="withdraw-saved-why"
                >
                  <option value="">{saved.length === 0 ? t('fSavedNone') : t('fSavedPick')}</option>
                  {saved.map((row) => {
                    const state = shownState(row.state ?? 'pending', coolingOf(row, now).state);
                    return (
                      <option key={row.destinationId} value={row.destinationId} disabled={state !== 'active'}>
                        {`${row.label ?? t('aNoLabel')} · ${shortenAddress(row.ref)} · ${t(SAVED_STATE_WORDS[state])}`}
                      </option>
                    );
                  })}
                </select>
                <small id="withdraw-saved-why">
                  {t('fSavedWhy')}{' '}
                  <a className="text-link" href="/uc/withdraw/address">
                    {t('fManage')}
                  </a>
                </small>
              </label>
            )}
            <label className="field">
              <span>{t('fNew')}</span>
              <input
                value={address}
                onChange={(event) => change(() => setAddress(event.target.value))}
                readOnly={locked}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                aria-invalid={typedCheck === 'invalid' && place.state === 'known' && place.kind === 'external'}
                aria-describedby="withdraw-new-hint"
              />
              <small
                id="withdraw-new-hint"
                className={typedCheck === 'invalid' && place.state === 'known' && place.kind === 'external' ? 'error-text' : ''}
              >
                {insideNow || place.state !== 'known' || place.kind !== 'external'
                  ? t('fNewHint')
                  : typedCheck === 'invalid'
                    ? t('fNewBad')
                    : typedSaved
                      ? typedSavedWords
                      : t('fNewNotSaved')}
              </small>
            </label>
            {typedSaved && !resumingOut && ready(typedSaved, now) && typedSaved.destinationId !== chosen?.destinationId && (
              <div>
                <button type="button" className="bd-link" onClick={() => change(() => setSavedId(typedSaved.destinationId))}>
                  {t('fSavedPick')}
                </button>
              </div>
            )}
            <DestinationNote place={place} t={t} />
          </fieldset>
          <label className="field">
            <span>{t('fAmount')}</span>
            <input
              inputMode="decimal"
              value={amount}
              onChange={(event) => change(() => setAmount(event.target.value))}
              readOnly={locked}
              autoComplete="off"
              aria-invalid={Boolean(problem)}
              aria-describedby="withdraw-amount-help"
            />
            <small id="withdraw-amount-help" className={problem ? 'error-text' : ''}>
              {problem ?? (available !== null && asset ? t('fAvailable', { amount: shown(available), asset }) : undefined)}
            </small>
          </label>
          {asset && <LockedRewards asset={asset} hidden={hideBalances} shown={shown} />}
          {available !== null && !hideBalances && !locked && (
            <div>
              <button type="button" className="bd-link" onClick={() => change(() => setAmount(available))}>
                {t('fMax')}
              </button>
            </div>
          )}
          <div className="bd-stack" data-testid="withdraw-limit">
            <strong>{t('lTitle')}</strong>
            {!asset ? null : limits.resource.status === 'loading' ? (
              <Loading />
            ) : limits.resource.status === 'failed' ? (
              <p className="failure" role="status">
                {words(limits.resource.failure)}
              </p>
            ) : (
              <p>
                {t('lLine', {
                  max: displayAmount(limits.resource.data.maxNow),
                  asset,
                  perTx: displayAmount(limits.resource.data.perTx),
                  left: displayAmount(limits.resource.data.remaining.rolling24h),
                  rolling: displayAmount(limits.resource.data.rolling24h),
                })}
              </p>
            )}
          </div>
          <div className="bd-stack" data-testid="withdraw-fee">
            <dl className="bd-facts">
              <Fact label={t('fFee')}>
                {insideNow ? (
                  t('rNoFee')
                ) : current ? (
                  <span className="numeric" lang="und">
                    {displayAmount(current.feeTotal)} {current.assetId}
                  </span>
                ) : (
                  t('fFeeValue')
                )}
              </Fact>
            </dl>
            {quote.status === 'failed' && (
              <p className="failure" role="status">
                {words(quote.failure)}
              </p>
            )}
            {quote.status === 'ready' && !current && <p role="status">{t('qExpired')}</p>}
            {!insideNow && (
              <div>
                <Button variant="secondary" disabled={!canQuote} onClick={() => void getQuote()}>
                  {quote.status === 'busy' ? t('qGetting') : t('qGet')}
                </Button>
              </div>
            )}
          </div>
        </form>
      </DepthPanel>
      <DepthPanel title={t('fReviewTitle')} lead={t('fReviewLead')}>
        <dl className="bd-facts" data-testid="withdraw-review">
          <Fact label={t('rSend')}>
            {check === 'ok' && asset ? (
              <span className="numeric" lang="und">
                {shown(amount.trim())} {asset}
              </span>
            ) : (
              notChosen
            )}
          </Fact>
          <Fact label={t('rNetwork')}>{insideNow ? t('rInside') : networkLabel || notChosen}</Fact>
          <Fact label={t('rTo')}>
            {insideNow && address.trim() ? (
              <span lang="und" data-withdrawal-private>
                {address.trim()}
              </span>
            ) : !insideNow && chosen ? (
              <span lang="und" data-withdrawal-private>
                {chosen.label ? `${chosen.label} · ` : ''}
                {chosen.ref}
              </span>
            ) : (
              notChosen
            )}
          </Fact>
          {insideNow ? (
            <Fact label={t('rFee')}>{t('rNoFee')}</Fact>
          ) : (
            <>
              <Fact label={t('qFee')}>{current ? `${displayAmount(current.feeTotal)} ${current.assetId}` : t('fFeeValue')}</Fact>
              {current && (
                <>
                  <Fact label={t('qNet')}>{`${shown(current.netAmount)} ${current.assetId}`}</Fact>
                  <Fact label={t('qTotal')}>{`${shown(current.totalDebit)} ${current.assetId}`}</Fact>
                </>
              )}
            </>
          )}
        </dl>
        {!insideNow && current && (
          <p className="money-caption">
            {current.feeMode === 'on_top' ? t('qOnTop') : t('qDeducted')} {t('qExpires', { time: date(current.expiresAt) })}
          </p>
        )}
        {!insideNow && debitTooMuch && (
          <p className="error-text" role="status">
            {t('fTotalTooMuch')}
          </p>
        )}
        {canSendInside ? (
          <div className="bd-stack">
            {resuming && (
              <p className="money-caption" role="status">
                {t('sUnknown')}
              </p>
            )}
            <div className="actions">
              <Button variant="primary" onClick={startInside}>
                {resuming ? t('sFinish') : t('sSend')}
              </Button>
            </div>
          </div>
        ) : canSendOut ? (
          <div className="bd-stack">
            {resumingOut && !outcome && (
              <p className="money-caption" role="status">
                {t('xResume')}
              </p>
            )}
            <div className="actions">
              <Button variant="primary" onClick={reviewOut}>
                {resumingOut ? t('sFinish') : t('xConfirm')}
              </Button>
            </div>
          </div>
        ) : (
          <DisabledAction variant="primary" label={inside ? t('sSend') : t('fReview')} reason={inside ? t('sNeedAmount') : t('fReason')} />
        )}
        {refusal && (
          <p className="failure" role="alert" data-testid="withdraw-refusal">
            {refusal}
          </p>
        )}
        {sentInside && (
          <div className="bd-address" role="status" data-testid="withdraw-outcome" data-status={sentInside.status}>
            <strong>{t('sDoneTitle')}</strong>
            <p>{t('sDone', { amount: shown(sentInside.amount), asset: sentInside.assetId })}</p>
            <a className="text-link" href={`/uc/withdraw?withdrawalId=${sentInside.id}`}>
              {t('sOpen')}
            </a>
          </div>
        )}
        {outcome && (
          <div
            className={outcome.kind === 'sent' ? 'bd-address' : 'failure'}
            role="status"
            data-testid="withdraw-outcome"
            data-status={outcome.kind === 'sent' ? outcome.record.status : outcome.kind}
          >
            {outcome.kind === 'sent' ? (
              <>
                <strong>{t('xDoneTitle')}</strong>
                <p>{t('xDone', { id: outcome.record.id })}</p>
                <a className="text-link" href={`/uc/withdraw?withdrawalId=${encodeURIComponent(outcome.record.id)}`}>
                  {t('sOpen')}
                </a>
              </>
            ) : outcome.kind === 'unknown' ? (
              <>
                <strong>{t('xUnknownTitle')}</strong>
                <p>{t('xUnknown')}</p>
              </>
            ) : (
              <>
                <strong>{t('sRefusedTitle')}</strong>
                <p>{words(outcome.failure)}</p>
                <p>
                  {t('sHeldNothing')} {refusedBalance(outcome.asset)}
                </p>
              </>
            )}
          </div>
        )}
      </DepthPanel>
      {confirmingInside && open && (
        <WithdrawStepUp
          why={t('sWhy', { amount: shown(open.amount), asset: open.assetId })}
          run={(token) => sendInside(token, open)}
          onDone={() => setConfirmingInside(false)}
          onCancel={() => setConfirmingInside(false)}
        />
      )}
      {confirmingOut && (
        <WithdrawStepUp
          why={confirmingOut.why}
          run={(token) => sendOut(confirmingOut.send, confirmingOut.destinationId, confirmingOut.totalDebit, token)}
          onDone={() => setConfirmingOut(null)}
          onCancel={() => setConfirmingOut(null)}
        />
      )}
    </div>
  );
}

/**
 * Campaign rewards locked or given as a bonus in this asset (CM-rewards-hub-02): never in the available balance, so they
 * cannot be sent out. Read from the campaigns service each visit; a failed read says so and shows no number, and hidden
 * balances hide this one too.
 */
function LockedRewards({ asset, hidden, shown }: { asset: string; hidden: boolean; shown: (value: string) => string }) {
  const { t } = withdrawalCopy.useCopy();
  const { api } = useSession();
  const mine = useResource((signal) => api.query('campaigns', 'rewards.mine', {}, myRewardsSchema, { signal }), 'withdraw-locked-rewards');
  const r = mine.resource;
  if (r.status === 'loading') return null;
  if (r.status === 'failed') {
    return (
      <p className="muted" data-testid="withdraw-locked-rewards" data-state="failed">
        {t('fLockedUnread')}
      </p>
    );
  }
  const line = r.data.totals.find((l) => l.status === 'locked' && l.asset === asset);
  if (!line) return null;
  return (
    <p
      className="muted"
      data-testid="withdraw-locked-rewards"
      data-state="ready"
      data-amount={hidden ? undefined : line.amount}
      data-asset={asset}
    >
      {t('fLocked', { amount: shown(line.amount), asset })}{' '}
      <a className="text-link" href="/uc/promotion">
        {t('fLockedLink')}
      </a>
    </p>
  );
}
