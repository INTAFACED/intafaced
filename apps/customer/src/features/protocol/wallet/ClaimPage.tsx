import { useEffect, useMemo, useState } from 'react';
import { encodeAbiParameters, encodeFunctionData, keccak256, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { Button, EmptyState, Loading, Page, Panel } from '../../../shared/ui';
import { usePreferences } from '../../../shared/preferences';
import { useResource } from '../../../shared/resource';
import { useApi } from '../../session/session';
import { createProtocolApi } from '../api';
import '../protocol.css';
import { CLAIM_ESCROW_CALLS, linkAmount } from './ClaimLinksPanel';
import { walletCopy } from './copy';
import { APP_CHAIN_ID, shortAddress } from './eip1193';
import { RepresentationPanel } from './RepresentationPanel';
import { recordSent } from './sent-store';
import { signingGate, type SigningGate } from './signing-gate';
import { transfersCopy } from './transfers-copy';
import { useWallet, waitMined } from './WalletProvider';

const KEY = /^0x[0-9a-fA-F]{64}$/;

/** The link key from the fragment. Read here, in the browser; it is never put in a request. */
function linkKeyFrom(hash: string): Hex | null {
  const value = hash.startsWith('#') ? hash.slice(1) : hash;
  return KEY.test(value) ? (value as Hex) : null;
}

/** What the link key signs to pay `to`: keccak(abi.encode(escrow, chainId, id, to)), as a personal message. */
export function claimHash(escrow: string, chainId: number, id: string, to: string): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'uint256' }, { type: 'address' }, { type: 'address' }],
      [escrow as Hex, BigInt(chainId), id as Hex, to as Hex],
    ),
  );
}

/** The address of a link key; null for a value that is not a valid key (zero, or past the curve's order). */
function keyAddress(key: Hex): string | null {
  try {
    return privateKeyToAccount(key).address;
  } catch {
    return null;
  }
}

type Outcome = { kind: 'idle' } | { kind: 'busy' } | { kind: 'claimed'; to: string } | { kind: 'refused'; message: string };

/**
 * /wallet/claim/:id (D-swap-12): someone sent the person tokens by link. The page reads the link's amount, sender and
 * expiry from the escrow by its id (the key's address), connects the wallet the person wants the tokens in, signs the
 * claim for that wallet with the link key here in the browser, and asks the wallet to send it. A claimed, expired or
 * clawed-back link says so and offers nothing.
 */
