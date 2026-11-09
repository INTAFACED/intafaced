import { useEffect, useMemo, useRef, useState } from 'react';
import { z } from 'zod';
import { Button } from '@intafaced/ui';
import { Tag } from '@intafaced/ui/lit';
import type { ProtocolEmbeddedWalletRecord } from '@intafaced/contracts/protocol-embedded-wallet';
import type { ApiClient, ApiResult } from '../../../shared/api';
import { useResource } from '../../../shared/resource';
import type { embeddedWalletCopy } from './embedded-wallet-copy';
import type { ClientFailure, EmbeddedWalletClient } from './provider-client';
import {
  createTradingSessionApi,
  dropKey,
  freshKey,
  heldKey,
  keepKey,
  keyFor,
  orderKey,
  signWithSessionKey,
  type HeldKey,
  type Prepared,
  type SessionView,
  type SubmitAnswer,
} from './trading-session';

type T = ReturnType<typeof embeddedWalletCopy.useCopy>['t'];
type Failed = Extract<ApiResult<unknown>, { ok: false }>;

const marketsSchema = z
  .object({ value: z.array(z.object({ symbol: z.string(), kind: z.string(), orderTypes: z.array(z.string()) }).passthrough()) })
  .passthrough();

/** `a >= b` for two non-negative decimal strings, exactly (no floating point). */
export function decimalAtLeast(a: string, b: string): boolean {
  const scaled = (v: string) => {
    const m = /^(\d+)(?:\.(\d{1,18}))?$/.exec(v.trim());
    if (!m) return null;
    return BigInt(m[1]!) * 10n ** 18n + BigInt((m[2] ?? '').padEnd(18, '0'));
  };
  const x = scaled(a);
  const y = scaled(b);
  return x !== null && y !== null && x >= y;
}

/** What this section says after a press, in its own words. */
type Said = { tone: 'status' | 'alert'; text: string; code?: string };

/**
 * J-wallet-22 #8 in the wallet room: the trading session. One approval, signed by the person's wallet at its provider
 * after the passkey, for a fresh session key made on this device; two (or any number of) orders signed by that key with
 * no second prompt; End trading session (the wallet's revoke) or the expiry ends it; a new session is a new key.
 * The orders are the venue's own, through svc-trade's user-venue door (`/api/v1/venue/*`), and every figure is the
 * venue's: TEST on a TEST venue.
 */
