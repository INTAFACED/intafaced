import { useCallback, useRef, useState } from 'react';
import { Button, Dialog } from '../../../shared/ui';
import { parseAmount } from '../../../shared/money';
import { useWallet } from '../../../features/protocol/wallet/WalletProvider';
import { usePolled } from '../../../features/protocol/wallet/use-polled';
import {
  PROTECTION_KINDS,
  PROTECTION_SOURCES,
  draftId,
  keys,
  walletTypedData,
  type OrderIntent,
  type PreparedAnswer,
  type ProtectionKind,
  type ProtectionRequest,
  type ProtectionSource,
  type ProtectionView,
  type VenueMarket,
  type VenuePosition,
} from '../../../features/trade/venue-api';
import { VENUE_POLL_MS, outcomeText, useVenueApi, type ActionResult, type RunAction } from '../../../features/trade/venue/VenueKit';
import { venueCopy } from '../../../features/trade/venue/venue-copy';
import { venueProtectCopy } from './venue-protect-copy';
import { PROTECTION_FIELDS, canonical, closingSide, coverage, protectionClientId, whereItRests } from './venue-protect-logic';

type PT = ReturnType<typeof venueProtectCopy.useCopy>['t'];
type Field = 'quantity' | 'triggerPrice' | 'limitPrice' | 'trailingDistance';

/**
 * The person's wallet signs one action the door already prepared (a protection's trigger order, the agent permission),
 * and the door sends it to the venue: the same submit as every other venue action. An action the door holds as signed
 * already answers its recorded outcome and is never signed again.
 */
export function useSignPrepared(owner: string) {
  const venue = useVenueApi();
  const wallet = useWallet();
  return useCallback(
    async (answer: Pick<PreparedAnswer, 'actionKey' | 'prepared'> & Partial<Pick<PreparedAnswer, 'signed' | 'lastOutcome'>>) => {
      const p = answer.prepared;
      if (answer.signed) {
        const last = answer.lastOutcome;
        return last?.definite
          ? ({ kind: 'outcome', outcome: last, reused: true, clientOrderId: p.venueClientOrderId, nonce: p.nonce } as const)
          : ({ kind: 'unknown', clientOrderId: p.venueClientOrderId, nonce: p.nonce } as const);
      }
      const signed = await wallet.sign({ kind: 'typedData', typedData: walletTypedData(p.typedData) });
      if (signed.status === 'rejected') return { kind: 'rejected' } as const;
      if (signed.status !== 'signed') return { kind: 'wallet_failed', message: signed.status === 'failed' ? signed.message : '' } as const;
      const sent = await venue.submit(answer.actionKey, { digest: p.digest, signature: signed.signature, signedBy: owner });
      if (!sent.ok) {
        return sent.reason === 'uncertain'
          ? ({ kind: 'unknown', clientOrderId: p.venueClientOrderId, nonce: p.nonce } as const)
          : ({ kind: 'refused', code: sent.code, message: sent.message, beforeWallet: false } as const);
      }
      const outcome = sent.data.outcome;
      if (!outcome.definite) return { kind: 'unknown', clientOrderId: p.venueClientOrderId, nonce: p.nonce } as const;
      return { kind: 'outcome', outcome, reused: false, clientOrderId: p.venueClientOrderId, nonce: p.nonce } as const;
    },
    [venue, wallet, owner],
  );
}

/** A refusal in words with its code, for the alert under a control. */
export type Refusal = { message: string; code: string | null };

/** The refusal an action's result carries, or null when the venue accepted it. */
export function refusalOf(result: ActionResult, words: (r: ActionResult) => string): Refusal | null {
  if (result.kind === 'outcome')
    return result.outcome.accepted ? null : { message: result.outcome.refusal.detail, code: result.outcome.refusal.code };
  if (result.kind === 'refused') return { message: result.message, code: result.code ?? null };
  return { message: words(result), code: null };
}

