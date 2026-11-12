import { useId, useState, type FormEvent } from 'react';
import type { ProtocolVenueBuild, ProtocolVenueSide } from '@intafaced/contracts/protocol-venue-funds';
import type { ApiResult } from '../../../shared/api';
import { useResource } from '../../../shared/resource';
import { Button, DataTable, Failure, Field, Loading, Panel } from '../../../shared/ui';
import type { createProtocolApi } from '../api';
import type { protocolCopy } from '../copy';
import { useWallet, waitMined, type Sequence } from '../wallet/WalletProvider';

type Translate = ReturnType<typeof protocolCopy.forLocale>['t'];
type Api = ReturnType<typeof createProtocolApi>;
type Kind = 'deposit' | 'withdraw';

/** How long the panel follows the last step before it says "Waiting for the network" and stops. */
const MINED_TIMEOUT_MS = 120_000;

/** A service refusal reads "protocol.<code>: <sentence>"; the person sees the sentence. */
const sentence = (message: string) => message.replace(/^protocol\.[a-z_.]+:\s*/, '');

/**
 * Move between the wallet and the trading venue (D-bridge-chain-04, J-dex-protocol-05 #9). The balances are the venue
 * contract's own, read from the chain; the panel builds the unsigned deposit (with its exact token approval when needed)
 * or withdrawal, shows it with its amounts and network, and sends nothing until the person continues in their wallet.
 * A withdrawal above the free amount is refused by svc-protocol, naming the free amount, before any call is built.
 */
export function VenueFunds({ api, t }: { api: Api; t: Translate }) {
  const wallet = useWallet();
  const account = wallet.status === 'connected' ? wallet.address : null;
  return (
    <Panel title={t('fundsTitle')}>
      <p className="muted">{t('fundsLead')}</p>
      <p className="muted">{t('fundsReserved')}</p>
      {account ? <Connected api={api} t={t} account={account} /> : <p className="muted">{t('fundsConnect')}</p>}
    </Panel>
  );
}

type Built =
  { status: 'idle' } | { status: 'building' } | { status: 'ready'; call: ProtocolVenueBuild } | { status: 'refused'; message: string };
type Sent = { status: 'idle' } | { status: 'sending' } | { status: 'done'; line: string };