export function TradingSession(props: {
  api: ApiClient;
  userId: string;
  wallet: ProtocolEmbeddedWalletRecord;
  client: EmbeddedWalletClient | null;
  providerFailure: (failure: ClientFailure) => string;
  t: T;
}) {
  const { api, userId, wallet, client, providerFailure, t } = props;
  const owner = wallet.address.toLowerCase();
  const venue = useMemo(() => createTradingSessionApi(api), [api]);
  const [epoch, setEpoch] = useState(0);
  const door = useResource((signal) => venue.door(signal), `venue-door:${userId}`);
  const doorReady =
    door.resource.status === 'ready' && door.resource.data.enabled && door.resource.data.available ? door.resource.data : null;
  const session = useResource(
    (signal) => (doorReady ? venue.session(owner, signal) : Promise.resolve({ ok: true as const, data: null })),
    `venue-session:${userId}:${owner}:${doorReady ? 'on' : 'off'}:${epoch}`,
  );
  const approval = useResource(
    (signal) => (doorReady?.builder ? venue.builderFeeApproval(owner, signal) : Promise.resolve({ ok: true as const, data: null })),
    `venue-builder-approval:${userId}:${owner}:${doorReady?.builder ? 'on' : 'off'}:${epoch}`,
  );
  const markets = useResource(
    (signal) => (doorReady ? api.rest('/venue/markets', marketsSchema, { signal }) : Promise.resolve({ ok: true as const, data: null })),
    `venue-markets:${userId}:${doorReady ? 'on' : 'off'}`,
  );
  const [held, setHeld] = useState<HeldKey | null>(() => heldKey(userId));
  const [said, setSaid] = useState<Said | null>(null);
  const [placed, setPlaced] = useState<{ key: string; status: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [order, setOrder] = useState({ symbol: '', side: 'buy', amount: '0.001', price: '1000' });

  const read = session.resource.status === 'ready' ? session.resource.data : null;
  const current: SessionView | null = read?.current ?? null;
  // Judged only against a real read of this sign-in's session: never while the door or the read is still loading.
  const use = read ? keyFor(current, held) : 'none';
  useEffect(() => {
    if (use !== 'drop') return;
    dropKey(userId);
    setHeld(null);
  }, [use, userId]);

  const venueName = doorReady?.venue.displayName ?? '';
  const spot =
    markets.resource.status === 'ready' ? (markets.resource.data?.value ?? []).filter((m) => m.orderTypes.includes('limit')) : [];
  const symbol = order.symbol || spot[0]?.symbol || '';
  const approvedBps = approval.resource.status === 'ready' && approval.resource.data ? approval.resource.data.value : null;
  const builderApproved = doorReady?.builder && approvedBps !== null ? decimalAtLeast(approvedBps, doorReady.builder.feeBps) : false;

  async function once(work: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setSaid(null);
    try {
      await work();
    } catch {
      setSaid({ tone: 'alert', text: t('otherBody') });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  const refused = (failure: Failed, fallback = t('otherBody')) =>
    setSaid({
      tone: 'alert',
      text: failure.message && failure.code?.startsWith('trade.venue') ? failure.message : fallback,
      code: failure.code,
    });
  const reread = () => setEpoch((n) => n + 1);

  /** The wallet signs a prepared owner action at its provider, after the passkey; the door sends it. */
  async function ownerSigns(prepared: Prepared): Promise<SubmitAnswer | null> {
    let signature = { digest: prepared.prepared.digest, signature: '0x', signedBy: owner };
    // An action the wallet already signed is re-sent with its stored signature: the wallet is not asked again.
    if (!prepared.signed) {
      if (!client) return null;
      const signed = await client.signTypedData(wallet.providerWalletId, prepared.prepared.typedData);
      if (!signed.ok) {
        setSaid({ tone: 'alert', text: providerFailure(signed.failure) });
        return null;
      }
      signature = { digest: prepared.prepared.digest, signature: signed.data.signature, signedBy: signed.data.address.toLowerCase() };
    }
    const sent = await venue.submit(prepared.actionKey, signature);
    if (!sent.ok) {
      refused(sent);
      return null;
    }
    return sent.data;
  }

  const approveBuilder = () =>
    once(async () => {
      if (!doorReady?.builder) return;
      const prepared = await venue.prepare({
        owner,
        signer: { role: 'owner', address: owner },
        intent: { kind: 'approve_builder_fee', builder: doorReady.builder.address, maxFeeBps: doorReady.builder.feeBps },
        actionKey: `builder-fee:${userId}:${doorReady.venue.id}:${doorReady.builder.feeBps}`,
      });
      if (!prepared.ok) return refused(prepared);
      const sent = await ownerSigns(prepared.data);
      if (sent && sent.outcome.definite && !sent.outcome.accepted) setSaid({ tone: 'alert', text: sent.outcome.refusal.detail });
      reread();
    });

  const start = () =>
    once(async () => {
      // The key for an approval still out is the same key, so a retry is the same approval; otherwise a new one.
      const key = use === 'pending' && held ? held : freshKey(userId);
      setHeld(key);
      const started = await venue.start(owner, key.address);
      if (!started.ok) {
        if (started.code === 'trade.venue_session_key_reused') {
          dropKey(userId);
          setHeld(null);
        }
        return refused(started);
      }
      await ownerSigns(started.data);
      // A refusal, or an answer that is not definite, is read back from the venue by the re-read below: the session's
      // own state says it (refused, approving, or live when the venue lists the key).
      reread();
    });

  const end = () =>
    once(async () => {
      const ending = await venue.end(owner);
      if (!ending.ok) return refused(ending);
      const sent = await ownerSigns(ending.data);
      if (sent?.outcome.definite && sent.outcome.accepted) {
        dropKey(userId);
        setHeld(null);
      }
      reread();
    });

  const place = () =>
    once(async () => {
      if (!current || !held || use !== 'use') return;
      let key = held;
      // An order sent with no definite answer is re-sent as that same order (one business key, one venue order); a new
      // order takes the next ticket, kept with the key so a reload never reuses one.
      const pending = key.pendingOrder ?? {
        key: orderKey(userId, current.sessionId, key.nextTicket),
        intent: {
          kind: 'place_order',
          symbol,
          side: order.side,
          type: 'limit',
          amount: order.amount.trim(),
          price: order.price.trim(),
          timeInForce: 'GTC',
          reduceOnly: false,
          clientOrderKey: orderKey(userId, current.sessionId, key.nextTicket),
          builderFee: null,
        },
      };
      const keep = (next: HeldKey) => {
        key = keepKey(userId, next);
        setHeld(key);
      };
      /** A definite answer for this ticket: the next order takes the next one. */
      const settled = () => keep({ ...key, pendingOrder: null, nextTicket: key.nextTicket + 1 });
      keep({ ...key, pendingOrder: pending });
      const prepared = await venue.prepare({ owner, signer: { role: 'agent', address: key.address }, intent: pending.intent });
      if (!prepared.ok) {
        // Nothing was stored under the key when the venue refused to prepare it: the same ticket serves the next order.
        if (prepared.reason !== 'uncertain') keep({ ...key, pendingOrder: null });
        if (prepared.code === 'trade.venue_action_key_reused') settled();
        if (prepared.code === 'trade.venue.signer_not_authorised') {
          setSaid({ tone: 'alert', text: t('orderKeyEnded'), code: prepared.code });
          return reread();
        }
        return refused(prepared);
      }
      // The session key signs it here: no passkey, no provider.
      const signature = await signWithSessionKey(key, prepared.data.prepared);
      const sent = await venue.submit(prepared.data.actionKey, signature);
      if (!sent.ok) return refused(sent);
      const outcome = sent.data.outcome;
      if (!outcome.definite) return setSaid({ tone: 'status', text: t('orderUncertain') });
      settled();
      if (!outcome.accepted) {
        if (outcome.refusal.code === 'signer_not_authorised') {
          setSaid({ tone: 'alert', text: t('orderKeyEnded'), code: `trade.venue.${outcome.refusal.code}` });
          return reread();
        }
        return setSaid({
          tone: 'alert',
          text: t('orderRefused', { detail: outcome.refusal.detail }),
          code: `trade.venue.${outcome.refusal.code}`,
        });
      }
      const status = outcome.order?.status ?? 'accepted';
      setPlaced((list) => [...list, { key: pending.key, status }]);
      setSaid({ tone: 'status', text: t('orderPlaced', { venue: venueName, status }) });
    });

  if (door.resource.status === 'loading') return null;
  if (!doorReady) {
    const down = door.resource.status === 'ready' && door.resource.data.enabled;
    return (
      <section aria-label={t('sessionTitle')} data-panel="trading-session" data-session-state="off">
        <h2>{t('sessionTitle')}</h2>
        <p>{down ? t('sessionDown') : t('sessionOff')}</p>
      </section>
    );
  }

  if (session.resource.status === 'failed') {
    const failure = session.resource.failure;
    return (
      <section aria-label={t('sessionTitle')} data-panel="trading-session" data-session-state="unread">
        <h2>{t('sessionTitle')}</h2>
        <p role="alert">
          {t('sessionReadFailed', { reason: failure.message || t('otherBody') })}
          {failure.code ? <> ({failure.code})</> : null}
        </p>
      </section>
    );
  }

  const state = current?.state ?? 'none';
  const time = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '');
  const onNow = state === 'live' && use === 'use';
  const why =
    state === 'live' && use !== 'use'
      ? t('sessionNotHere')
      : state === 'expired'
        ? t('sessionExpired')
        : state === 'ended'
          ? t('sessionEnded')
          : state === 'replaced'
            ? current?.replacedBy === 'another_sign_in'
              ? t('sessionReplacedOther')
              : t('sessionReplacedHere')
            : state === 'approving'
              ? t('sessionApproving')
              : state === 'refused'
                ? t('sessionRefused', { detail: current?.refusal?.detail ?? '' })
                : null;

  return (
    <section aria-label={t('sessionTitle')} data-panel="trading-session" data-session-state={onNow ? 'on' : state}>
      <h2>{t('sessionTitle')}</h2>
      <p>
        {t('sessionVenue', { venue: venueName })}{' '}
        {doorReady.test ? (
          <Tag tone="neutral" data-venue-test-label>
            TEST
          </Tag>
        ) : null}
      </p>
      <section aria-label={t('builderTitle')}>
        <h3>{t('builderTitle')}</h3>
        {doorReady.builder ? (
          <>
            <p>{t('builderNote', { fee: doorReady.builder.feeBps })}</p>
            {builderApproved ? (
              <p data-builder-approved>{t('builderApproved')}</p>
            ) : (
              <Button disabled={busy || !client} onClick={() => void approveBuilder()}>
                {t('builderApprove')}
              </Button>
            )}
          </>
        ) : (
          <p>{t('builderUnset')}</p>
        )}
      </section>
      {onNow && current ? (
        <>
          <p role="status">{t('sessionLive', { venue: venueName })}</p>
          <dl>
            <div>
              <dt>{t('sessionKey')}</dt>
              <dd data-session-key>{current.agentAddress}</dd>
            </div>
            <div>
              <dt>{t('sessionUntil')}</dt>
              <dd>
                <time dateTime={current.validUntil ?? ''} data-testid="session-expires">
                  {time(current.validUntil)}
                </time>
              </dd>
            </div>
          </dl>
          <p>{t('withdrawNever')}</p>
          <section aria-label={t('orderTitle')}>
            <h3>{t('orderTitle')}</h3>
            <label>
              {t('orderMarket')}{' '}
              <select value={symbol} onChange={(e) => setOrder({ ...order, symbol: e.target.value })}>
                {spot.map((m) => (
                  <option key={m.symbol} value={m.symbol}>
                    {m.symbol}
                  </option>
                ))}
              </select>
            </label>{' '}
            <label>
              {t('orderSide')}{' '}
              <select value={order.side} onChange={(e) => setOrder({ ...order, side: e.target.value })}>
                <option value="buy">{t('orderBuy')}</option>
                <option value="sell">{t('orderSell')}</option>
              </select>
            </label>{' '}
            <label>
              {t('orderAmount')}{' '}
              <input inputMode="decimal" value={order.amount} onChange={(e) => setOrder({ ...order, amount: e.target.value })} />
            </label>{' '}
            <label>
              {t('orderPrice')}{' '}
              <input inputMode="decimal" value={order.price} onChange={(e) => setOrder({ ...order, price: e.target.value })} />
            </label>{' '}
            <Button variant="primary" disabled={busy || !symbol || !builderApproved} onClick={() => void place()}>
              {t('orderPlace')}
            </Button>
            {placed.length ? (
              <ol data-session-orders>
                {placed.map((p) => (
                  <li key={p.key} data-order-key={p.key}>
                    {p.status}
                  </li>
                ))}
              </ol>
            ) : null}
          </section>
          <Button disabled={busy || !client} onClick={() => void end()}>
            {t('sessionEnd')}
          </Button>
        </>
      ) : (
        <>
          {why ? <p role="status">{why}</p> : <p>{t('sessionAbout', { venue: venueName })}</p>}
          <Button variant="primary" disabled={busy || !client} onClick={() => void start()}>
            {state === 'none' || state === 'awaiting_signature' || state === 'approving' ? t('sessionStart') : t('sessionStartNew')}
          </Button>
        </>
      )}
      {said ? (
        <p role={said.tone === 'alert' ? 'alert' : 'status'} data-session-said>
          {said.text}
          {said.code ? <> ({said.code})</> : null}
        </p>
      ) : null}
    </section>
  );
}