function RefusalAlert({ refusal }: { refusal: Refusal | null }) {
  const { t } = venueProtectCopy.useCopy();
  if (!refusal) return null;
  return (
    <div className="failure" role="alert" data-testid="protection-refusal">
      <p>{refusal.message}</p>
      {refusal.code ? <p className="muted">{t('Code', { code: refusal.code })}</p> : null}
    </div>
  );
}

const kindWords = (t: PT, kind: ProtectionKind) => t(`kind_${kind}`);
const sourceWords = (t: PT, source: ProtectionSource) => t(`judged_${source}`);
const sideWords = (t: PT, side: 'long' | 'short') => t(`side_${side}`);

/**
 * Protect a position (J-derivatives-03): a take profit, a stop loss, a stop market, a stop limit or a trailing stop, each
 * judged on the price the person chooses. One the venue judges rests there as its own trigger order, signed in the
 * person's wallet; a trailing stop, or a stop on a price the venue does not judge triggers on, runs on our engine under
 * the agent permission the person approves once. Every protection on the symbol is listed as our record reads it now.
 */
export function ProtectDialog({
  market,
  position,
  side,
  owner,
  venueName,
  run,
  onClose,
}: {
  market: VenueMarket;
  /** The venue's position now; null once it is gone. */
  position: VenuePosition | null;
  /** The side of the position the dialog was opened on. */
  side: 'long' | 'short';
  owner: string;
  venueName: string;
  run: RunAction;
  onClose: () => void;
}) {
  const { t } = venueProtectCopy.useCopy();
  const v = venueCopy.useCopy().t;
  const venue = useVenueApi();
  const sign = useSignPrepared(owner);
  const [kind, setKind] = useState<ProtectionKind>('take_profit');
  const [source, setSource] = useState<ProtectionSource>('mark');
  const [fields, setFields] = useState<Record<Field, string>>({ quantity: '', triggerPrice: '', limitPrice: '', trailingDistance: '' });
  const [outcome, setOutcome] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const busy = useRef(false);
  const counter = useRef(0);
  const list = usePolled((signal) => venue.protections(owner, signal), `protections:${owner}`, VENUE_POLL_MS);
  const where = whereItRests(kind, source, market.triggerSources);
  const takes = PROTECTION_FIELDS[kind];
  const size = position?.size ?? null;
  const covers = size && fields.quantity.trim() ? coverage(fields.quantity, size) : null;
  const mine = (list.data?.protections ?? []).filter((p) => p.symbol === market.symbol);

  async function arm() {
    if (busy.current) return;
    setOutcome(null);
    setRefusal(null);
    const quantity = fields.quantity.trim();
    if (!positive(quantity)) return setRefusal({ message: t('Size invalid'), code: null });
    for (const f of takes)
      if (!positive(fields[f])) return setRefusal({ message: t('Field invalid', { field: t(fieldLabel(f)) }), code: null });
    const request: ProtectionRequest = {
      owner,
      symbol: market.symbol,
      kind,
      side: closingSide(side),
      quantity: canonical(quantity),
      triggerSource: source,
      clientOrderId: protectionClientId(Date.now(), counter.current++),
    };
    for (const f of takes) request[f] = canonical(fields[f]);
    busy.current = true;
    try {
      const created = await venue.createProtection(request);
      if (!created.ok) return setRefusal({ message: created.message, code: created.code ?? null });
      if (created.data.restsOn === 'engine') {
        setOutcome(t('Armed on engine'));
        return;
      }
      const answer = await sign(created.data);
      const refused = refusalOf(answer, (r) => outcomeText(v, r));
      if (refused) return setRefusal(refused);
      setOutcome(t('Armed on venue'));
    } finally {
      busy.current = false;
      list.reload();
    }
  }

  return (
    <Dialog title={t('Protect title', { symbol: market.symbol })} onClose={onClose}>
      <div className="form-stack" data-testid="protect-dialog">
        <div role="group" aria-label={t('Protection kind')}>
          {PROTECTION_KINDS.map((k) => (
            <Button key={k} variant={kind === k ? 'primary' : 'secondary'} aria-pressed={kind === k} onClick={() => setKind(k)}>
              {kindWords(t, k)}
            </Button>
          ))}
        </div>
        <div role="group" aria-label={t('Trigger source')}>
          {PROTECTION_SOURCES.map((s) => (
            <Button key={s} variant={source === s ? 'primary' : 'secondary'} aria-pressed={source === s} onClick={() => setSource(s)}>
              {t(`source_${s}`)}
            </Button>
          ))}
        </div>
        <p data-testid="protection-where" data-where={where}>
          {where === 'venue'
            ? t('where_venue')
            : where === 'engine'
              ? t('where_engine')
              : t('where_none', { venue: venueName, kind: kindWords(t, kind).toLowerCase(), source: sourceWords(t, source) })}
        </p>
        {where === 'engine' ? <AgentPermission owner={owner} /> : null}
        <NumberField label={t('Size to close')} value={fields.quantity} onChange={(x) => setFields({ ...fields, quantity: x })} />
        {takes.map((f) => (
          <NumberField key={f} label={t(fieldLabel(f))} value={fields[f]} onChange={(x) => setFields({ ...fields, [f]: x })} />
        ))}
        {covers ? (
          <p data-testid="protection-covers">
            {covers.whole ? t('Covers whole') : t('Covers part', { covers: covers.covers, of: covers.of, rest: covers.rest })}
          </p>
        ) : null}
        <Button onClick={() => void arm()}>{t('Arm protection')}</Button>
        <RefusalAlert refusal={refusal} />
        {outcome ? (
          <p role="status" data-testid="protection-outcome">
            {outcome}
          </p>
        ) : null}
        <section className="form-stack" aria-label={t('Listed title')} data-testid="protection-list">
          <h3 className="dk-tab-title">{t('Listed title')}</h3>
          {list.failure ? (
            <p className="failure">{list.failure.message}</p>
          ) : mine.length === 0 ? (
            list.data ? (
              <p className="muted">{t('Listed empty')}</p>
            ) : null
          ) : (
            <ul className="form-stack">
              {mine.map((p) => (
                <ProtectionItem key={p.id} protection={p} position={position} base={market.baseAsset} run={run} onDone={list.reload} />
              ))}
            </ul>
          )}
        </section>
      </div>
    </Dialog>
  );
}

