import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DexOrderCap } from '@intafaced/contracts/protocol-dex-orders';
import { Button, DataTable, EmptyState, Page, Panel } from '../../../shared/ui';
import { currentPreferences, usePreferences } from '../../../shared/preferences';
import type { ApiResult } from '../../../shared/api';
import { stamp } from '../../../screens/money/time';
import { useApi } from '../../session/session';
import { APP_CHAIN_ID } from '../wallet/eip1193';
import { useWallet } from '../wallet/WalletProvider';
import { ordersCopy, type OrdersTranslate } from './copy';
import {
  createOrdersApi,
  forgetSession,
  rememberSession,
  rememberedSession,
  type OrderChallenge,
  type OrderSession,
  type OrdersApi,
} from './orders-api';
import '../protocol.css';

type Refusal = Extract<ApiResult<unknown>, { ok: false }>;

/** Codes with their own words in copy.ts; any other code reads as a plain refusal, still with its code. */
const KNOWN = new Set([
  'dex.auth.challenge_replayed',
  'dex.auth.challenge_invalid',
  'dex.auth.signature_not_owner',
  'dex.auth.unauthenticated',
  'dex.auth.session_unset',
  'dex.auth.lifetime_unset',
  'dex.order.cap_unset',
]);

/** The words for a refusal, with its code as support text, so a person can quote it. */
export function refusalWords(t: OrdersTranslate, refusal: Refusal): string {
  if (!refusal.code) return refusal.reason === 'unreachable' || refusal.reason === 'uncertain' ? t('unreachable') : t('refusedOther');
  const key = KNOWN.has(refusal.code) ? (`refused_${refusal.code.replace(/\./g, '_')}` as Parameters<OrdersTranslate>[0]) : null;
  return t('refused', { words: key ? t(key as 'refusedOther') : t('refusedOther'), code: refusal.code });
}

function useOrdersApi(): OrdersApi {
  const transport = useApi();
  return useMemo(() => createOrdersApi(transport), [transport]);
}

/**
 * /dex/orders (D-limit-dca-01 to -04): the person's own orders, from their own wallet. The order session comes first:
 * its scope, expiry and cap are on the page before the wallet is asked to sign anything.
 */
export function OrdersRoom() {
  const { language } = usePreferences();
  const { t } = ordersCopy.forLocale(language);
  const wallet = useWallet();
  const address = wallet.status === 'connected' && wallet.connected ? wallet.address : null;
  const api = useOrdersApi();
  const [session, setSession] = useState<OrderSession | null>(() => (address ? (rememberedSession(address) ?? null) : null));
  useEffect(() => setSession(address ? (rememberedSession(address) ?? null) : null), [address]);

  return (
    <Page eyebrow={t('eyebrow')} title={t('title')} description={t('description')}>
      {!address ? (
        <Panel title={t('connectTitle')}>
          <EmptyState title={t('connectTitle')} action={<a href="/wallet">{t('connectAction')}</a>}>
            {t('connectBody')}
          </EmptyState>
        </Panel>
      ) : (
        <>
          <SessionPanel api={api} address={address} session={session} onSession={setSession} t={t} />
          <OrderList api={api} address={address} session={session} t={t} />
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

function SessionPanel({
  api,
  address,
  session,
  onSession,
  t,
}: {
  api: OrdersApi;
  address: string;
  session: OrderSession | null;
  onSession: (session: OrderSession | null) => void;
  t: OrdersTranslate;
}) {
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
    setProblem(null);
    const ended = await api.logout(session.accessToken);
    // Only the service's own yes (or its word that the session had already ended) ends it here; anything else keeps it,
    // and says so, so no one is told a session was revoked when it was not.
    if (!ended.ok && ended.code !== 'dex.auth.unauthenticated')
      return setProblem(t('sessionSignOutFailed', { words: refusalWords(t, ended) }));
    forgetSession(address);
    onSession(null);
    setSignedOut(true);
  };

  const shown = session ?? challenge;
  return (
    <Panel title={t('sessionTitle')} aria-label={t('sessionTitle')}>
      <p className="muted">{t('sessionIntro')}</p>
      {shown ? (
        <dl className="kv">
          <dt>{t('sessionScope')}</dt>
          <dd>{shown.scope}</dd>
          <dt>{t('sessionExpires')}</dt>
          <dd>
            <time dateTime={session ? session.accessExpiresAt : challenge!.sessionExpiresAt}>
              {stamp(session ? session.accessExpiresAt : challenge!.sessionExpiresAt, currentPreferences().timeZone)}
            </time>
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
      {session && <p role="status">{t('sessionSigned', { time: stamp(session.accessExpiresAt, currentPreferences().timeZone) })}</p>}
      {signedOut && <p role="status">{t('sessionSignedOut')}</p>}
      {problem && <p role="alert">{problem}</p>}
    </Panel>
  );
}

function OrderList({ api, address, session, t }: { api: OrdersApi; address: string; session: OrderSession | null; t: OrdersTranslate }) {
  const [count, setCount] = useState<number | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void api.count(address).then((result) => {
      if (!live) return;
      if (result.ok) setCount(result.data.count);
      else setProblem(refusalWords(t, result));
    });
    return () => {
      live = false;
    };
  }, [api, address, session, t]);
  const headers = [t('hdrId'), t('hdrType'), t('hdrSide'), t('hdrAmount'), t('hdrTrigger'), t('hdrState'), t('hdrActions')];
  return (
    <Panel title={t('listTitle')}>
      <DataTable label={t('listTitle')} headers={headers}>
        <tr>
          <td colSpan={headers.length}>
            {problem ? (
              <p role="alert">{problem}</p>
            ) : count === 0 ? (
              <EmptyState title={t('listEmpty')} />
            ) : count !== null && !session ? (
              <EmptyState title={t('listNeedsSession')} />
            ) : null}
          </td>
        </tr>
      </DataTable>
    </Panel>
  );
}
