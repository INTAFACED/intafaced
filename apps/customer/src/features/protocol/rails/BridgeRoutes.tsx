import { useId, useState, type FormEvent } from 'react';
import { BRIDGE_ROUTES_UNSET, type BridgeCall, type BridgeRoute, type BridgeTransfer } from '@intafaced/contracts/protocol-bridge';
import {
  PROTOCOL_BRIDGE_ROUTES_LIST,
  PROTOCOL_BRIDGE_TRANSFERS_BURN_SUBMITTED,
  PROTOCOL_BRIDGE_TRANSFERS_LIST,
  PROTOCOL_BRIDGE_TRANSFERS_START,
} from '@intafaced/contracts/protocol-chain-procedures';
import type { ApiClient } from '../../../shared/api';
import { useBackoffPoll } from '../../../shared/backoff-poll';
import { useResource } from '../../../shared/resource';
import { Button, Tag } from '@intafaced/ui/lit';
import { DataTable, EmptyState, Failure, Field, Loading, Panel } from '../volt/parts';
import { protocolCopy as copy } from '../copy';
import { useWallet, type Sequence } from '../wallet/WalletProvider';

type Translate = ReturnType<typeof copy.forLocale>['t'];

/** How often the transfers are read again while one is still moving, and once every one is minted. */
const MOVING_POLL_MS = 2_000;
const SETTLED_POLL_MS = 15_000;

/** A service refusal reads "bridge.<code>: <sentence>"; the person sees the sentence. */
const sentence = (message: string) => message.replace(/^[a-z_]+\.[a-z_.]+:\s*/, '');

/**
 * The transfer's business key: its route, its amount and the wallet's next transaction number on the source chain, the
 * one its burn will take. Pressing Review again for the same transfer before the burn is sent answers the same stored
 * transfer; once the burn is sent the number moves on, so the next transfer is a new one.
 */
const transferKey = (t: { from: number; to: number; asset: string; amount: string; nonce: bigint }) =>
  `bridge-${t.from}-${t.to}-${t.asset}-${t.amount.replace(/[^0-9A-Za-z]/g, '_').slice(0, 30)}-n${t.nonce}`;

/**
 * The rails room's bridge (D-bridge-chain-03): the owner-published route table and the person's transfers. With the table
 * blank (`bridge.routes_unset`) the room keeps its full layout, names the owner decision and offers no route, so Start a
 * transfer stays disabled. With routes, a transfer is a burn on the source chain, the provider's attestation, and a mint
 * on the destination chain: the intent is stored before the burn, the wallet signs the burn and the mint, and each row is
 * read again from the chains, so a closed page finds its transfer where it left it. Nothing posts to the ledger.
 */
export function BridgeRoutes({ api, t }: { api: ApiClient; t: Translate }) {
  const routes = useResource((signal) => api.call(PROTOCOL_BRIDGE_ROUTES_LIST, undefined, { signal }), 'bridge.routes.list');
  const wallet = useWallet();
  const account = wallet.status === 'connected' ? wallet.address : null;
  const [starting, setStarting] = useState(false);
  const { resource } = routes;
  const unset =
    resource.status === 'failed' &&
    (resource.failure.code === BRIDGE_ROUTES_UNSET || (resource.failure.message ?? '').startsWith(BRIDGE_ROUTES_UNSET));
  const list = resource.status === 'ready' ? resource.data.routes : [];
  const headers = [t('hdr_from'), t('hdr_to'), t('hdr_asset'), t('hdr_provider')];
  const blocked = list.length === 0 ? t('startTransferBlocked') : account === null ? t('bridgeConnect') : undefined;
  return (
    <>
      <Panel title={t('bridgeRoutes')}>
        <DataTable label={t('bridgeRoutes')} headers={headers}>
          {resource.status === 'loading' ? (
            <tr>
              <td colSpan={headers.length}>
                <Loading />
              </td>
            </tr>
          ) : unset ? (
            <tr>
              <td colSpan={headers.length} data-code={BRIDGE_ROUTES_UNSET}>
                <p>{t('bridgeRoutesUnset')}</p>
                <Tag data-blocker="owner.decision">{t('ownerDecision')}</Tag>
              </td>
            </tr>
          ) : resource.status === 'failed' ? (
            <tr>
              <td colSpan={headers.length}>
                <Failure result={resource.failure} retry={routes.reload} />
              </td>
            </tr>
          ) : (
            list.map((route) => (
              <tr key={`${route.from.chainId}:${route.to.chainId}:${route.token}`}>
                <td>{route.from.name}</td>
                <td>{route.to.name}</td>
                <td>{route.token}</td>
                <td>{route.provider ?? t('providerUnset')}</td>
              </tr>
            ))
          )}
        </DataTable>
        <Button disabled={blocked !== undefined || starting} title={blocked} onClick={() => setStarting(true)}>
          {t('startTransfer')}
        </Button>
        {blocked !== undefined && <p className="lt-hint">{blocked}</p>}
        {starting && account && list.length > 0 && <TransferForm api={api} t={t} routes={list} account={account} />}
      </Panel>
      <Panel title={t('bridgeTransfers')}>
        {account ? <Transfers api={api} t={t} account={account} /> : <TransfersTable t={t} rows={[]} />}
      </Panel>
    </>
  );
}