const fieldLabel = (f: 'triggerPrice' | 'limitPrice' | 'trailingDistance') =>
  f === 'triggerPrice' ? 'Trigger price' : f === 'limitPrice' ? 'Limit price' : 'Trailing distance';

function positive(value: string): boolean {
  try {
    return parseAmount(value.trim()) > 0n;
  } catch {
    return false;
  }
}

function NumberField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input inputMode="decimal" aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

/** One protection as our record reads it now, with its trigger, its source, how much it covers and what became of it. */
function ProtectionItem({
  protection: p,
  position,
  base,
  run,
  onDone,
}: {
  protection: ProtectionView;
  position: VenuePosition | null;
  base: string;
  run: RunAction;
  onDone: () => void;
}) {
  const { t } = venueProtectCopy.useCopy();
  const v = venueCopy.useCopy().t;
  const venue = useVenueApi();
  const [cancelled, setCancelled] = useState<string | null>(null);
  const live = p.status === 'armed' || p.status === 'triggered';
  const covers = live && position ? coverage(p.quantity, position.size) : null;
  const sourceText = sourceWords(t, p.triggerSource);

  async function cancel() {
    if (p.restsOn === 'engine') {
      const answer = await venue.cancelProtection(p.id);
      setCancelled(answer.ok ? t('status_cancelled') : answer.message);
    } else if (p.actionKey) {
      const answer = await run({ kind: 'cancel_order', symbol: p.symbol, clientOrderKey: p.actionKey });
      setCancelled(outcomeText(v, answer));
    }
    onDone();
  }

  return (
    <li
      data-client-order-id={p.clientOrderId}
      data-kind={p.kind}
      data-rests-on={p.restsOn}
      data-status={p.status}
      {...(p.venueOrderId ? { 'data-venue-order-id': p.venueOrderId } : {})}
    >
      <p>
        <strong>{t('Item head', { kind: kindWords(t, p.kind), quantity: canonical(p.quantity), status: t(`status_${p.status}`) })}</strong>
      </p>
      <p>
        {p.kind === 'trailing_stop'
          ? t('Item trails', { distance: canonical(p.trailingDistance ?? ''), source: sourceText })
          : t('Item triggers', { price: canonical(p.triggerPrice ?? ''), source: sourceText })}
        {p.kind === 'stop_limit' && p.limitPrice ? `; ${t('Item limit', { price: canonical(p.limitPrice) })}` : ''}
        {p.kind === 'trailing_stop' && p.currentTrigger ? `; ${t('Item trails now', { price: canonical(p.currentTrigger) })}` : ''}
      </p>
      <p className="muted">{p.label}</p>
      {p.parentClientOrderId ? <p className="muted">{t('Item attached')}</p> : null}
      {covers ? (
        <p>{covers.whole ? t('Covers whole') : t('Covers part', { covers: covers.covers, of: covers.of, rest: covers.rest })}</p>
      ) : null}
      {p.status === 'failed' ? (
        <>
          <p className="failure">{t('Item failed', { failure: p.failure ?? '' })}</p>
          {position ? <p>{t('Item still open', { size: canonical(position.size), base, side: sideWords(t, position.side) })}</p> : null}
        </>
      ) : null}
      {p.status === 'cancelled' ? <p>{p.cancelReason === 'position_closed' ? t('Item cancelled closed') : t('Item cancelled')}</p> : null}
      {live && (p.restsOn === 'engine' || p.actionKey) ? (
        <Button variant="secondary" onClick={() => void cancel()}>
          {t('Cancel')}
        </Button>
      ) : null}
      {cancelled ? <p role="status">{t('Cancel outcome', { outcome: cancelled })}</p> : null}
    </li>
  );
}

