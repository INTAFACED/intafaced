import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DexOrderCap } from '@intafaced/contracts/protocol-dex-orders';
import { Button, EmptyState, Page, Panel } from '../../../shared/ui';
import { currentPreferences, usePreferences } from '../../../shared/preferences';
import type { ApiResult } from '../../../shared/api';
import { stamp } from '../../../screens/money/time';
import { useApi } from '../../session/session';
import { createProtocolApi, type RepresentationStatus } from '../api';
import { REGION_BLOCKED_CODE } from '../region';
import { APP_CHAIN_ID } from '../wallet/eip1193';
import { RepresentationPanel } from '../wallet/RepresentationPanel';
import { useWallet, waitMined, type Sequence } from '../wallet/WalletProvider';
import { ordersCopy, refusalKey, type OrdersTranslate } from './copy';
import { OrderForm } from './OrderForm';
import { OrderList } from './OrderList';
import {
  createOrdersApi,
  forgetSession,
  rememberSession,
  rememberedSession,
  type OrderChallenge,
  type OrderSession,
  type OrdersApi,
} from './orders-api';
import { VaultPanel } from './VaultPanel';
import '../protocol.css';

export type Refusal = Extract<ApiResult<unknown>, { ok: false }>;

/** The words for a refusal, with its code as support text, so a person can quote it. */
export function refusalWords(t: OrdersTranslate, refusal: Refusal): string {
  if (!refusal.code) return refusal.reason === 'unreachable' || refusal.reason === 'uncertain' ? t('unreachable') : t('refusedOther');
  const key = refusalKey(refusal.code);
  return t('refused', { words: key ? t(key as 'refusedOther') : t('refusedOther'), code: refusal.code });
}

/** What every action of the room gets: the API, the wallet, the session, and the representation gate before signing. */
export interface OrdersContext {
  readonly api: OrdersApi;
  readonly address: string;
  readonly session: OrderSession | null;
  readonly t: OrdersTranslate;
  /** Runs `then` once the wallet has accepted the representation; returns a refusal's words when it cannot. */
  readonly gated: (then: () => Promise<void>) => Promise<string | null>;
  /** Sends the calls through the wallet's sequence sheet; null on success, else the words. */
  readonly send: (sequence: Sequence) => Promise<string | null>;
  /** Bumps after any change, so the vault and the list read again. */
  readonly revision: number;
  readonly changed: () => void;
}

/**
 * /dex/orders (D-limit-dca-01 to -04): the person's own orders, from their own wallet. The order session comes first:
 * its scope, expiry and cap are on the page before the wallet is asked to sign anything. Every action that signs passes
 * the representation gate first, as Send does.
 */
export function OrdersRoom() {
  const { language } = usePreferences();
  const { t } = ordersCopy.forLocale(language);
  const wallet = useWallet();
  const address = wallet.status === 'connected' && wallet.connected ? wallet.address : null;
  const transport = useApi();
  const api = useMemo(() => createOrdersApi(transport), [transport]);
  const protocol = useMemo(() => createProtocolApi(transport), [transport]);
  const [session, setSession] = useState<OrderSession | null>(() => (address ? (rememberedSession(address) ?? null) : null));
  useEffect(() => setSession(address ? (rememberedSession(address) ?? null) : null), [address]);
  const [revision, setRevision] = useState(0);
  const changed = useCallback(() => setRevision((n) => n + 1), []);
  const [representation, setRepresentation] = useState<{ status: RepresentationStatus; resolve: (ok: boolean) => void } | null>(null);
  const sendSequence = useRef(wallet.sendSequence);
  sendSequence.current = wallet.sendSequence;
  const readNode = useRef(wallet.read);
  readNode.current = wallet.read;

  const gated = useCallback(
    async (then: () => Promise<void>): Promise<string | null> => {
      if (!address) return t('connectBody');
      const gate = await protocol.representationStatus(address);
      if (!gate.ok)
        return gate.code === REGION_BLOCKED_CODE
          ? t('gateRegion')
          : gate.code === 'compliance.representation_unset'
            ? t('gateUnset')
            : t('gateUnavailable');
      if (!gate.data.accepted) {
        const accepted = await new Promise<boolean>((resolve) => setRepresentation({ status: gate.data, resolve }));
        if (!accepted) return t('gateRejected');
      }
      await then();
      return null;
    },
    [address, protocol, t],
  );

  const send = useCallback(
    async (sequence: Sequence): Promise<string | null> => {
      const result = await sendSequence.current(sequence);
      if (result.status === 'sent') {
        // The wallet waits for every step but the last; the room waits for the last too, so a read after it sees the
        // change, and a refused last step is never shown as done.
        const last = result.hashes[result.hashes.length - 1];
        if (!last) return null;
        const mined = await waitMined((hash) => readNode.current('eth_getTransactionReceipt', [hash]), last, 120_000);
        if (mined.status === 'success') return null;
        return mined.status === 'reverted' ? t('walletReverted') : t('walletNotMined');
      }
      if (result.status === 'rejected') return t('walletRejected');
      return t('walletFailed', { message: result.message });
    },
    [t],
  );

  const ctx: OrdersContext | null = address ? { api, address, session, t, gated, send, revision, changed } : null;
  return (
    <Page eyebrow={t('eyebrow')} title={t('title')} description={t('description')}>
      {!ctx ? (
        <Panel title={t('connectTitle')}>
          <EmptyState title={t('connectTitle')} action={<a href="/wallet">{t('connectAction')}</a>}>
            {t('connectBody')}
          </EmptyState>
        </Panel>
      ) : (
        <>
          {representation && (
            <RepresentationPanel
              address={ctx.address}
              status={representation.status}
              api={protocol}
              onEnd={(end) => {
                representation.resolve(end.kind === 'accepted');
                setRepresentation(null);
              }}
            />
          )}
          <SessionPanel ctx={ctx} onSession={setSession} />
          <VaultPanel ctx={ctx} />
          <OrderForm ctx={ctx} />
          <OrderList ctx={ctx} />
        </>
      )}
    </Page>
  );
}