/** Signals the transfers table to read again at once, after this page started or signed something. */
const changed = new Set<() => void>();
const transfersChanged = () => changed.forEach((now) => now());

function TransferForm({ api, t, routes, account }: { api: ApiClient; t: Translate; routes: BridgeRoute[]; account: string }) {
  const wallet = useWallet();
  const ids = useId();
  const froms = [...new Map(routes.map((r) => [r.from.chainId, r.from])).values()];
  const [from, setFrom] = useState(froms[0]!.chainId);
  const tos = [...new Map(routes.filter((r) => r.from.chainId === from).map((r) => [r.to.chainId, r.to])).values()];
  const [to, setTo] = useState(tos[0]?.chainId ?? 0);
  const tokens = [...new Set(routes.filter((r) => r.from.chainId === from && r.to.chainId === to).map((r) => r.token))];
  const [token, setToken] = useState(tokens[0] ?? '');
  const [amount, setAmount] = useState('');
  const [line, setLine] = useState<{ text: string; alert: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  async function review(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setLine(null);
    const nonce = await wallet.read('eth_getTransactionCount', [account, 'pending']);
    if (typeof nonce !== 'string' || !/^0x[0-9a-fA-F]+$/.test(nonce)) {
      setBusy(false);
      return setLine({ text: t('bridgeNoNonce'), alert: true });
    }
    // The intent is stored before the wallet is asked; the burn it answers carries the intent id.
    const started = await api.call(PROTOCOL_BRIDGE_TRANSFERS_START, {
      wallet: account,
      fromChainId: from,
      toChainId: to,
      asset: token,
      amount: amount.trim(),
      clientKey: transferKey({ from, to, asset: token, amount: amount.trim(), nonce: BigInt(nonce) }),
    });
    if (!started.ok) {
      setBusy(false);
      return setLine({ text: sentence(started.message), alert: true });
    }
    transfersChanged();
    const result = await signBurn(api, wallet.sendSequence, t, started.data);
    setBusy(false);
    setLine(result);
  }

  const select = (
    label: string,
    value: string | number,
    options: Array<{ value: string | number; label: string }>,
    set: (v: string) => void,
  ) => (
    <label className="lt-field">
      <span id={`${ids}-${label}`}>{label}</span>
      <select aria-labelledby={`${ids}-${label}`} value={String(value)} onChange={(event) => set(event.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={String(o.value)}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <form className="lt-stack" aria-label={t('bridgeForm')} onSubmit={(event) => void review(event)}>
      {select(
        t('hdr_from'),
        from,
        froms.map((c) => ({ value: c.chainId, label: c.name })),
        (v) => {
          const next = Number(v);
          setFrom(next);
          const nextTo = routes.find((r) => r.from.chainId === next)?.to.chainId ?? 0;
          setTo(nextTo);
          setToken(routes.find((r) => r.from.chainId === next && r.to.chainId === nextTo)?.token ?? '');
        },
      )}
      {select(
        t('hdr_to'),
        to,
        tos.map((c) => ({ value: c.chainId, label: c.name })),
        (v) => {
          const next = Number(v);
          setTo(next);
          setToken(routes.find((r) => r.from.chainId === from && r.to.chainId === next)?.token ?? '');
        },
      )}
      {select(
        t('bridgeToken'),
        token,
        tokens.map((s) => ({ value: s, label: s })),
        setToken,
      )}
      <Field
        label={t('bridgeAmount', { token })}
        value={amount}
        inputMode="decimal"
        autoComplete="off"
        onChange={(event) => setAmount(event.target.value)}
      />
      <p className="lt-hint">{t('bridgeLead')}</p>
      <Button type="submit" disabled={busy || amount.trim() === '' || token === ''}>
        {t('bridgeReview')}
      </Button>
      {line && <p role={line.alert ? 'alert' : 'status'}>{line.text}</p>}
    </form>
  );
}

type SendSequence = ReturnType<typeof useWallet>['sendSequence'];

/** One call on the sheet, as the wallet sends it; null when the person or the wallet ended it, with the line saying so. */
async function sendCall(send: SendSequence, t: Translate, title: string, step: string, call: BridgeCall, transfer: BridgeTransfer) {
  const sequence: Sequence = {
    title,
    chainId: call.chainId,
    steps: [{ label: step, request: { kind: 'transaction', to: call.to, data: call.data } }],
    facts: [
      { label: t('bridgeFactRoute'), value: `${transfer.from.name} → ${transfer.to.name}` },
      { label: t('bridgeFactAmount'), value: `${transfer.amount} ${transfer.token}` },
      { label: t('bridgeFactProvider'), value: transfer.provider ?? t('providerUnset') },
      { label: t('bridgeFactToken'), value: call.to },
    ],
  };
  const result = await send(sequence);
  if (result.status === 'rejected') return { hash: null, line: { text: t('bridgeRejected'), alert: false } };
  if (result.status === 'failed') return { hash: null, line: { text: t('bridgeFailed', { reason: result.message }), alert: true } };
  return { hash: result.hashes[result.hashes.length - 1]!, line: null };
}

async function signBurn(api: ApiClient, send: SendSequence, t: Translate, transfer: BridgeTransfer) {
  if (!transfer.burnCall) return { text: t('bridgeAlreadyBurned'), alert: false };
  const sent = await sendCall(send, t, t('bridgeBurnSteps'), t('bridgeBurnStep'), transfer.burnCall, transfer);
  if (!sent.hash) return sent.line!;
  const kept = await api.call(PROTOCOL_BRIDGE_TRANSFERS_BURN_SUBMITTED, { wallet: transfer.wallet, id: transfer.id, txHash: sent.hash });
  transfersChanged();
  // The burn is on chain either way: a row whose hash did not reach the service is found again from the chain.
  return kept.ok ? { text: t('bridgeBurnSent', { hash: sent.hash }), alert: false } : { text: sentence(kept.message), alert: true };
}

function Transfers({ api, t, account }: { api: ApiClient; t: Translate; account: string }) {
  const wallet = useWallet();
  const [state, setState] = useState<{ account: string; rows: BridgeTransfer[] | null; failure: string | null }>({
    account,
    rows: null,
    failure: null,
  });
  const [line, setLine] = useState<{ text: string; alert: boolean } | null>(null);
  const [signing, setSigning] = useState<string | null>(null);
  const rows = state.account === account ? state.rows : null;
  useBackoffPoll(
    `bridge-transfers:${account}`,
    async () => {
      const read = await api.call(PROTOCOL_BRIDGE_TRANSFERS_LIST, { wallet: account });
      if (read.ok) setState({ account, rows: read.data.transfers, failure: null });
      else setState((prior) => ({ account, rows: prior.account === account ? prior.rows : null, failure: sentence(read.message) }));
    },
    () => ((rows ?? []).some((r) => r.state !== 'minted') ? MOVING_POLL_MS : SETTLED_POLL_MS),
    (now) => {
      changed.add(now);
      return () => changed.delete(now);
    },
  );

  async function act(transfer: BridgeTransfer) {
    setSigning(transfer.id);
    setLine(null);
    if (transfer.state === 'awaiting_burn') setLine(await signBurn(api, wallet.sendSequence, t, transfer));
    else if (transfer.mintCall) {
      const sent = await sendCall(wallet.sendSequence, t, t('bridgeMintSteps'), t('bridgeMintStep'), transfer.mintCall, transfer);
      setLine(sent.line ?? { text: t('bridgeMintSent', { hash: sent.hash! }), alert: false });
      transfersChanged();
    }
    setSigning(null);
  }

  if (rows === null && state.failure === null) return <Loading />;
  return (
    <>
      {state.failure && (
        <p className="lt-refusal" role="alert">
          {state.failure}
        </p>
      )}
      <TransfersTable t={t} rows={rows ?? []} signing={signing} onAct={(row) => void act(row)} />
      {line && <p role={line.alert ? 'alert' : 'status'}>{line.text}</p>}
    </>
  );
}

const STATE_KEY = {
  awaiting_burn: 'bridgeStateAwaitingBurn',
  burn_submitted: 'bridgeStateBurnSubmitted',
  mint_ready: 'bridgeStateMintReady',
  minted: 'bridgeStateMinted',
} as const;

function TransfersTable({
  t,
  rows,
  signing = null,
  onAct,
}: {
  t: Translate;
  rows: BridgeTransfer[];
  signing?: string | null;
  onAct?: (row: BridgeTransfer) => void;
}) {
  return (
    <DataTable label={t('bridgeTransfers')} headers={[t('hdr_from'), t('hdr_to'), t('hdr_amount_sent'), t('hdr_state'), t('hdr_started')]}>
      {rows.length === 0 ? (
        <tr>
          <td colSpan={5}>
            <EmptyState title={t('bridgeTransfersEmpty')} />
          </td>
        </tr>
      ) : (
        rows.map((row) => (
          <tr key={row.id} data-state={row.state}>
            <td>{row.from.name}</td>
            <td>{row.to.name}</td>
            <td className="lt-mono">
              {row.amount} {row.token}
            </td>
            <td>
              <p>{t(STATE_KEY[row.state])}</p>
              {row.burnTx && (
                <p className="lt-hint lt-mono">
                  {t('bridgeBurnTx')} <code>{row.burnTx}</code>
                </p>
              )}
              {onAct && (row.state === 'awaiting_burn' || row.mintCall) && (
                <Button tone="secondary" disabled={signing !== null} onClick={() => onAct(row)}>
                  {row.state === 'awaiting_burn' ? t('bridgeSignBurn') : t('bridgeSignMint')}
                </Button>
              )}
            </td>
            <td>{new Date(row.createdAt).toLocaleString()}</td>
          </tr>
        ))
      )}
    </DataTable>
  );
}