/**
 * The agent permission an engine stop needs: the protection key the venue lists as approved on the person's account, or
 * the person's wallet approves it here, once. The key can trade only, never withdraw.
 */
function AgentPermission({ owner }: { owner: string }) {
  const { t } = venueProtectCopy.useCopy();
  const v = venueCopy.useCopy().t;
  const venue = useVenueApi();
  const sign = useSignPrepared(owner);
  const agent = usePolled((signal) => venue.protectionAgent(owner, signal), `protection-agent:${owner}`, VENUE_POLL_MS);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [accepted, setAccepted] = useState(false);
  const busy = useRef(false);

  async function approve() {
    if (busy.current) return;
    busy.current = true;
    setRefusal(null);
    try {
      const prepared = await venue.prepareProtectionAgent(owner);
      if (!prepared.ok) return setRefusal({ message: prepared.message, code: prepared.code ?? null });
      const answer = await sign(prepared.data);
      const refused = refusalOf(answer, (r) => outcomeText(v, r));
      if (refused) return setRefusal(refused);
      setAccepted(true);
    } finally {
      busy.current = false;
      agent.reload();
    }
  }

  const approved = agent.data?.approved === true || accepted;
  return (
    <section className="form-stack" aria-label={t('Agent permission')} data-testid="protection-agent">
      <h3 className="dk-tab-title">{t('Agent permission')}</h3>
      <p>{t('Agent note')}</p>
      {approved ? (
        <p role="status">{t('Agent approved')}</p>
      ) : agent.failure ? (
        <RefusalAlert refusal={{ message: agent.failure.message, code: agent.failure.code ?? null }} />
      ) : agent.data ? (
        <Button onClick={() => void approve()}>{t('Agent approve')}</Button>
      ) : (
        <p className="muted">{t('Agent checking')}</p>
      )}
      {!approved && agent.failure ? null : <RefusalAlert refusal={refusal} />}
    </section>
  );
}

