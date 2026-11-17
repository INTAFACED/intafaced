import { useEffect, useMemo, useState } from 'react';
import { decodeEventLog, parseAbi } from 'viem';
import { Button } from '@intafaced/ui';
import type { ProtocolEscrowBuildInput, ProtocolEscrowDeal } from '@intafaced/contracts/protocol-escrow';
import { useResource } from '../../../shared/resource';
import { useApi } from '../../session/session';
import { createProtocolApi } from '../../protocol/api';
import { shortAddress } from '../../protocol/wallet/eip1193';
import { useWallet, WalletProvider, type SequenceResult } from '../../protocol/wallet/WalletProvider';
import { PayDetails, PayTime } from '../components';
import type { PersonalPayApi } from '../pay-api';
import type { ContractEscrowOffer, Offer, Trade } from '../schemas';
import { contractEscrowCopy } from './contract-escrow-copy';

/**
 * RC-p2p-02 (J-p2p-21): the contract escrow beside the ledger escrow.
 *
 * On the order form the buyer of a sell ad chooses who holds the seller's coins: the ledger (as before) or the
 * SovereignEscrow contract on the TEST network, which pays the buyer's own connected wallet on release. The choice is
 * made here and fixed once the order is placed. Contract stays visible on every order and is disabled with its real
 * blocker when it cannot be used. Mainnet is always shown switched off (`audit.external`).
 *
 * On the order page the parties act on the contract from their own wallets: the seller opens and funds the deal, and
 * later releases, refunds before payment, or opens a dispute; the buyer may open a dispute; anyone may settle a dispute
 * past its window by the refund agreed at open. Each call is built by svc-protocol, signed in the wallet, and then the
 * order reads the deal from the chain (svc-p2p checks it). Nothing here moves money in the ledger.
 */

export type EscrowChoice = { kind: 'ledger' } | { kind: 'contract'; buyerWallet: string };

const DEAL_OPENED = parseAbi([
  'event DealOpened(uint256 indexed dealId, address indexed seller, address indexed buyer, address token, uint128 amount, address arbiter, uint8 timeoutDisposition, uint32 disputeWindow)',
]);

/** The order form's escrow choice. Its own wallet connection, so the buyer's address is the wallet they connected. */
export function ContractEscrowChoice(props: {
  pay: PersonalPayApi;
  offer: Offer;
  buyerTakes: boolean;
  onChange: (choice: EscrowChoice) => void;
}) {
  return (
    <WalletProvider>
      <EscrowChoiceInner {...props} />
    </WalletProvider>
  );
}

