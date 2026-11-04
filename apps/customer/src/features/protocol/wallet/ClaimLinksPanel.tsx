import { useEffect, useMemo, useState } from 'react';
import { encodeFunctionData, formatUnits, parseAbi } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { ProtocolClaimLink } from '@intafaced/contracts/protocol-wallet-tx';
import { Button, DataTable, EmptyState, Field, Panel } from '../../../shared/ui';
import { usePreferences } from '../../../shared/preferences';
import { useResource } from '../../../shared/resource';
import { useApi } from '../../session/session';
import { createProtocolApi } from '../api';
import { walletCopy } from './copy';
import { APP_CHAIN_ID, shortAddress } from './eip1193';
import { RepresentationPanel } from './RepresentationPanel';
import { recordSent } from './sent-store';
import { signingGate, type SigningGate } from './signing-gate';
import { tokenLabel, toBaseUnits, toHexValue } from './transfer';
import { transfersCopy } from './transfers-copy';
import { usePolled } from './use-polled';
import { useWallet, waitMined } from './WalletProvider';

export const CLAIM_ESCROW_CALLS = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function create(address token, uint256 amount, address id, uint64 lifetime)',
  'function claim(address id, address to, bytes signature)',
  'function clawback(address id)',
]);

/** The claim link: the link key's address in the path, the key itself in the fragment, which browsers never send. */
export const claimLinkUrl = (origin: string, id: string, key: string) => `${origin}/wallet/claim/${id}#${key}`;

/** An amount in a token's own decimals, or base units when the token did not say. No float. */
export function linkAmount(link: Pick<ProtocolClaimLink, 'amount' | 'token'>): string {
  const name = link.token.name ?? link.token.symbol ?? shortAddress(link.token.address);
  const amount = link.token.decimals === null ? link.amount : formatUnits(BigInt(link.amount), link.token.decimals);
  return `${amount} ${name}`;
}

type Created = { url: string; amount: string; token: string; minutes: number };

/**
 * Send by link (D-swap-12): the person locks tokens in the claim-link escrow under a one-time key made here, in this
 * browser, and shares the link. The key never leaves the link: no service is sent it, and it is shown once. Their links
 * are listed from the escrow with each one's state; an expired, unclaimed one can be clawed back by its sender only.
 */