/**
 * One-tap reverse (J-derivatives-03 #9): close the whole position with one reduce-only market order, then open the same
 * size the other way, under one reverse key (`<key>:close`, `<key>:open`). The venue takes one order per signature, so the
 * person signs the close, then the open. The key is held while the dialog is open: a second press is the same reverse.
 */
export function ReverseDialog({
  snapshot,
  live,
  market,
  owner,
  run,
  worstPrice,
  onDone,
  onClose,
}: {
  /** The position as it was when Reverse was pressed. */
  snapshot: VenuePosition;
  /** The venue's position now. */
  live: VenuePosition | null;
  market: VenueMarket;
  owner: string;
  run: RunAction;
  worstPrice: (position: VenuePosition) => string;
  onDone: () => void;
  onClose: () => void;
}) {
  const { t } = venueProtectCopy.useCopy();
  const v = venueCopy.useCopy().t;
  const reverseKey = useRef(keys.reverse(owner, draftId()));
  const pressed = useRef(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [opened, setOpened] = useState(false);
  const opposite = snapshot.side === 'long' ? 'short' : 'long';
  const size = canonical(snapshot.size);

  async function reverse() {
    if (pressed.current) return;
    pressed.current = true;
    setProblem(null);
    const side = closingSide(snapshot.side);
    const type = market.orderTypes.includes('market') ? 'market' : 'limit';
    const price = worstPrice(snapshot);
    const order = (part: 'close' | 'open', reduceOnly: boolean): OrderIntent => ({
      kind: 'place_order',
      symbol: snapshot.symbol,
      side,
      type,
      amount: size,
      price,
      timeInForce: 'IOC',
      reduceOnly,
      clientOrderKey: `${reverseKey.current}:${part}`,
      builderFee: null,
    });
    const closed = await run(order('close', true));
    // The open follows only a close the venue filled whole: a part close and a whole open would not be a reverse.
    const closedWhole = closed.kind === 'outcome' && closed.outcome.accepted && canonical(closed.outcome.order?.filled ?? '0') === size;
    if (!closedWhole) {
      pressed.current = closed.kind === 'outcome' || closed.kind === 'unknown';
      onDone();
      return setProblem(t('Reverse close failed', { outcome: outcomeText(v, closed) }));
    }
    const open = await run(order('open', false));
    onDone();
    if (!(open.kind === 'outcome' && open.outcome.accepted)) {
      pressed.current = open.kind === 'outcome' || open.kind === 'unknown';
      return setProblem(t('Reverse open failed', { outcome: outcomeText(v, open) }));
    }
    setOpened(true);
  }

  const now = opened && live && live.side === opposite ? live : null;
  return (
    <Dialog title={t('Reverse title', { symbol: snapshot.symbol })} onClose={onClose}>
      <div className="form-stack" data-testid="reverse-dialog">
        <p>{t('Reverse plan', { size, base: market.baseAsset, side: sideWords(t, snapshot.side), opposite: sideWords(t, opposite) })}</p>
        <p className="muted">{t('Reverse note')}</p>
        <Button onClick={() => void reverse()}>{t('Reverse sign')}</Button>
        {problem ? (
          <p className="failure" role="alert">
            {problem}
          </p>
        ) : null}
        {opened ? (
          <p role="status" data-testid="reverse-outcome">
            {now
              ? t('Reverse done', { size: canonical(now.size), base: market.baseAsset, side: sideWords(t, now.side) })
              : t('Reverse waiting')}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