function CapRows({ cap, t }: { cap: readonly DexOrderCap[]; t: OrdersTranslate }) {
  return (
    <>
      {cap.map((row) => (
        <span key={row.token} className="numeric">
          {t('sessionCapRow', { max: row.max, symbol: row.symbol })}
          <br />
        </span>
      ))}
    </>
  );
}

function SessionPanel({ ctx, onSession }: { ctx: OrdersContext; onSession: (session: OrderSession | null) => void }) {
  const { api, address, session, t } = ctx;
  const wallet = useWallet();
  const sign = useRef(wallet.sign);
  sign.current = wallet.sign;
  const [challenge, setChallenge] = useState<OrderChallenge | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [signedOut, setSignedOut] = useState(false);
  // The last challenge and signature sent, so the person can see a used signature open nothing.
  const last = useRef<{ challenge: string; signature: string } | null>(null);

  const write = useCallback(async () => {
    setChallenge(null);
    const written = await api.challenge({ address, chainId: APP_CHAIN_ID });
    if (written.ok) setChallenge(written.data);
    else setProblem(refusalWords(t, written));
  }, [api, address, t]);

  useEffect(() => {
    if (!session) void write();
  }, [session, write]);

  const signSession = async () => {
    if (!challenge) return;
    setBusy(true);
    setProblem(null);
    setSignedOut(false);
    try {
      const signed = await sign.current({ kind: 'typedData', typedData: challenge.typedData });
      if (signed.status === 'rejected') return setProblem(t('sessionRejected'));
      if (signed.status !== 'signed') return setProblem(t('sessionWallet', { message: signed.status === 'failed' ? signed.message : '' }));
      last.current = { challenge: challenge.challenge, signature: signed.signature };
      const opened = await api.verify(last.current);
      if (!opened.ok) return setProblem(refusalWords(t, opened));
      rememberSession(opened.data);
      onSession(opened.data);
    } finally {
      setBusy(false);
    }
  };

  const replay = async () => {
    if (!last.current) return;
    setProblem(null);
    const again = await api.verify(last.current);
    // A second session from one signature would be a defect: the service must refuse it.
    if (again.ok) return setProblem(t('refusedOther'));
    setProblem(refusalWords(t, again));
  };

  const signOut = async () => {
    if (!session) return;
    await api.logout(session.accessToken);
    forgetSession(address);
    onSession(null);
    setSignedOut(true);
  };

  const expires = session ? session.accessExpiresAt : challenge?.sessionExpiresAt;
  const shown = session ?? challenge;
  return (
    <Panel title={t('sessionTitle')} aria-label={t('sessionTitle')}>
      <p className="muted">{t('sessionIntro')}</p>
      {shown && expires ? (
        <dl className="kv">
          <dt>{t('sessionScope')}</dt>
          <dd>{shown.scope}</dd>
          <dt>{t('sessionExpires')}</dt>
          <dd>
            <time dateTime={expires}>{stamp(expires, currentPreferences().timeZone)}</time>
          </dd>
          <dt>{t('sessionCap')}</dt>
          <dd>
            <CapRows cap={shown.cap} t={t} />
          </dd>
        </dl>
      ) : (
        !problem && <p className="muted">{t('sessionLoading')}</p>
      )}
      <div className="actions">
        {!session && (
          <Button onClick={() => void signSession()} disabled={!challenge || busy}>
            {busy ? t('sessionSigning') : t('sessionSign')}
          </Button>
        )}
        {last.current && (
          <Button variant="secondary" onClick={() => void replay()} title={t('sessionReplayHint')}>
            {t('sessionReplay')}
          </Button>
        )}
        {session && (
          <Button variant="ghost" onClick={() => void signOut()}>
            {t('sessionSignOut')}
          </Button>
        )}
      </div>
      {session ? (
        <p role="status">{t('sessionSigned', { time: stamp(session.accessExpiresAt, currentPreferences().timeZone) })}</p>
      ) : (
        signedOut && <p role="status">{t('sessionSignedOut')}</p>
      )}
      {problem && <p role="alert">{problem}</p>}
    </Panel>
  );
}