function EscrowChoiceInner({
  pay,
  offer,
  buyerTakes,
  onChange,
}: {
  pay: PersonalPayApi;
  offer: Offer;
  buyerTakes: boolean;
  onChange: (choice: EscrowChoice) => void;
}) {
  const { t } = contractEscrowCopy.useCopy();
  const wallet = useWallet();
  const escrow = useResource((signal) => pay.contractEscrow(offer.asset, signal), `pay:contract-escrow:${offer.asset}`);
  const [kind, setKind] = useState<'ledger' | 'contract'>('ledger');
  const status = escrow.resource;
  const terms: ContractEscrowOffer | null = status.status === 'ready' ? status.data : null;
  const address = wallet.status === 'connected' && wallet.guard?.ok ? wallet.address : null;
  const blocked = !buyerTakes
    ? t('escrowContractBuyerOnly')
    : status.status === 'loading'
      ? t('escrowContractChecking')
      : status.status === 'failed'
        ? t('escrowContractUnread', { reason: status.failure.message || status.failure.code || '' })
        : terms && !terms.available
          ? t('escrowContractUnavailable', { reason: terms.reason ?? terms.blocker ?? '' })
          : null;
  useEffect(() => {
    onChange(kind === 'contract' && !blocked && address ? { kind: 'contract', buyerWallet: address } : { kind: 'ledger' });
  }, [kind, blocked, address]);
  const network = terms?.network?.label ?? '';
  return (
    <fieldset className="field" data-testid="take-escrow-type">
      <legend>{t('escrowType')}</legend>
      <p className="muted">{t('escrowChosenAtOrder')}</p>
      <label>
        <input type="radio" name="escrow-type" checked={kind === 'ledger'} onChange={() => setKind('ledger')} />{' '}
        <span>{t('escrowLedger')}</span> <small className="muted">{t('escrowLedgerHint')}</small>
      </label>
      <label>
        <input
          type="radio"
          name="escrow-type"
          checked={kind === 'contract'}
          disabled={blocked !== null}
          onChange={() => setKind('contract')}
        />{' '}
        <span>{t('escrowContract')}</span> <small className="muted">{network ? t('escrowContractHint', { network }) : null}</small>
      </label>
      {blocked ? (
        <small className="muted" data-testid="take-escrow-contract-blocker" role="note">
          {blocked}
        </small>
      ) : null}
      {terms ? (
        <PayDetails
          values={[
            [
              t('network'),
              <span data-testid="take-escrow-networks">
                {network} · {t('networkMainnet')}: <span data-testid="take-escrow-mainnet">{t('mainnetOff')}</span>
              </span>,
            ],
          ]}
        />
      ) : null}
      {kind === 'contract' && !blocked ? (
        address ? (
          <p className="muted" data-testid="take-escrow-wallet">
            {t('escrowWallet', { address })}
          </p>
        ) : (
          <div className="stack">
            <p className="muted">{t('escrowConnect')}</p>
            {wallet.wallets.length === 0 ? (
              <p className="muted">{t('escrowNoWallet')}</p>
            ) : (
              wallet.wallets.map((entry) => (
                <Button
                  key={entry.info.uuid}
                  type="button"
                  variant="secondary"
                  disabled={wallet.status === 'connecting'}
                  onClick={() => void wallet.connect(entry)}
                >
                  {t('escrowConnectButton', { name: entry.info.name })}
                </Button>
              ))
            )}
            {wallet.guard && !wallet.guard.ok ? (
              <Button type="button" variant="secondary" onClick={() => void wallet.switchNetwork()}>
                {t('escrowSwitchNetwork')}
              </Button>
            ) : null}
          </div>
        )
      ) : null}
    </fieldset>
  );
}

/** The order page's contract escrow: what holds the coins, the deal as the chain has it, and the parties' wallet actions. */
export function ContractEscrowPanel(props: { pay: PersonalPayApi; trade: Trade; userId: string | null; reload: () => void }) {
  return (
    <WalletProvider>
      <ContractEscrowInner {...props} />
    </WalletProvider>
  );
}

const STATE_KEY = {
  open: 'stateOpen',
  locked: 'stateLocked',
  released: 'stateReleased',
  refunded: 'stateRefunded',
} as const;