function Connected({ api, t, account }: { api: Api; t: Translate; account: string }) {
  const wallet = useWallet();
  const balances = useResource((signal) => api.venueBalances(account, signal), `protocol-room:venue-funds:${account}`);
  const networks = useResource((signal) => api.networksList(signal), 'protocol-room:venue-funds:networks');
  const [kind, setKind] = useState<Kind>('deposit');
  const [side, setSide] = useState<ProtocolVenueSide>('base');
  const [amount, setAmount] = useState('');
  const [built, setBuilt] = useState<Built>({ status: 'idle' });
  const [sent, setSent] = useState<Sent>({ status: 'idle' });
  const group = useId();

  if (balances.resource.status === 'loading') return <Loading label={t('checking', { source: t('fundsBalances') })} />;
  if (balances.resource.status === 'failed') return <Failure result={balances.resource.failure} retry={balances.reload} />;
  const read = balances.resource.data;
  const asset = read.assets.find((a) => a.side === side)!;
  const symbolOf = (a: { token: { symbol: string | null; address: string } }) => a.token.symbol ?? a.token.address;
  const networkName = (chainId: number) =>
    (networks.resource.status === 'ready' ? networks.resource.data.networks.find((n) => n.chainId === chainId)?.name : null) ??
    t('fundsNetworkUnknown', { chainId: String(chainId) });

  const change = (next: () => void) => {
    next();
    setBuilt({ status: 'idle' });
    setSent({ status: 'idle' });
  };

  async function build(event: FormEvent) {
    event.preventDefault();
    if (built.status === 'building') return;
    setBuilt({ status: 'building' });
    setSent({ status: 'idle' });
    const input = { account, side, amount: amount.trim() };
    const result: ApiResult<ProtocolVenueBuild> =
      kind === 'deposit' ? await api.venueBuildDeposit(input) : await api.venueBuildWithdraw(input);
    setBuilt(result.ok ? { status: 'ready', call: result.data } : { status: 'refused', message: sentence(result.message) });
  }

  async function send(call: ProtocolVenueBuild) {
    setSent({ status: 'sending' });
    const sequence: Sequence = {
      title: t('fundsStepsTitle'),
      steps: call.calls.map((c) => ({ label: c.summary, request: { kind: 'transaction' as const, to: c.to, data: c.data } })),
      facts: [
        { label: t('fundsCallTo'), value: call.venue },
        { label: t('fundsAsset'), value: call.token.address },
      ],
    };
    const result = await wallet.sendSequence(sequence);
    const earlier = result.status !== 'sent' && result.sent.length > 0 ? ` ${t('fundsEarlier', { hashes: result.sent.join(', ') })}` : '';
    if (result.status === 'rejected') return setSent({ status: 'done', line: `${t('fundsRejected')}${earlier}` });
    if (result.status === 'failed') return setSent({ status: 'done', line: `${t('fundsFailed', { reason: result.message })}${earlier}` });
    const hash = result.hashes[result.hashes.length - 1]!;
    setSent({ status: 'done', line: t('fundsSent', { hash }) });
    const mined = await waitMined((h) => wallet.read('eth_getTransactionReceipt', [h]), hash, MINED_TIMEOUT_MS);
    if (mined.status === 'success') {
      setSent({ status: 'done', line: t('fundsMined', { hash }) });
      balances.reload();
    } else if (mined.status === 'reverted')
      setSent({ status: 'done', line: `${t('fundsFailed', { reason: hash })} ${t('fundsRecovery')}` });
  }

  return (
    <>
      <DataTable label={t('fundsBalances')} headers={[t('hdr_asset'), t('hdr_total'), t('hdr_reserved'), t('hdr_free')]}>
        {read.assets.map((a) => (
          <tr key={a.side}>
            <td>{symbolOf(a)}</td>
            <td className="numeric">{a.total}</td>
            <td className="numeric">{a.reserved}</td>
            <td className="numeric">{a.free}</td>
          </tr>
        ))}
      </DataTable>
      <p className="muted">{t('fundsAt', { block: read.blockNumber })}</p>
      <form className="protocol-quote protocol-venue-funds" aria-label={t('fundsForm')} onSubmit={(event) => void build(event)}>
        <fieldset>
          <legend>{t('fundsDirection')}</legend>
          {(['deposit', 'withdraw'] as const).map((k) => (
            <label key={k}>
              <input type="radio" name={`${group}-kind`} checked={kind === k} onChange={() => change(() => setKind(k))} />{' '}
              {k === 'deposit' ? t('fundsDeposit') : t('fundsWithdraw')}
            </label>
          ))}
        </fieldset>
        <fieldset>
          <legend>{t('fundsAsset')}</legend>
          {read.assets.map((a) => (
            <label key={a.side}>
              <input type="radio" name={`${group}-side`} checked={side === a.side} onChange={() => change(() => setSide(a.side))} />{' '}
              {symbolOf(a)}
            </label>
          ))}
        </fieldset>
        <Field
          label={t('fundsAmount', { symbol: symbolOf(asset) })}
          value={amount}
          inputMode="decimal"
          autoComplete="off"
          onChange={(event) => change(() => setAmount(event.target.value))}
        />
        <Button type="submit" disabled={amount.trim() === '' || built.status === 'building'}>
          {built.status === 'building' ? t('fundsBuilding') : t('fundsBuild')}
        </Button>
        {built.status === 'refused' && (
          <p className="protocol-refuse" role="alert">
            {built.message}
          </p>
        )}
      </form>
      <p className="muted">{t('fundsRecovery')}</p>
      {built.status === 'ready' && (
        <section aria-label={t('fundsCall')} className="protocol-quote__result">
          <h3>{t('fundsCall')}</h3>
          <p>
            {t('fundsCallLead', {
              kind: built.call.kind === 'deposit' ? t('fundsDeposit') : t('fundsWithdraw'),
              amount: built.call.amount,
              symbol: symbolOf(built.call),
              network: networkName(built.call.chainId),
              account: built.call.account,
            })}
          </p>
          <ol>
            {built.call.calls.map((c, index) => (
              <li key={index}>
                <p>{t('fundsCallStep', { n: String(index + 1), summary: c.summary })}</p>
                <dl className="protocol-facts">
                  <div>
                    <dt>{t('fundsCallTo')}</dt>
                    <dd className="numeric">{c.to}</dd>
                  </div>
                  <div>
                    <dt>{t('fundsCallData')}</dt>
                    <dd className="numeric">
                      <code>{c.data}</code>
                    </dd>
                  </div>
                </dl>
              </li>
            ))}
          </ol>
          <Button onClick={() => void send(built.call)} disabled={sent.status === 'sending'}>
            {sent.status === 'sending' ? t('fundsSending') : t('fundsSend')}
          </Button>
          {sent.status === 'done' && <p role="status">{sent.line}</p>}
        </section>
      )}
    </>
  );
}
