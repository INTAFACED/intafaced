import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Badge } from '@intafaced/ui';
import { Button, DataTable } from '../../../shared/ui';
import { usePreferences } from '../../../shared/preferences';
import { displayAmount } from '../../../shared/money';
import { useSession } from '../../session/session';
import { StepUpConfirm } from '../../money/StepUpConfirm';
import { WalletProvider, useWallet } from '../../protocol/wallet/WalletProvider';
import { usePolled } from '../../protocol/wallet/use-polled';
import {
  canonicalDecimal,
  draftId,
  keys,
  venueApi,
  walletTypedData,
  type AsOf,
  type MaybeKnown,
  preparedStep,
  type KeptSignature,
  type PreparedAnswer,
  type VenueApi,
  type VenueBalance,
  type VenueFill,
  type VenueIntent,
  type VenueOrder,
  type VenueOutcome,
  type VenueUp,
  type VenueWithdrawal,
} from '../venue-api';
import type { VenueMode } from '../use-venue-mode';
import { venueCopy } from './venue-copy';

type T = ReturnType<typeof venueCopy.useCopy>['t'];

/** How often the venue's record is read while a desk shows it. */
export const VENUE_POLL_MS = 2_000;

export function useVenueApi(): VenueApi {
  const { api } = useSession();
  return useMemo(() => venueApi(api), [api]);
}

/** The TEST label every venue figure carries while the venue is a TEST one. */
export function TestMark({ test }: { test: boolean }) {
  const { t } = venueCopy.useCopy();
  if (!test) return null;
  return (
    <Badge tone="warn" data-testid="venue-test" title={t('Venue TEST note')}>
      {t('TEST')}
    </Badge>
  );
}

/** A figure the venue may not publish: its value, or "not known", never 0. */
export function Known({ value, render = (v) => displayAmount(v) }: { value: MaybeKnown<string>; render?: (v: string) => ReactNode }) {
  const { t } = venueCopy.useCopy();
  return <>{value.known ? render(value.value) : t('Not known')}</>;
}