function ContractEscrowInner({
  pay,
  trade,
  userId,
  reload,
}: {
  pay: PersonalPayApi;
  trade: Trade;
  userId: string | null;
  reload: () => void;
}) {
  const { t } = contractEscrowCopy.useCopy();
  const transport = useApi();
  const protocol = useMemo(() => createProtocolApi(transport), [transport]);
  const wallet = useWallet();
  const terms = trade.contract!;
  const offer = useResource((signal) => pay.contractEscrow(trade.asset, signal), `pay:contract-escrow:${trade.asset}`);
  const dealId = terms.dealId;
  const deal = useResource(
    (signal) =>
      dealId
        ? protocol.escrowDeal(dealId, signal)
        : Promise.resolve({ ok: false as const, reason: 'not_supported' as const, code: 'p2p.deal_not_attached', message: '' }),
    `pay:contract-deal:${trade.id}:${dealId}:${trade.status}`,
  );
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const seller = userId === trade.sellerId;
  const buyer = userId === trade.buyerId;
  const network = offer.resource.status === 'ready' ? (offer.resource.data.network?.label ?? '') : '';
  const escrowAddress = offer.resource.status === 'ready' ? (offer.resource.data.network?.escrow ?? null) : null;
  const chainDeal: ProtocolEscrowDeal | null = deal.resource.status === 'ready' ? deal.resource.data : null;
  const connected = wallet.status === 'connected' && wallet.guard?.ok ? wallet.address : null;

  const failed = (result: SequenceResult): string | null =>
    result.status === 'sent' ? null : result.status === 'rejected' ? 'rejected in the wallet' : result.message;

  /** Builds `inputs` with svc-protocol and sends them as one wallet sequence. */
  const send = async (
    title: string,
    steps: Array<{ label: string; input: ProtocolEscrowBuildInput }>,
  ): Promise<SequenceResult | string> => {
    const built = [];
    for (const step of steps) {
      const call = await protocol.escrowBuild(step.input);
      if (!call.ok) return call.message || call.code || 'the call could not be built';
      built.push({ label: step.label, request: { kind: 'transaction' as const, to: call.data.to, data: call.data.data } });
    }
    return wallet.sendSequence({ title, steps: built, ...(escrowAddress ? { facts: [{ label: t('fact'), value: escrowAddress }] } : {}) });
  };

  const act = async (work: () => Promise<string | null>) => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    try {
      const why = await work();
      if (why) setProblem(t('failed', { reason: why }));
    } finally {
      setBusy(false);
      deal.reload();
      reload();
    }
  };

  const sync = async () => {
    const synced = await pay.syncContractDeal(trade.id);
    return synced.ok ? null : synced.message || synced.code || 'the order could not read the deal';
  };

  /** The seller opens the deal paying the buyer's wallet, reads its id from the chain, locks the coins, and attaches it. */
  const fund = () =>
    act(async () => {
      const opened = await send(t('fundSteps'), [
        { label: t('fundApprove', { amount: terms.units }), input: { action: 'approve', token: terms.token, amount: terms.units } },
        {
          label: t('fundOpen'),
          input: {
            action: 'open',
            buyer: terms.buyerWallet,
            token: terms.token,
            amount: terms.units,
            disputeWindowSeconds: terms.disputeWindowSeconds,
            timeout: 'refund_seller',
          },
        },
      ]);
      if (typeof opened === 'string') return opened;
      const why = failed(opened);
      if (why || opened.status !== 'sent') return why;
      const openHash = opened.hashes[opened.hashes.length - 1]!;
      type Receipt = { logs?: Array<{ address: string; topics: string[]; data: string }>; status?: string };
      let receipt = null as Receipt | null;
      for (let tries = 0; tries < 120 && !receipt?.status; tries++) {
        receipt = (await wallet.read('eth_getTransactionReceipt', [openHash])) as Receipt | null;
        if (!receipt?.status) await new Promise((resolve) => setTimeout(resolve, 500));
      }
      let newDeal: string | null = null;
      for (const log of receipt?.logs ?? []) {
        if (escrowAddress && log.address.toLowerCase() !== escrowAddress.toLowerCase()) continue;
        try {
          const decoded = decodeEventLog({ abi: DEAL_OPENED, topics: log.topics as [`0x${string}`], data: log.data as `0x${string}` });
          if (decoded.args) newDeal = decoded.args.dealId.toString();
        } catch {
          /* another event */
        }
      }
      if (!newDeal) return t('noDealId');
      const locked = await send(t('fundLockSteps'), [
        { label: t('fundLock', { dealId: newDeal }), input: { action: 'lock', dealId: newDeal } },
      ]);
      if (typeof locked === 'string') return locked;
      const lockWhy = failed(locked);
      if (lockWhy || locked.status !== 'sent') return lockWhy;
      for (let tries = 0; tries < 120; tries++) {
        const mined = (await wallet.read('eth_getTransactionReceipt', [locked.hashes[0]])) as { status?: string } | null;
        if (mined?.status) break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      const attached = await pay.attachContractDeal(trade.id, newDeal);
      return attached.ok ? null : attached.message || attached.code || 'the deal could not be attached';
    });

  /** One deal call from the party's wallet, then the order reads the deal again. */
  const onDeal = (action: 'release' | 'refund' | 'dispute' | 'settleTimeout', label: string) =>
    act(async () => {
      if (!dealId) return t('dealWaiting');
      const sent = await send(label, [{ label, input: { action, dealId } }]);
      if (typeof sent === 'string') return sent;
      const why = failed(sent);
      if (why || sent.status !== 'sent') return why;
      for (let tries = 0; tries < 120; tries++) {
        const mined = (await wallet.read('eth_getTransactionReceipt', [sent.hashes[0]])) as { status?: string } | null;
        if (mined?.status) break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      return sync();
    });

  const stateText = chainDeal
    ? chainDeal.state === 'disputed'
      ? t('stateDisputed', { time: chainDeal.disputeDeadline ? new Date(chainDeal.disputeDeadline * 1000).toISOString() : '' })
      : t(STATE_KEY[chainDeal.state])
    : null;
  const wrongWallet =
    seller && connected && terms.sellerWallet && connected.toLowerCase() !== terms.sellerWallet.toLowerCase() ? terms.sellerWallet : null;
  const settleable =
    chainDeal?.state === 'disputed' && chainDeal.disputeDeadline !== null && chainDeal.chainTime >= chainDeal.disputeDeadline;

  return (
    <section className="stack" data-testid="order-contract-escrow" aria-label={t('orderEscrow')}>
      <PayDetails
        values={[
          [
            t('orderEscrow'),
            <span data-testid="order-escrow-kind">
              {t('orderEscrowContract', { network })} · {t('orderTestLabel')}
            </span>,
          ],
          [
            t('network'),
            <span data-testid="order-escrow-networks">
              {network} · {t('networkMainnet')}: <span data-testid="order-escrow-mainnet">{t('mainnetOff')}</span>
            </span>,
          ],
          [t('dealId'), <span data-testid="order-deal-id">{dealId ? `#${dealId}` : t('dealWaiting')}</span>],
          ...(stateText
            ? ([[t('dealState'), <span data-testid="order-deal-state">{stateText}</span>]] as [string, React.ReactNode][])
            : []),
          ...(chainDeal
            ? ([[t('dealHeld'), <span data-testid="order-deal-held">{chainDeal.held}</span>]] as [string, React.ReactNode][])
            : []),
          [t('ledgerHeld'), <span data-testid="order-ledger-held">{t('ledgerHeldNone')}</span>],
          [t('disputeWindow'), t('disputeWindowValue', { seconds: String(terms.disputeWindowSeconds) })],
        ]}
      />
      {deal.resource.status === 'failed' && dealId ? (
        <p role="alert">{t('dealUnread', { reason: deal.resource.failure.message || deal.resource.failure.code || '' })}</p>
      ) : null}
      {seller && trade.status === 'fiat_sent' ? (
        <p className="muted" data-testid="order-contract-seller-paid">
          {t('sellerPaid')}
        </p>
      ) : null}
      {(seller || buyer) && !['released', 'cancelled'].includes(trade.status) ? (
        !connected ? (
          <div className="stack">
            {wallet.wallets.map((entry) => (
              <Button
                key={entry.info.uuid}
                variant="secondary"
                disabled={wallet.status === 'connecting'}
                onClick={() => void wallet.connect(entry)}
              >
                {t('escrowConnectButton', { name: entry.info.name })}
              </Button>
            ))}
            {wallet.wallets.length === 0 ? <p className="muted">{t('escrowNoWallet')}</p> : null}
          </div>
        ) : wrongWallet ? (
          <p role="alert">{t('wrongWallet', { address: shortAddress(wrongWallet) })}</p>
        ) : (
          <div className="actions" data-testid="order-contract-actions">
            {seller && trade.status === 'created' ? (
              <Button variant="primary" disabled={busy} onClick={() => void fund()}>
                {busy ? t('busy') : t('fund')}
              </Button>
            ) : null}
            {seller && trade.status === 'fiat_sent' && chainDeal?.state === 'locked' ? (
              <Button variant="primary" disabled={busy} onClick={() => void onDeal('release', t('releaseStep', { dealId: dealId! }))}>
                {t('release')}
              </Button>
            ) : null}
            {seller && trade.status === 'escrowed' && chainDeal?.state === 'locked' ? (
              <Button variant="secondary" disabled={busy} onClick={() => void onDeal('refund', t('refundStep', { dealId: dealId! }))}>
                {t('refund')}
              </Button>
            ) : null}
            {(seller || buyer) && trade.status === 'fiat_sent' && chainDeal?.state === 'locked' ? (
              <Button variant="secondary" disabled={busy} onClick={() => void onDeal('dispute', t('disputeStep', { dealId: dealId! }))}>
                {t('dispute')}
              </Button>
            ) : null}
            {settleable ? (
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => void onDeal('settleTimeout', t('settleStep', { dealId: dealId! }))}
              >
                {t('settle')}
              </Button>
            ) : null}
            {dealId ? (
              <Button variant="ghost" disabled={busy} onClick={() => void act(sync)}>
                {t('sync')}
              </Button>
            ) : null}
          </div>
        )
      ) : null}
      {problem ? <p role="alert">{problem}</p> : null}
      {trade.escrowedAt ? (
        <p className="muted">
          <PayTime value={trade.escrowedAt} />
        </p>
      ) : null}
    </section>
  );
}