export function ClaimPage({ id }: { id: string }) {
  const { language } = usePreferences();
  const { t: tw } = walletCopy.forLocale(language);
  const { t, renderedLocale } = transfersCopy.forLocale(language);
  const wallet = useWallet();
  const transport = useApi();
  const api = useMemo(() => createProtocolApi(transport), [transport]);
  const link = useResource((signal) => api.claimLinkGet(id, signal), `claim:${id.toLowerCase()}`);
  const config = useResource((signal) => api.claimLinkConfig(signal), 'claim:config');
  const [key, setKey] = useState<Hex | null>(() => (typeof window === 'undefined' ? null : linkKeyFrom(window.location.hash)));
  useEffect(() => {
    const read = () => setKey(linkKeyFrom(window.location.hash));
    window.addEventListener('hashchange', read);
    return () => window.removeEventListener('hashchange', read);
  }, []);
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'idle' });
  const [gate, setGate] = useState<Extract<SigningGate, { kind: 'needed' }> | null>(null);
  const when = (seconds: number) => new Date(seconds * 1000).toLocaleString(renderedLocale, { dateStyle: 'medium', timeStyle: 'medium' });
  const keyMatches = key !== null && keyAddress(key)?.toLowerCase() === id.toLowerCase();
  const read = link.resource.status === 'ready' ? link.resource.data.link : null;
  const escrow = config.resource.status === 'ready' ? config.resource.data : null;
  const connected = wallet.status === 'connected' && wallet.address !== null && wallet.guard?.ok === true;

  const claim = async () => {
    if (!read || !escrow || !key || !keyMatches || !wallet.address) return;
    const to = wallet.address;
    setOutcome({ kind: 'busy' });
    const outcomeOfGate = await signingGate(api, to);
    if (outcomeOfGate.kind === 'refused') return setOutcome({ kind: 'refused', message: tw(outcomeOfGate.key) });
    if (outcomeOfGate.kind === 'needed') {
      setOutcome({ kind: 'idle' });
      return setGate(outcomeOfGate);
    }
    const signature = await privateKeyToAccount(key).signMessage({ message: { raw: claimHash(escrow.escrow, escrow.chainId, id, to) } });
    const result = await wallet.sign({
      kind: 'transaction',
      to: escrow.escrow,
      data: encodeFunctionData({ abi: CLAIM_ESCROW_CALLS, functionName: 'claim', args: [id as Hex, to as Hex, signature] }),
    });
    if (result.status !== 'sent')
      return setOutcome(
        result.status === 'failed'
          ? { kind: 'refused', message: t('claimFailed', { message: result.message }) }
          : result.status === 'rejected'
            ? { kind: 'refused', message: t('claimFailed', { message: tw('sendRejected') }) }
            : { kind: 'idle' },
      );
    recordSent(APP_CHAIN_ID, to, { hash: result.hash, sentAt: Date.now(), kind: 'other', label: linkAmount(read) });
    const mined = await waitMined((hash) => wallet.read('eth_getTransactionReceipt', [hash]), result.hash, 120_000);
    if (mined.status === 'success') setOutcome({ kind: 'claimed', to });
    else
      setOutcome({
        kind: 'refused',
        message: t('claimFailed', { message: mined.status === 'reverted' ? tw('seqReverted') : tw('seqNotMined') }),
      });
  };

  let body;
  if (link.resource.status === 'loading') body = <Loading label={t('claimTitle')} />;
  else if (link.resource.status === 'failed')
    body = (
      <p role="alert" data-code={link.resource.failure.code}>
        {link.resource.failure.code === 'protocol.claim_link_not_found'
          ? t('claimNotFound')
          : link.resource.failure.code === 'protocol.claim_escrow_unset'
            ? t('linksRefused_escrow_unset')
            : t('linksRefused_unread')}
      </p>
    );
  else {
    const data = link.resource.data.link;
    const amount = linkAmount(data);
    const [value, ...name] = amount.split(' ');
    body = (
      <>
        <dl className="protocol-facts">
          <div>
            <dt>{t('claimAmount')}</dt>
            <dd className="numeric">{amount}</dd>
          </div>
          <div>
            <dt>{t('claimFrom')}</dt>
            <dd className="numeric">{data.sender}</dd>
          </div>
          <div>
            <dt>{t('claimExpires')}</dt>
            <dd>{when(data.expiresAt)}</dd>
          </div>
        </dl>
        {outcome.kind === 'claimed' ? (
          <p role="status">{t('claimed', { amount: value ?? '', token: name.join(' '), address: outcome.to })}</p>
        ) : data.state === 'claimed' ? (
          <p role="alert">{t('claimAlready')}</p>
        ) : data.state === 'expired' ? (
          <p role="alert">{t('claimExpired')}</p>
        ) : data.state === 'clawed_back' ? (
          <p role="alert">{t('claimTaken')}</p>
        ) : key === null ? (
          <p role="alert">{t('claimNoKey')}</p>
        ) : !keyMatches ? (
          <p role="alert">{t('claimWrongKey')}</p>
        ) : config.resource.status === 'failed' ? (
          <p role="alert" data-code={config.resource.failure.code}>
            {config.resource.failure.code === 'protocol.claim_escrow_unset' ? t('linksRefused_escrow_unset') : t('linksRefused_unread')}
          </p>
        ) : !connected ? (
          <>
            <p className="muted">{t('claimConnect')}</p>
            {wallet.wallets.length === 0 ? (
              <EmptyState title={tw('connectNone')} />
            ) : (
              <ul className="protocol-actions">
                {wallet.wallets.map((entry) => (
                  <li key={entry.info.uuid}>
                    <Button disabled={wallet.status === 'connecting'} onClick={() => void wallet.connect(entry)}>
                      {tw('connectButton', { name: entry.info.name })}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            {wallet.guard && !wallet.guard.ok && <Button onClick={() => void wallet.switchNetwork()}>{tw('switchNetwork')}</Button>}
          </>
        ) : (
          <>
            <p className="muted">
              {t('claimStep', { amount: value ?? '', token: name.join(' '), address: shortAddress(wallet.address!) })}
            </p>
            <Button disabled={outcome.kind === 'busy' || !escrow} onClick={() => void claim()}>
              {outcome.kind === 'busy' ? t('claimBusy') : t('claimButton', { amount: value ?? '', token: name.join(' ') })}
            </Button>
          </>
        )}
        {outcome.kind === 'refused' && <p role="alert">{outcome.message}</p>}
      </>
    );
  }

  return (
    <div className="legacy-room protocol-room" lang={walletCopy.forLocale(language).renderedLocale} data-route="wallet-claim">
      <Page title={t('claimTitle')} description={t('claimNote')}>
        {gate && (
          <RepresentationPanel
            address={gate.address}
            status={gate.status}
            api={api}
            onEnd={(end) => {
              setGate(null);
              if (end.kind === 'accepted') void claim();
              else if (end.kind === 'region') setOutcome({ kind: 'refused', message: tw('permitRefused_region') });
              else if (end.kind === 'rejected') setOutcome({ kind: 'refused', message: t('claimFailed', { message: tw('sendRejected') }) });
              else setOutcome({ kind: 'refused', message: t('claimFailed', { message: end.message }) });
            }}
          />
        )}
        <Panel title={t('claimTitle')}>{body}</Panel>
      </Page>
    </div>
  );
}