export function useAsOfText(): (iso: string) => string {
  const { timeZone } = usePreferences();
  const { t } = venueCopy.useCopy();
  return useCallback(
    (iso: string) => {
      let text: string;
      try {
        text = new Intl.DateTimeFormat('en-GB', { timeZone, dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(iso));
      } catch {
        text = iso;
      }
      return t('As of', { time: text });
    },
    [timeZone, t],
  );
}

export function AsOfLine({ asOf }: { asOf: string | null }) {
  const text = useAsOfText();
  if (!asOf) return null;
  return (
    <p className="muted" data-testid="venue-as-of">
      {text(asOf)}
    </p>
  );
}

/** A word from the copy for a venue enum value, or the value itself when the copy has none. */
export function word(t: T, prefix: string, value: string): string {
  const key = `${prefix}_${value}`;
  try {
    const out = (t as (k: string) => string)(key);
    return out && out !== key ? out : value;
  } catch {
    return value;
  }
}

/**
 * The venue frame: the person's wallet on the network the venue signs on (its status names it; the app's own chain
 * otherwise), the venue named with its TEST label and the trading-mode line. Every desk in venue mode sits inside it.
 */
export function VenueFrame({ mode, children }: { mode: Extract<VenueMode, { mode: 'on' }>; children: ReactNode }) {
  const status = mode.status;
  const chainId = status.available && status.chainId ? status.chainId : undefined;
  return (
    <WalletProvider chainId={chainId} scope="venue-desk">
      {children}
    </WalletProvider>
  );
}

export function VenueHeader({ status, title, feeLine }: { status: VenueUp; title: ReactNode; feeLine?: ReactNode }) {
  const { t } = venueCopy.useCopy();
  return (
    <header className="dk-panel" data-testid="venue-header" aria-label={t('Venue')}>
      <h1 className="dk-tab-title">
        {title} <TestMark test={status.test} />
      </h1>
      <p data-testid="venue-name">
        {t('Venue')}: {status.venue.displayName} <TestMark test={status.test} />
      </p>
      <p data-testid="venue-trading-mode">
        {t('Trading mode')}: {t('Trading mode line', { venue: status.venue.displayName })}
      </p>
      {feeLine ? <p data-testid="venue-fee-line">{feeLine}</p> : null}
    </header>
  );
}

/** Connect, the connected address and network, and the switch when the wallet is on another network. */
export function WalletBar() {
  const { t } = venueCopy.useCopy();
  const wallet = useWallet();
  return (
    <section className="dk-panel form-stack" aria-label={t('Your wallet')} data-testid="venue-wallet">
      <h2 className="dk-tab-title">{t('Your wallet')}</h2>
      {wallet.status === 'connected' && wallet.address ? (
        <>
          <dl className="protocol-facts">
            <div>
              <dt>{t('Connected address')}</dt>
              <dd className="numeric" data-testid="venue-wallet-address">
                {wallet.address.toLowerCase()}
              </dd>
            </div>
            <div>
              <dt>{t('Network')}</dt>
              <dd className="numeric">{wallet.chainId ?? ''}</dd>
            </div>
          </dl>
          {wallet.guard && !wallet.guard.ok ? (
            <p role="alert">
              {t('Wrong network', { observed: String(wallet.guard.observed ?? ''), configured: String(wallet.guard.configured) })}{' '}
              <Button onClick={() => void wallet.switchNetwork()}>{t('Switch network')}</Button>
            </p>
          ) : null}
          <Button variant="secondary" onClick={wallet.disconnect}>
            {t('Disconnect')}
          </Button>
        </>
      ) : wallet.wallets.length === 0 ? (
        <p className="muted">{t('No wallet')}</p>
      ) : (
        wallet.wallets.map((entry) => (
          <Button key={entry.info.uuid} disabled={wallet.status === 'connecting'} onClick={() => void wallet.connect(entry)}>
            {t('Connect wallet', { name: entry.info.name })}
          </Button>
        ))
      )}
      {wallet.problem ? (
        <p className="failure" role="alert">
          {wallet.problem}
        </p>
      ) : null}
    </section>
  );
}

/** The connected wallet's address, lowercase, which is the venue account's owner; null until connected on the right network. */
export function useOwner(): string | null {
  const wallet = useWallet();
  return wallet.status === 'connected' && wallet.address && (!wallet.guard || wallet.guard.ok) ? wallet.address.toLowerCase() : null;
}

/**
 * The business keys of this browser's own venue orders, by the venue's client order id: the one thing kept on the
 * client (sessionStorage, per owner), so a Cancel after a reload names the same order. Storage may be blocked; the desk
 * then keeps them for the page only.
 */
export function heldKeys(owner: string) {
  const name = `if.venue.keys.${owner}`;
  const memory = new Map<string, string>();
  const read = (): Record<string, string> => {
    try {
      const raw = sessionStorage.getItem(name);
      const parsed: unknown = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
    } catch {
      return Object.fromEntries(memory);
    }
  };
  return {
    get: (clientOrderId: string): string | undefined => read()[clientOrderId] ?? memory.get(clientOrderId),
    set(clientOrderId: string, key: string) {
      memory.set(clientOrderId, key);
      try {
        sessionStorage.setItem(name, JSON.stringify({ ...read(), [clientOrderId]: key }));
      } catch {
        /* blocked storage: the page keeps it */
      }
    },
  };
}

/** How long back the desk reads fills: the venue keeps them; a week covers any session. */
const FILLS_WINDOW_MS = 7 * 24 * 3_600_000;

/** The venue's record for one account, read every VENUE_POLL_MS: balances, open orders, fills, positions, our builder approval. */
export function useVenueAccount(owner: string | null, { positions = false }: { positions?: boolean } = {}) {
  const venue = useVenueApi();
  const since = useRef(new Date(Date.now() - FILLS_WINDOW_MS).toISOString()).current;
  const balances = usePolled((signal) => (owner ? venue.balances(owner, signal) : Promise.resolve(null)), `b:${owner}`, VENUE_POLL_MS);
  const openOrders = usePolled((signal) => (owner ? venue.openOrders(owner, signal) : Promise.resolve(null)), `o:${owner}`, VENUE_POLL_MS);
  const fills = usePolled((signal) => (owner ? venue.fills(owner, since, signal) : Promise.resolve(null)), `f:${owner}`, VENUE_POLL_MS);
  const held = usePolled(
    (signal) => (owner && positions ? venue.positions(owner, signal) : Promise.resolve(null)),
    `p:${owner}:${positions}`,
    VENUE_POLL_MS,
  );
  const approval = usePolled(
    (signal) => (owner ? venue.builderFeeApproval(owner, signal) : Promise.resolve(null)),
    `a:${owner}`,
    VENUE_POLL_MS,
  );
  const reload = useCallback(() => {
    balances.reload();
    openOrders.reload();
    fills.reload();
    held.reload();
    approval.reload();
  }, [balances, openOrders, fills, held, approval]);
  return { balances, openOrders, fills, positions: held, approval, reload };
}
export type VenueAccount = ReturnType<typeof useVenueAccount>;

/** What one signed action came to, in words the desk shows. */
export type ActionResult =
  | { kind: 'outcome'; outcome: Extract<VenueOutcome, { definite: true }>; reused: boolean; clientOrderId: string | null; nonce: string }
  | { kind: 'unknown'; clientOrderId: string | null; nonce: string | null }
  | { kind: 'refused'; code: string | undefined; message: string; beforeWallet: boolean }
  | { kind: 'rejected' }
  | { kind: 'waiting' }
  | { kind: 'wallet_failed'; message: string };

export type RunAction = (intent: VenueIntent, opts?: { actionKey?: string; stepUpApprovalId?: string | null }) => Promise<ActionResult>;

/** The business key the door stores an intent under (user-venue-door.ts `businessKey`). */
function keyOf(intent: VenueIntent, actionKey: string | undefined): string {
  if (intent.kind === 'place_order') return intent.clientOrderKey;
  if (intent.kind === 'withdraw') return intent.withdrawalKey;
  if (intent.kind === 'cancel_order') return actionKey ?? keys.cancel(intent.clientOrderKey);
  return actionKey ?? '';
}

/**
 * Prepare → the wallet signs → submit, once per business key. A second call with a key still in flight is the same call
 * (a double press asks for one signature); a key the door already holds comes back with its stored action, so a signed
 * one is never signed again: its first definite answer stands, and one with no definite answer is read back.
 */
export function useVenueActions(owner: string | null) {
  const venue = useVenueApi();
  const wallet = useWallet();
  const inFlight = useRef(new Map<string, Promise<ActionResult>>());
  // The signed bytes of this page's own actions, in memory only, so a submit refused before it was sent can be re-sent as
  // the same bytes. A key whose bytes may have reached the venue is never sent again.
  const signatures = useRef(new Map<string, KeptSignature>());
  const refusedBeforeSend = useRef(new Set<string>());
  // Keys this page prompted for, or told to wait for another prompt: the next press prompts here.
  const promptedHere = useRef(new Set<string>());

  const submitSigned = useCallback(
    async (key: string, prepared: PreparedAnswer['prepared'], signature: KeptSignature): Promise<ActionResult> => {
      const sent = await venue.submit(key, signature);
      if (!sent.ok) {
        if (sent.reason === 'uncertain') {
          refusedBeforeSend.current.delete(key);
          return { kind: 'unknown', clientOrderId: prepared.venueClientOrderId, nonce: prepared.nonce };
        }
        refusedBeforeSend.current.add(key);
        return { kind: 'refused', code: sent.code, message: sent.message, beforeWallet: false };
      }
      refusedBeforeSend.current.delete(key);
      const outcome = sent.data.outcome;
      if (!outcome.definite) return { kind: 'unknown', clientOrderId: prepared.venueClientOrderId, nonce: prepared.nonce };
      return { kind: 'outcome', outcome, reused: false, clientOrderId: prepared.venueClientOrderId, nonce: prepared.nonce };
    },
    [venue],
  );

  const run = useCallback<RunAction>(
    (intent, opts = {}) => {
      const key = keyOf(intent, opts.actionKey);
      const running = inFlight.current.get(key);
      if (running) return running;
      const job = (async (): Promise<ActionResult> => {
        if (!owner) return { kind: 'wallet_failed', message: '' };
        const prepared = await venue.prepare({ owner, intent, actionKey: opts.actionKey, stepUpApprovalId: opts.stepUpApprovalId });
        if (!prepared.ok) return { kind: 'refused', code: prepared.code, message: prepared.message, beforeWallet: true };
        const answer = prepared.data;
        const p = answer.prepared;
        const next = preparedStep(answer, {
          kept: signatures.current.get(answer.actionKey),
          refusedBeforeSend: refusedBeforeSend.current.has(answer.actionKey),
          promptedHere: promptedHere.current.has(answer.actionKey),
        });
        switch (next.step) {
          case 'outcome':
            return { kind: 'outcome', outcome: next.outcome, reused: true, clientOrderId: p.venueClientOrderId, nonce: p.nonce };
          case 'unknown':
            return { kind: 'unknown', clientOrderId: p.venueClientOrderId, nonce: p.nonce };
          case 'resend':
            return submitSigned(answer.actionKey, p, next.signature);
          case 'wait':
            promptedHere.current.add(answer.actionKey);
            return { kind: 'waiting' };
          case 'sign':
            break;
        }
        promptedHere.current.add(answer.actionKey);
        const signed = await wallet.sign({ kind: 'typedData', typedData: walletTypedData(p.typedData) });
        if (signed.status === 'rejected') return { kind: 'rejected' };
        if (signed.status !== 'signed') return { kind: 'wallet_failed', message: signed.status === 'failed' ? signed.message : '' };
        const signature = { digest: p.digest, signature: signed.signature, signedBy: owner };
        signatures.current.set(answer.actionKey, signature);
        return submitSigned(answer.actionKey, p, signature);
      })();
      inFlight.current.set(key, job);
      void job.finally(() => inFlight.current.delete(key));
      return job;
    },
    [owner, venue, wallet, submitSigned],
  );
  return { run };
}

/** The words for one action's result. An order's outcome names its status on the venue. */
export function outcomeText(t: T, result: ActionResult): string {
  switch (result.kind) {
    case 'rejected':
      return t('Outcome rejected wallet');
    case 'waiting':
      return t('Outcome waiting');
    case 'wallet_failed':
      return t('Outcome wallet failed', { message: result.message });
    case 'unknown':
      return t('Outcome unknown');
    case 'refused':
      return result.beforeWallet && /step_up/.test(result.code ?? '')
        ? t('Outcome step up', { detail: result.message })
        : t('Outcome refused', { detail: result.message });
    case 'outcome': {
      const o = result.outcome;
      if (!o.accepted) return t('Outcome refused', { detail: o.refusal.detail });
      const status = o.order?.status;
      const main =
        status === 'open'
          ? t('Outcome open')
          : status === 'filled'
            ? t('Outcome filled')
            : status === 'partially_filled'
              ? t('Outcome partly')
              : status === 'canceled'
                ? t('Outcome cancelled')
                : t('Outcome done');
      return result.reused ? `${main} ${t('Outcome reused')}` : main;
    }
  }
}

/**
 * Whether a draft's id must be held for the next press: until the venue answers definitely, a press is the same action
 * (read back, or prompted again); after a definite answer a new press is a new action with a new id.
 */
export function keepsDraft(result: ActionResult): boolean {
  return result.kind !== 'outcome';
}

/** The order statuses after which the venue does nothing more with an order. */
export const SETTLED_STATUSES: readonly string[] = ['filled', 'canceled', 'rejected', 'expired'];

/**
 * Reads an order back by its client id until the venue names it, for an answer that was not definite. An order not found
 * yet is only that: it keeps being read, and nothing is sent again. `onSettled` hears the venue's own settled record.
 */
export function ReadBack({
  owner,
  clientOrderId,
  onSettled,
}: {
  owner: string;
  clientOrderId: string;
  onSettled?: (order: VenueOrder) => void;
}) {
  const { t } = venueCopy.useCopy();
  const venue = useVenueApi();
  const read = usePolled((signal) => venue.orderByClientId(owner, clientOrderId, signal), `rb:${owner}:${clientOrderId}`, VENUE_POLL_MS);
  const order = read.data?.value ?? null;
  const settled = order && SETTLED_STATUSES.includes(order.status) ? order : null;
  useEffect(() => {
    if (settled) onSettled?.(settled);
  }, [settled, onSettled]);
  if (!read.data) return <p className="muted">{t('Checking venue')}</p>;
  return (
    <p data-testid="venue-read-back">{order ? t('Read back', { status: word(t, 'status', order.status) }) : t('Read back missing')}</p>
  );
}

export function OutcomeLine({ result, owner }: { result: ActionResult | null; owner: string | null }) {
  const { t } = venueCopy.useCopy();
  if (!result) return null;
  return (
    <div role="status" data-testid="venue-outcome">
      <p>{outcomeText(t, result)}</p>
      {result.kind === 'unknown' && result.clientOrderId && owner ? <ReadBack owner={owner} clientOrderId={result.clientOrderId} /> : null}
    </div>
  );
}

/** A venue read that failed, in the venue's words: down, refused or unreachable. */
export function ReadProblem({ failure, venueName }: { failure: { message: string; code?: string } | null; venueName: string }) {
  const { t } = venueCopy.useCopy();
  if (!failure) return null;
  const down = failure.code === 'trade.venue.venue_down';
  return (
    <p className="failure" role="alert" data-testid="venue-read-problem">
      {down ? t('Venue down', { venue: venueName, detail: failure.message }) : t('Read failed', { detail: failure.message })}
    </p>
  );
}

export function BalancesPanel({ balances, test }: { balances: AsOf<VenueBalance[]> | null; test: boolean }) {
  const { t } = venueCopy.useCopy();
  return (
    <section className="dk-panel" aria-label={t('Balances')} data-testid="venue-balances">
      <h2 className="dk-tab-title">
        {t('Balances')} <TestMark test={test} />
      </h2>
      {balances && balances.value.length > 0 ? (
        <DataTable label={t('Balances')} headers={[t('Asset'), t('Free'), t('Used'), t('Total')]}>
          {balances.value.map((b) => (
            <tr key={b.asset} data-asset={b.asset}>
              <td>{b.asset}</td>
              <td className="numeric" data-cell="free">
                {displayAmount(b.free)}
              </td>
              <td className="numeric" data-cell="used">
                {displayAmount(b.locked)}
              </td>
              <td className="numeric" data-cell="total">
                {displayAmount(b.total)}
              </td>
            </tr>
          ))}
        </DataTable>
      ) : balances ? (
        <p className="muted">{t('No balances')}</p>
      ) : null}
      <AsOfLine asOf={balances?.asOf ?? null} />
    </section>
  );
}

export function FillsTable({ fills, test, symbol }: { fills: AsOf<VenueFill[]> | null; test: boolean; symbol?: string }) {
  const { t } = venueCopy.useCopy();
  const asOfText = useAsOfText();
  const rows = (fills?.value ?? []).filter((f) => !symbol || f.symbol === symbol);
  return (
    <div data-testid="venue-fills">
      <TestMark test={test} />
      {rows.length === 0 ? (
        <p className="muted">{t('No fills')}</p>
      ) : (
        <DataTable
          label={t('Trade history')}
          headers={[
            t('Time'),
            t('Market'),
            t('Side'),
            t('Price'),
            t('Amount'),
            t('Role'),
            t('Venue fee'),
            t('Our builder fee'),
            t('Fee asset'),
            t('Realised result'),
          ]}
        >
          {rows.map((f) => (
            <tr key={f.fillId} data-fill={f.fillId} data-client-order-id={f.venueClientOrderId ?? ''}>
              <td>{asOfText(f.filledAt)}</td>
              <td>{f.symbol}</td>
              <td>{word(t, 'side', f.side)}</td>
              <td className="numeric" data-cell="price">
                {displayAmount(f.price)}
              </td>
              <td className="numeric" data-cell="amount">
                {displayAmount(f.amount)}
              </td>
              <td data-cell="role">{word(t, 'role', f.role)}</td>
              <td className="numeric" data-cell="venue-fee">
                {f.venueFee}
              </td>
              <td className="numeric" data-cell="builder-fee">
                {f.builderFee}
              </td>
              <td>{f.feeAsset}</td>
              <td className="numeric" data-cell="realised">
                {f.realisedPnl === null ? t('Not known') : f.realisedPnl}
              </td>
            </tr>
          ))}
        </DataTable>
      )}
      <AsOfLine asOf={fills?.asOf ?? null} />
    </div>
  );
}

/**
 * The open orders the venue lists, and the orders this page cancelled (read back by client id), each with Cancel. A
 * repeated cancel uses the same key, so it is the same action and reports the venue's first answer.
 */
export function OrdersTable({
  orders,
  test,
  onCancel,
  cancelled,
}: {
  orders: AsOf<VenueOrder[]> | null;
  test: boolean;
  onCancel: (order: VenueOrder) => void;
  cancelled: VenueOrder[];
}) {
  const { t } = venueCopy.useCopy();
  const open = orders?.value ?? [];
  const rows = [...open, ...cancelled.filter((c) => !open.some((o) => o.venueClientOrderId === c.venueClientOrderId))];
  return (
    <div data-testid="venue-open-orders">
      <TestMark test={test} />
      {rows.length === 0 ? (
        <p className="muted">{t('No open orders')}</p>
      ) : (
        <DataTable
          label={t('Open orders')}
          headers={[t('Market'), t('Side'), t('Type'), t('Price'), t('Amount'), t('Filled'), t('Locked'), t('Status'), '']}
        >
          {rows.map((o) => (
            <tr key={o.venueClientOrderId ?? o.venueOrderId ?? `${o.symbol}:${o.price}`} data-client-order-id={o.venueClientOrderId ?? ''}>
              <td>{o.symbol}</td>
              <td>{word(t, 'side', o.side)}</td>
              <td>{word(t, 'type', o.type)}</td>
              <td className="numeric" data-cell="price">
                {displayAmount(o.price)}
              </td>
              <td className="numeric" data-cell="amount">
                {displayAmount(o.amount)}
              </td>
              <td className="numeric" data-cell="filled">
                {displayAmount(o.filled)}
              </td>
              <td className="numeric" data-cell="locked">
                {displayAmount(o.locked)} {o.lockedAsset}
              </td>
              <td data-cell="status">{word(t, 'status', o.status)}</td>
              <td>
                {o.venueClientOrderId ? (
                  <Button variant="secondary" onClick={() => onCancel(o)}>
                    {o.status === 'canceled' ? t('Cancel again') : t('Cancel')}
                  </Button>
                ) : null}
              </td>
            </tr>
          ))}
        </DataTable>
      )}
      <AsOfLine asOf={orders?.asOf ?? null} />
    </div>
  );
}

/**
 * Withdraw from the venue account to the connected wallet: a fresh step-up first (identity's `trade.step_up.venue.withdraw`,
 * bound to the key, account, asset, amount and destination), then the door prepares it and the wallet signs. A refused
 * step-up stops it before the wallet is asked. The venue's withdrawal is then read by its nonce: pending, then done, with
 * its fee or "not known".
 */
export function WithdrawPanel({ owner, balances, test }: { owner: string; balances: AsOf<VenueBalance[]> | null; test: boolean }) {
  const { t } = venueCopy.useCopy();
  const venue = useVenueApi();
  const { run } = useVenueActions(owner);
  const assets = balances?.value.map((b) => b.asset) ?? [];
  const [asset, setAsset] = useState<string>('');
  const [amount, setAmount] = useState('');
  const [draft, setDraft] = useState<string | null>(null);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [busy, setBusy] = useState(false);
  const chosen = asset || assets[0] || '';
  let canonical: string | null = null;
  try {
    canonical = amount.trim() ? canonicalDecimal(amount) : null;
  } catch {
    canonical = null;
  }
  const withdrawalKey = draft ? keys.withdraw(owner, draft) : null;
  const nonce = result?.kind === 'outcome' && result.outcome.accepted ? result.nonce : result?.kind === 'unknown' ? result.nonce : null;
  const tracked = usePolled(
    (signal) => (nonce ? venue.withdrawal(owner, nonce, signal) : Promise.resolve(null)),
    `w:${owner}:${nonce}`,
    VENUE_POLL_MS,
  );

  async function send(stepUpApprovalId: string | null) {
    if (!withdrawalKey || !canonical || busy) return;
    setBusy(true);
    const answer = await run(
      { kind: 'withdraw', asset: chosen, amount: canonical, destination: owner, withdrawalKey },
      { stepUpApprovalId },
    );
    setBusy(false);
    setResult(answer);
  }

  return (
    <section className="dk-panel form-stack" aria-label={t('Withdraw')} data-testid="venue-withdraw">
      <h2 className="dk-tab-title">
        {t('Withdraw')} <TestMark test={test} />
      </h2>
      <label className="field">
        <span>{t('Withdraw asset')}</span>
        <select
          value={chosen}
          onChange={(e) => {
            setAsset(e.target.value);
            setDraft(null);
            setResult(null);
          }}
        >
          {assets.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>{t('Withdraw amount')}</span>
        <input
          inputMode="decimal"
          value={amount}
          onChange={(e) => {
            setAmount(e.target.value);
            setDraft(null);
            setResult(null);
          }}
        />
      </label>
      <p>
        {t('Destination')}: <span className="numeric">{owner}</span>
      </p>
      {draft === null ? (
        <Button disabled={!canonical || !chosen} onClick={() => setDraft(draftId())}>
          {t('Review withdrawal')}
        </Button>
      ) : result === null && withdrawalKey && canonical ? (
        <StepUpConfirm
          request={() => ({
            scope: 'trade.step_up.venue.withdraw',
            purpose: 'venue.withdraw',
            target: withdrawalKey,
            amount: canonical!,
            fields: { withdrawalKey, owner, subAccount: '', asset: chosen, amount: canonical!, destination: owner },
          })}
          words={{
            why: t('Withdraw step up why'),
            code: t('Authenticator code'),
            codeHint: t('Authenticator hint'),
            codeShort: t('Enter six'),
            noFactor: t('No factor'),
            sendWithout: t('Send without'),
          }}
          disabled={busy}
          onApproved={(id) => void send(id)}
        />
      ) : null}
      {busy ? <p className="muted">{t('Waiting wallet')}</p> : null}
      <OutcomeLine result={result} owner={owner} />
      {tracked.data?.value ? <WithdrawalLine withdrawal={tracked.data.value} asOf={tracked.data.asOf} /> : null}
    </section>
  );
}

function WithdrawalLine({ withdrawal, asOf }: { withdrawal: VenueWithdrawal; asOf: string }) {
  const { t } = venueCopy.useCopy();
  return (
    <dl className="protocol-facts" data-testid="venue-withdrawal" data-status={withdrawal.status}>
      <div>
        <dt>{t('Withdrawal status')}</dt>
        <dd>{word(t, 'withdrawal', withdrawal.status)}</dd>
      </div>
      <div>
        <dt>{t('Amount')}</dt>
        <dd className="numeric">
          {displayAmount(withdrawal.amount)} {withdrawal.asset}
        </dd>
      </div>
      <div>
        <dt>{t('Withdrawal fee')}</dt>
        <dd className="numeric" data-cell="fee">
          <Known value={withdrawal.fee} />
        </dd>
      </div>
      <AsOfLine asOf={asOf} />
    </dl>
  );
}
