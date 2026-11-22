import { useMemo, useRef, useState } from 'react';
import { Button } from '@intafaced/ui';
import type { ProtocolEmbeddedWalletRecord } from '@intafaced/contracts/protocol-embedded-wallet';
import type { ApiClient } from '../../../shared/api';
import { useResource } from '../../../shared/resource';
import { createVenueAccountApi, plainDecimal, toTokenUnits, type VenueDepositRoute } from '../venue-wallet/venue-account-api';
import { usePolled } from '../wallet/use-polled';
import type { ClientFailure, EmbeddedWalletClient } from './provider-client';
import {
  assetWay,
  checkDeposit,
  depositTransaction,
  estimateNetworkFee,
  gasToken,
  paidNetworkFee,
  readNonce,
  readWalletFunds,
  type ChainRead,
  type DepositStop,
  type Read,
} from './venue-deposit';
import { venueDepositCopy } from './venue-deposit-copy';

/** How often the wallet and, after a send, the chain and the venue are read again. */
const READ_EVERY_MS = 3_000;

const time = (iso: string) => new Date(iso).toLocaleString();

/**
 * J-wallet-24 in the wallet room: Deposit to the venue from the person's own embedded wallet. Before anything is signed
 * it shows the chain and asset the venue's bridge takes, the venue's minimum and warning, and the wallet's balance of that
 * asset and of the chain's gas token, read from the chain with the block's time. A deposit with no gas, below the
 * minimum, or of an asset the bridge does not take is stopped before signing. A deposit that passes is one transfer,
 * signed at the wallet's provider after the passkey and sent once; then the chain's receipt (its network fee) and the
 * venue's own record of the deposit and its balance, with the venue's time. INTAFACED moves nothing; the ledger posts
 * nothing; no gas is paid for the person (the owner's gas-sponsor setting is blank, `wallet.gas_sponsor_unset`).
 */