export function ClaimLinksPanel() {
  const { language } = usePreferences();
  const { t: tw } = walletCopy.forLocale(language);
  const { t, renderedLocale } = transfersCopy.forLocale(language);
  const wallet = useWallet();
  const transport = useApi();
  const api = useMemo(() => createProtocolApi(transport), [transport]);
  const config = useResource((signal) => api.claimLinkConfig(signal), 'claim-links:config');
  const pairs = useResource((signal) => api.ammPairs(signal), 'claim-links:pairs');
  const listed = pairs.resource.status === 'ready' ? pairs.resource.data.tokens : [];
  const address = wallet.status === 'connected' ? wallet.address : null;
  const links = usePolled(
    (signal) => (address ? api.claimLinkList(address, signal) : Promise.resolve(null)),
    `claim-links:${address}`,
    3000,
  );
  const [token, setToken] = useState('');
  const [amount, setAmount] = useState('');
  const [minutes, setMinutes] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [gate, setGate] = useState<{ needed: Extract<SigningGate, { kind: 'needed' }>; resume: () => void } | null>(null);

  const when = (seconds: number) => new Date(seconds * 1000).toLocaleString(renderedLocale, { dateStyle: 'medium', timeStyle: 'medium' });
  const bounds = config.resource.status === 'ready' ? config.resource.data : null;
  const minMinutes = bounds ? Math.ceil(bounds.minExpirySeconds / 60) : null;
  const maxMinutes = bounds ? Math.floor(bounds.maxExpirySeconds / 60) : null;
  const ready = wallet.status === 'connected' && address !== null && wallet.guard?.ok === true && bounds !== null;

  /** Runs `action` once the representation gate allows signing; shows the panel or the refusal otherwise. */
  const gated = async (action: () => Promise<void>) => {
    if (!address) return;
    const outcome = await signingGate(api, address);
    if (outcome.kind === 'refused') return setProblem(tw(outcome.key));
    if (outcome.kind === 'needed') return setGate({ needed: outcome, resume: () => void action() });
    await action();
  };

  const create = async () => {
    setProblem(null);
    setNotice(null);
    setCreated(null);
    if (!bounds || !address) return;
    const chosen = listed.find((entry) => entry.address === token);
    if (!chosen) return setProblem(tw('sendChooseToken'));
    const units = toBaseUnits(amount, chosen.decimals);
    if (units === null) return setProblem(t('linksAmountInvalid', { decimals: String(chosen.decimals) }));
    const wanted = /^[1-9]\d{0,6}$/.test(minutes.trim()) ? Number(minutes.trim()) : NaN;
    if (!(wanted * 60 >= bounds.minExpirySeconds && wanted * 60 <= bounds.maxExpirySeconds))
      return setProblem(t('linksExpiryInvalid', { min: String(minMinutes), max: String(maxMinutes) }));
    await gated(async () => {
      setBusy(true);
      // The one-time link key: made here, kept only in this function and the link shown below.
      const key = generatePrivateKey();
      const id = privateKeyToAccount(key).address;
      const name = tokenLabel(chosen, listed);
      const result = await wallet.sendSequence({
        title: t('linksSteps'),
        facts: [
          { label: t('linksFactEscrow'), value: bounds.escrow },
          { label: t('linksFactToken'), value: chosen.address },
        ],
        steps: [
          {
            label: t('linksStepApprove', { amount: amount.trim(), token: name }),
            request: {
              kind: 'transaction',
              to: chosen.address,
              data: encodeFunctionData({ abi: CLAIM_ESCROW_CALLS, functionName: 'approve', args: [bounds.escrow as `0x${string}`, units] }),
            },
          },
          {
            label: t('linksStepCreate', { amount: amount.trim(), token: name, expiry: `${wanted} min` }),
            request: {
              kind: 'transaction',
              to: bounds.escrow,
              value: toHexValue(0n),
              data: encodeFunctionData({
                abi: CLAIM_ESCROW_CALLS,
                functionName: 'create',
                args: [chosen.address as `0x${string}`, units, id, BigInt(wanted * 60)],
              }),
            },
          },
        ],
      });
      setBusy(false);
      if (result.status === 'sent') {
        for (const hash of result.hashes) recordSent(APP_CHAIN_ID, address, { hash, sentAt: Date.now(), kind: 'other', label: name });
        setCreated({ url: claimLinkUrl(window.location.origin, id, key), amount: amount.trim(), token: name, minutes: wanted });
        links.reload();
      } else if (result.status === 'rejected') setProblem(t('linksFailed', { message: tw('sendRejected') }));
      else setProblem(t('linksFailed', { message: result.message }));
    });
  };

  const clawBack = async (link: ProtocolClaimLink) => {
    setProblem(null);
    setNotice(null);
    if (!bounds || !address) return;
    await gated(async () => {
      const result = await wallet.sign({
        kind: 'transaction',
        to: bounds.escrow,
        data: encodeFunctionData({ abi: CLAIM_ESCROW_CALLS, functionName: 'clawback', args: [link.id as `0x${string}`] }),
      });
      if (result.status !== 'sent') {
        if (result.status === 'failed') setProblem(t('linksFailed', { message: result.message }));
        return;
      }
      recordSent(APP_CHAIN_ID, address, { hash: result.hash, sentAt: Date.now(), kind: 'other', label: t('linksClawBack') });
      const mined = await waitMined((hash) => wallet.read('eth_getTransactionReceipt', [hash]), result.hash, 120_000);
      if (mined.status === 'success') setNotice(t('linksClawedBack'));
      else setProblem(t('linksFailed', { message: mined.status === 'reverted' ? tw('seqReverted') : tw('seqNotMined') }));
      links.reload();
    });
  };

  const refusal =
    config.resource.status === 'failed'
      ? config.resource.failure.code === 'protocol.claim_escrow_unset'
        ? t('linksRefused_escrow_unset')
        : t('linksRefused_unread')
      : null;
  const headers = [t('linksAmountCol'), t('linksExpiryCol'), t('linksStatusCol'), t('linksActionCol')];
  const list = links.data?.links ?? [];

  return (
    <>
      {gate && (
        <RepresentationPanel
          address={gate.needed.address}
          status={gate.needed.status}
          api={api}
          onEnd={(end) => {
            const resume = gate.resume;
            setGate(null);
            if (end.kind === 'accepted') resume();
            else if (end.kind === 'region') setProblem(tw('permitRefused_region'));
            else if (end.kind === 'rejected') setProblem(t('linksFailed', { message: tw('sendRejected') }));
            else setProblem(t('linksFailed', { message: end.message }));
          }}
        />
      )}
      <Panel title={t('linksTitle')}>
        <p className="muted">{t('linksNote')}</p>
        {wallet.status !== 'connected' && <p className="muted">{tw('needsWallet')}</p>}
        {refusal && (
          <p role="note" data-code={config.resource.status === 'failed' ? config.resource.failure.code : undefined}>
            {refusal}
          </p>
        )}
        <form
          aria-label={t('linksForm')}
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <label className="field">
            <span id="claim-link-token-label">{t('linksToken')}</span>
            <select value={token} onChange={(event) => setToken(event.target.value)} aria-labelledby="claim-link-token-label">
              <option value="">{t('linksTokenChoose')}</option>
              {listed.map((entry) => (
                <option key={entry.address} value={entry.address}>
                  {tokenLabel(entry, listed)}
                </option>
              ))}
            </select>
          </label>
          <Field
            label={t('linksAmount')}
            hint={t('linksAmountHint')}
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
          <Field
            label={t('linksExpires')}
            hint={minMinutes !== null ? t('linksExpiresHint', { min: String(minMinutes), max: String(maxMinutes) }) : undefined}
            inputMode="numeric"
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
          />
          {problem && <p role="alert">{problem}</p>}
          <Button type="submit" disabled={!ready || busy}>
            {busy ? t('linksBusy') : t('linksCreate')}
          </Button>
        </form>
        {created && (
          <div data-claim-link-created>
            <p role="status">{t('linksCreated', { amount: created.amount, token: created.token, expiry: `${created.minutes} min` })}</p>
            <Field label={t('linksLink')} readOnly value={created.url} onFocus={(e) => e.target.select()} />
            <p className="muted">{t('linksLost')}</p>
          </div>
        )}
        {notice && <p role="status">{notice}</p>}
      </Panel>
      <Panel title={t('linksMine')}>
        <DataTable label={t('linksMine')} headers={headers}>
          {list.length === 0 ? (
            <tr>
              <td colSpan={headers.length}>
                <EmptyState title={t('linksNone')} />
              </td>
            </tr>
          ) : (
            list.map((link) => (
              <tr key={link.id} data-claim-link={link.id}>
                <td className="numeric">{linkAmount(link)}</td>
                <td>{when(link.expiresAt)}</td>
                <td data-state={link.state}>
                  {link.state === 'claimed'
                    ? t('linksState_claimed', { who: link.claimedBy ? shortAddress(link.claimedBy) : '' })
                    : t(`linksState_${link.state}`)}
                </td>
                <td>
                  {link.state === 'open' && (
                    <>
                      <Button variant="secondary" disabled aria-disabled="true">
                        {t('linksClawBack')}
                      </Button>{' '}
                      <span className="muted">{t('linksClawBackWhen', { expiry: when(link.expiresAt) })}</span>
                    </>
                  )}
                  {link.state === 'expired' && (
                    <Button variant="secondary" onClick={() => void clawBack(link)}>
                      {t('linksClawBack')}
                    </Button>
                  )}
                </td>
              </tr>
            ))
          )}
        </DataTable>
      </Panel>
    </>
  );
}