export function VenueDeposit(props: {
  api: ApiClient;
  wallet: ProtocolEmbeddedWalletRecord;
  client: EmbeddedWalletClient | null;
  gasSponsorCode: string;
  providerFailure: (failure: ClientFailure) => string;
}) {
  const { api, wallet, client, gasSponsorCode, providerFailure } = props;
  const { t } = venueDepositCopy.useCopy();
  const owner = wallet.address.toLowerCase();
  const account = useMemo(() => createVenueAccountApi(api), [api]);
  const status = useResource((signal) => account.status(signal), `venue-deposit-status:${owner}`);
  const routes = useResource((signal) => account.depositRoutes(owner, signal), `venue-deposit-routes:${owner}`);
  const door = status.resource.status === 'ready' ? status.resource.data : null;
  const open = door && door.enabled && door.available ? door : null;
  const route: VenueDepositRoute | null = open?.deposit ?? null;
  const read: ChainRead = (method, params) => (client ? client.read(method, params) : Promise.resolve(null));

  const funds = usePolled(
    async () => (route && client ? { ok: true as const, data: await readWalletFunds(read, route, owner) } : null),
    `venue-deposit-funds:${owner}:${route?.token ?? ''}`,
    READ_EVERY_MS,
  );
  const [picked, setPicked] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [stop, setStop] = useState<DepositStop | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [busy, setBusy] = useState<'checking' | 'signing' | null>(null);
  const [sent, setSent] = useState<{ hash: string } | null>(null);
  const inFlight = useRef(false);

  const receipt = usePolled(
    async () => (sent && route ? { ok: true as const, data: await paidNetworkFee(read, sent.hash, route.chainId) } : null),
    `venue-deposit-receipt:${sent?.hash ?? ''}`,
    READ_EVERY_MS,
  );
  const credit = usePolled(
    async (signal) => {
      if (!sent || !route) return null;
      const [deposits, balances] = await Promise.all([account.deposits(owner, signal), account.balances(owner, signal)]);
      if (!deposits.ok) return deposits;
      if (!balances.ok) return balances;
      const mine = deposits.data.value.find((d) => d.txHash.toLowerCase() === sent.hash.toLowerCase()) ?? null;
      const row = balances.data.value.find((b) => b.asset === route.asset) ?? null;
      return { ok: true as const, data: { deposit: mine, figure: row?.total ?? '0', asOf: balances.data.asOf } };
    },
    `venue-deposit-credit:${sent?.hash ?? ''}`,
    READ_EVERY_MS,
  );

  const section = (body: React.ReactNode) => (
    <section aria-label={t('title')} data-panel="venue-deposit">
      <h2>{t('title')}</h2>
      {body}
    </section>
  );
  if (status.resource.status === 'failed') return section(<p role="alert">{t('venueDown')}</p>);
  if (!door) return section(<p role="status">{t('loading')}</p>);
  if (!route) return section(<p role="status">{t('noRoute')}</p>);

  const network = route.network ?? `chain ${route.chainId}`;
  const gas = gasToken(route.chainId);
  const shown = (r: Read, symbol: string) => (r.known ? `${plainDecimal(r.amount)} ${symbol}` : t('notKnown'));
  const listed = routes.resource.status === 'ready' ? routes.resource.data.value : [];
  const assets = [...new Set([route.asset, ...listed.map((r) => r.asset)])];
  const asset = picked ?? route.asset;
  const way = assetWay(asset, route, listed);
  const wallets = funds.data;

  async function deposit() {
    if (inFlight.current || !route || !client) return;
    inFlight.current = true;
    setStop(null);
    setSaid(null);
    setBusy('checking');
    try {
      // Read again now, so the checks use what the wallet holds at the press, not the last poll.
      const now = await readWalletFunds(read, route, owner);
      const units = toTokenUnits(amount, route.tokenDecimals);
      const fee: Read = units && units > 0n ? await estimateNetworkFee(read, route, owner, units) : { known: false };
      const checked = checkDeposit({ amount, route, funds: now, fee });
      if (!checked.ok) return setStop(checked.stop);
      const nonce = await readNonce(read, owner);
      if (nonce === null) return setSaid(t('nonceUnread'));
      setBusy('signing');
      const done = await client.sendTransaction(wallet.providerWalletId, depositTransaction(route, owner, checked.units, nonce));
      if (!done.ok) return setSaid(done.failure === 'chain' ? t('chainRefused') : providerFailure(done.failure));
      setSent({ hash: done.data.hash });
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }

  const stopped = stop ? stopText(stop) : null;
  function stopText(s: DepositStop) {
    switch (s.kind) {
      case 'amount':
        return <p role="alert">{t('stopAmount', { asset: route!.asset, decimals: String(route!.tokenDecimals) })}</p>;
      case 'below_minimum':
        return (
          <p role="alert" data-deposit-stop="below_minimum">
            {t('stopMinimum', { minimum: plainDecimal(s.minimum), asset: route!.asset })}
          </p>
        );
      case 'balance_unknown':
        return <p role="alert">{t('stopUnread')}</p>;
      case 'not_enough':
        return <p role="alert">{t('stopNotEnough', { balance: plainDecimal(s.balance), asset: route!.asset })}</p>;
      case 'no_gas':
      case 'gas_short':
        return (
          <div role="alert" data-deposit-stop={s.kind}>
            <p>
              {s.kind === 'no_gas'
                ? t('stopNoGas', { gas: gas.symbol, network })
                : t('stopGasShort', { gas: gas.symbol, balance: plainDecimal(s.balance) })}
            </p>
            <dl>
              <div>
                <dt>{t('feeEstimate')}</dt>
                <dd data-testid="deposit-fee-estimate">{shown(s.fee, gas.symbol)}</dd>
              </div>
            </dl>
            <p>{t('howToAdd', { gas: gas.symbol, network, address: wallet.address })}</p>
            <p data-gas-sponsor={gasSponsorCode}>
              {t('noSponsor')} <code>{gasSponsorCode}</code>
            </p>
            <p>{t('nothingSigned')}</p>
          </div>
        );
    }
  }

  const paid = receipt.data;
  const venueRead = credit.data;
  return section(
    <>
      <p>{t('intro')}</p>
      <dl>
        <div>
          <dt>{t('termChain')}</dt>
          <dd data-testid="deposit-chain">{network}</dd>
        </div>
        <div>
          <dt>{t('termAsset')}</dt>
          <dd data-testid="deposit-asset">{route.asset}</dd>
        </div>
        <div>
          <dt>{t('termMinimum')}</dt>
          <dd data-testid="deposit-minimum">{route.minimum ? `${plainDecimal(route.minimum)} ${route.asset}` : t('notPublished')}</dd>
        </div>
        <div>
          <dt>{t('termWarning')}</dt>
          <dd data-testid="deposit-warning">{route.warning ?? t('notPublished')}</dd>
        </div>
      </dl>
      <h3>{t('walletTitle', { network })}</h3>
      {wallets && wallets.asOf ? (
        <dl>
          <div>
            <dt>{t('walletToken', { asset: route.asset })}</dt>
            <dd data-testid="wallet-token-balance">{shown(wallets.token, route.asset)}</dd>
          </div>
          <div>
            <dt>{t('walletGas', { gas: gas.symbol })}</dt>
            <dd data-testid="wallet-gas-balance">{shown(wallets.gas, gas.symbol)}</dd>
          </div>
          <div>
            <dt>{t('walletAsOf')}</dt>
            <dd>
              <time dateTime={wallets.asOf} data-testid="wallet-balances-as-of">
                {time(wallets.asOf)}
              </time>
            </dd>
          </div>
        </dl>
      ) : wallets ? (
        <p role="status">{t('walletUnread')}</p>
      ) : null}
      {sent ? (
        <div data-deposit-sent>
          <h3>{t('sentTitle')}</h3>
          <dl>
            <div>
              <dt>{t('sentHash')}</dt>
              <dd data-testid="deposit-hash">{sent.hash}</dd>
            </div>
            {paid ? (
              <div>
                <dt>{t('networkFee')}</dt>
                <dd data-testid="deposit-network-fee">{shown(paid.fee, gas.symbol)}</dd>
              </div>
            ) : null}
          </dl>
          {!paid ? <p role="status">{t('sentWaiting', { network })}</p> : null}
          {credit.failure ? <p role="alert">{t('creditUnread', { message: credit.failure.message })}</p> : null}
          {paid?.status === 'reverted' ? <p role="alert">{t('reverted', { asset: route.asset })}</p> : null}
          {venueRead?.deposit?.status === 'confirming' ? (
            <p role="status" data-deposit-status="confirming">
              {t('confirming', {
                confirmations: String(venueRead.deposit.confirmations),
                required: String(venueRead.deposit.required),
              })}
            </p>
          ) : null}
          {venueRead?.deposit?.status === 'not_credited' ? <p role="alert">{t('notCredited')}</p> : null}
          {venueRead?.deposit?.status === 'credited' ? (
            <div role="status" data-deposit-status="credited">
              <p>{t('credited')}</p>
              <dl>
                <div>
                  <dt>{t('venueFigure', { asset: route.asset })}</dt>
                  <dd data-testid="deposit-venue-figure">
                    {plainDecimal(venueRead.figure)} {route.asset}
                  </dd>
                </div>
                <div>
                  <dt>{t('venueAsOf')}</dt>
                  <dd>
                    <time dateTime={venueRead.asOf} data-testid="deposit-venue-as-of">
                      {time(venueRead.asOf)}
                    </time>
                  </dd>
                </div>
              </dl>
            </div>
          ) : null}
        </div>
      ) : (
        <>
          <label>
            {t('pickAsset')}{' '}
            <select
              value={asset}
              onChange={(e) => {
                setPicked(e.target.value);
                setStop(null);
                setSaid(null);
              }}
            >
              {assets.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </label>
          {routes.resource.status === 'failed' ? (
            <p role="alert">{t('routesUnread', { message: routes.resource.failure.message })}</p>
          ) : null}
          {way.kind === 'other_route' ? (
            <div role="status" data-asset-way="other_route">
              <p>{t('wayOther', { asset, network, route: way.network })}</p>
              {way.how ? <p>{t('wayOtherHow', { how: way.how })}</p> : null}
            </div>
          ) : null}
          {way.kind === 'not_offered' ? (
            <p role="status" data-asset-way="not_offered">
              {t('wayNone', { asset, network })}
            </p>
          ) : null}
          {way.kind === 'bridge' ? (
            <>
              {' '}
              <label>
                {t('amount', { asset: route.asset })}{' '}
                <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
              </label>{' '}
              <Button variant="primary" disabled={busy !== null || !client} onClick={() => void deposit()}>
                {t('deposit')}
              </Button>
              {busy ? <p role="status">{busy === 'checking' ? t('checking') : t('signing')}</p> : null}
              {stopped}
              {said ? <p role="alert">{said}</p> : null}
            </>
          ) : null}
        </>
      )}
      {open?.test ? <p data-deposit-test-label>{t('testVenue')}</p> : null}
    </>,
  );
}
