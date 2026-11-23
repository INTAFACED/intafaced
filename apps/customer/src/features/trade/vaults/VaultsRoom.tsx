// volt-room: /trade/vaults
import { useState, type ReactNode } from 'react';
import { Button, Field } from '@intafaced/ui/lit';
import { MonitorTemplate, type RoomState } from '@intafaced/ui/lit/templates';
import { displayAmount, formatAmount, parseAmount } from '../../../shared/money';
import { ScrollTable, Waiting } from '../../more';
import { usePolled } from '../../protocol';
import { useSession } from '../../session';
import { useVenueMode } from '../use-venue-mode';
import { draftId, keys, type VenueUp, type VenueVault, type VenueVaultHoldings } from '../venue-api';
import { VENUE_POLL_MS } from '../venue/poll';
import { useOwner, useVenueActions, useVenueApi, type ActionResult } from '../venue/VenueKit';
import { TestMark, VenueFrame, WalletBar } from '../venue/volt/VoltVenue';
import { vaultsCopy } from './vaults-copy';

/**
 * Venue vaults (`/trade/vaults`, J-derivatives-31): the vaults the venue lists, each with its lock-up, leader profit share,
 * value and past return as the venue publishes them, and the person's own positions in them with each lock-up's end. A
 * deposit and a withdrawal are each one signed venue transfer, sent once under its own key; before a lock-up ends the
 * venue refuses the withdrawal at prepare, so nothing is signed. Every figure is the venue's own; one it doesn't publish
 * reads "not published". The vault and the money in it are the venue's, and the ledger posts nothing.
 */

type T = ReturnType<typeof vaultsCopy.useCopy>['t'];
const USDC = 'USDC';
const DAY_S = 86_400;

export function VaultsRoom() {
  const { t } = vaultsCopy.useCopy();
  const mode = useVenueMode();
  const { userId } = useSession();
  const off = (state: RoomState) => (
    <MonitorTemplate title={t('title')} state={state} mode="pro" figures={[]} explain={<p className="lt-hint">{t('eyebrow')}</p>} />
  );
  if (!userId)
    return off({
      kind: 'empty',
      title: t('signedOutTitle'),
      body: t('signedOutBody'),
      action: { label: t('signIn'), href: `/login?redirect=${encodeURIComponent(location.pathname + location.search)}` },
    });
  if (mode.mode === 'checking') return off({ kind: 'loading' });
  if (mode.mode === 'off' || !mode.status.available)
    return off({ kind: 'refused', refusal: { variant: 'parked', title: t('title'), body: t('venueOff') } });
  const status = mode.status;
  return (
    <VenueFrame mode={mode}>
      <MonitorTemplate
        title={t('title')}
        description={t('lead')}
        state={{ kind: 'ready' }}
        mode="pro"
        figures={[]}
        actions={
          <div className="lt-stack">
            <TestMark test={status.test} />
            <WalletBar />
          </div>
        }
        panels={
          <div className="lt-stack">
            <Room status={status} />
          </div>
        }
        explain={
          <div className="lt-stack">
            <p className="lt-hint">{t('eyebrow')}</p>
            <p className="lt-hint">{t('ledgerNote')}</p>
          </div>
        }
      />
    </VenueFrame>
  );
}

function AsOf({ iso, t }: { iso: string | null | undefined; t: T }) {
  if (!iso) return <span data-as-of="">{t('asOfUnknown')}</span>;
  return <span data-as-of={iso}>{t('asOf', { time: new Date(iso).toLocaleString() })}</span>;
}

/** A whole number of basis points as a percent with two places, sign kept (`-35` → `-0.35`). */
function bpsPercent(bps: number): string {
  const sign = bps < 0 ? '-' : '';
  const abs = Math.abs(bps);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** A lock-up in seconds in words: whole days, else whole hours; `null` is not published. */
function lockUpText(t: T, seconds: number | null): string {
  if (seconds === null) return t('notPublished');
  if (seconds === DAY_S) return t('oneDay');
  if (seconds % DAY_S === 0) return t('days', { n: String(seconds / DAY_S) });
  return t('hours', { n: String(Math.round(seconds / 3600)) });
}

const shortAddress = (a: string) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
const freeOf = (rows: readonly { asset: string; free: string }[] | null | undefined) => rows?.find((r) => r.asset === USDC)?.free ?? '0';

function Room({ status }: { status: VenueUp }) {
  const { t } = vaultsCopy.useCopy();
  const api = useVenueApi();
  const owner = useOwner();
  const venue = status.venue.displayName;
  const [revision, setRevision] = useState(0);
  const [form, setForm] = useState<{ vault: VenueVault; direction: 'deposit' | 'withdraw'; amount: string } | null>(null);
  const list = usePolled((signal) => api.vaults(signal), `vaults:list:${revision}`, VENUE_POLL_MS);
  const holdings = usePolled(
    (signal) => (owner ? api.vaultHoldings(owner, signal) : Promise.resolve(null)),
    `vaults:holdings:${owner ?? ''}:${revision}`,
    VENUE_POLL_MS,
  );
  const vaults = list.data?.value ?? [];
  const byAddress = new Map(vaults.map((v) => [v.address, v]));
  return (
    <>
      <section className="lt-stack" data-testid="vaults-list" aria-label={t('listTitle', { venue })}>
        <h2>
          {t('listTitle', { venue })} <TestMark test={status.test} />
        </h2>
        <p className="lt-hint" data-testid="vaults-source">
          {t('source', { venue })} · <AsOf iso={list.data?.asOf} t={t} />
        </p>
        {list.failure && !list.data ? (
          <p role="alert" data-testid="vaults-failed">
            {t('readFailed', { venue, detail: list.failure.message ?? '' })}
          </p>
        ) : !list.data ? (
          <Waiting label={t('listTitle', { venue })} />
        ) : vaults.length === 0 ? (
          <p className="lt-hint">{t('listEmpty', { venue })}</p>
        ) : (
          <ScrollTable
            label={t('listTitle', { venue })}
            headers={[t('hVault'), t('hRunBy'), t('hLockUp'), t('hShare'), t('hValue'), t('hReturn'), '']}
          >
            {vaults.map((v) => (
              <tr key={v.address} data-vault={v.address} data-kind={v.kind}>
                <td data-cell="name">{v.name}</td>
                <td data-cell="run-by">{v.leader ? t('runByLeader', { leader: shortAddress(v.leader) }) : t('runByVenue')}</td>
                <td data-cell="lock-up" data-value={v.lockUpSeconds ?? ''}>
                  {lockUpText(t, v.lockUpSeconds)}
                </td>
                <td data-cell="share" data-value={v.profitShareBps ?? ''}>
                  {v.profitShareBps === null ? t('notPublished') : t('share', { percent: bpsPercent(v.profitShareBps) })}
                </td>
                <td className="lt-mono" data-cell="value" data-value={v.vaultValue ?? ''}>
                  {v.vaultValue === null ? t('notPublished') : t('valueOf', { amount: displayAmount(v.vaultValue, 2), asset: v.asset })}
                </td>
                <td data-cell="return" data-value={v.pastReturn ? `${v.pastReturn.bps}/${v.pastReturn.days}` : ''}>
                  {v.pastReturn === null
                    ? t('notPublished')
                    : t('pastReturn', { percent: bpsPercent(v.pastReturn.bps), days: String(v.pastReturn.days) })}
                </td>
                <td>
                  {owner ? (
                    <Button data-testid="vault-deposit" onClick={() => setForm({ vault: v, direction: 'deposit', amount: '' })}>
                      {t('deposit')}
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </ScrollTable>
        )}
      </section>
      {!owner ? (
        <p className="lt-hint">{t('connectFirst')}</p>
      ) : (
        <Positions
          holdings={holdings}
          venue={venue}
          byAddress={byAddress}
          onWithdraw={(vault, amount) => setForm({ vault, direction: 'withdraw', amount })}
          t={t}
        />
      )}
      {owner && form ? (
        <MoveForm
          key={`${form.vault.address}:${form.direction}`}
          owner={owner}
          venue={venue}
          vault={form.vault}
          direction={form.direction}
          initialAmount={form.amount}
          onClose={() => setForm(null)}
          onMoved={() => setRevision((n) => n + 1)}
        />
      ) : null}
    </>
  );
}

function Positions({
  holdings,
  venue,
  byAddress,
  onWithdraw,
  t,
}: {
  holdings: { data: { asOf: string; value: VenueVaultHoldings } | null; failure: { message?: string } | null };
  venue: string;
  byAddress: Map<string, VenueVault>;
  onWithdraw: (vault: VenueVault, amount: string) => void;
  t: T;
}) {
  const positions = holdings.data?.value.positions ?? [];
  return (
    <section className="lt-stack" data-testid="vault-positions" aria-label={t('positionsTitle')}>
      <h2>{t('positionsTitle')}</h2>
      <p className="lt-hint">
        {t('source', { venue })} · <AsOf iso={holdings.data?.asOf} t={t} />
      </p>
      {holdings.failure && !holdings.data ? (
        <p role="alert">{t('holdingsFailed', { venue, detail: holdings.failure.message ?? '' })}</p>
      ) : !holdings.data ? (
        <Waiting label={t('positionsTitle')} />
      ) : positions.length === 0 ? (
        <p className="lt-hint" data-empty="">
          {t('positionsEmpty')}
        </p>
      ) : (
        <ScrollTable label={t('positionsTitle')} headers={[t('hVault'), t('hPosition'), t('hEnds'), '']}>
          {positions.map((p) => {
            const vault = byAddress.get(p.vault);
            return (
              <tr key={p.vault} data-position={p.vault}>
                <td>{p.name}</td>
                <td className="lt-mono" data-cell="equity" data-value={p.equity}>
                  {t('valueOf', { amount: displayAmount(p.equity, 2), asset: p.asset })}
                </td>
                <td data-cell="ends" data-value={p.lockUpEndsAt}>
                  {new Date(p.lockUpEndsAt).toLocaleString()}
                </td>
                <td>
                  {vault ? (
                    <Button data-testid="vault-withdraw" onClick={() => onWithdraw(vault, p.equity)}>
                      {t('withdraw')}
                    </Button>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </ScrollTable>
      )}
    </section>
  );
}

type Figures = { free: string; position: string | null; ends: string | null; holdings: VenueVaultHoldings };
type Stage =
  | { at: 'idle' }
  | { at: 'review' | 'sending'; amount: string; key: string }
  | { at: 'refused'; message: string; beforeWallet: boolean }
  | { at: 'done'; amount: string; key: string; result: ActionResult; before: Figures | null; after: Figures | null; again: boolean };

export function MoveForm({
  owner,
  venue,
  vault,
  direction,
  initialAmount,
  onClose,
  onMoved,
}: {
  owner: string;
  venue: string;
  vault: VenueVault;
  direction: 'deposit' | 'withdraw';
  initialAmount: string;
  onClose: () => void;
  onMoved: () => void;
}) {
  const { t } = vaultsCopy.useCopy();
  const api = useVenueApi();
  const { run } = useVenueActions(owner);
  const [amount, setAmount] = useState(initialAmount);
  const [stage, setStage] = useState<Stage>({ at: 'idle' });
  const [problem, setProblem] = useState<string | null>(null);
  const balances = usePolled((signal) => api.balances(owner, signal), `vaults:free:${owner}`, VENUE_POLL_MS);
  // Free USDC is the venue's figure once it has answered; before then it is unknown, never a zero of ours, and a deposit
  // can't be reviewed against it.
  const free = balances.data ? freeOf(balances.data.value) : null;
  const unread = direction === 'deposit' && free === null;

  /** The venue's figures now: free USDC, this vault's position and its lock-up end, and the transfers. */
  const figures = async (): Promise<Figures | null> => {
    const [b, h] = await Promise.all([api.balances(owner), api.vaultHoldings(owner)]);
    if (!b.ok || !h.ok) return null;
    const p = h.data.value.positions.find((x) => x.vault === vault.address) ?? null;
    return { free: freeOf(b.data.value), position: p?.equity ?? null, ends: p?.lockUpEndsAt ?? null, holdings: h.data.value };
  };

  const review = () => {
    setProblem(null);
    let value: bigint;
    try {
      value = parseAmount(amount.trim());
    } catch {
      return setProblem(t('badAmount', { amount }));
    }
    if (value <= 0n) return setProblem(t('badAmount', { amount }));
    // A deposit above the venue's own free figure, as it last reported it, is refused here; nothing is signed.
    if (direction === 'deposit') {
      if (free === null) return setProblem(t('freeReading', { venue }));
      if (value > parseAmount(free)) return setProblem(t('tooMuch', { venue, free, amount: formatAmount(value) }));
    }
    setStage({ at: 'review', amount: formatAmount(value), key: keys.vaultMove(owner, vault.address, direction, draftId()) });
  };

  const send = async (from: { amount: string; key: string }, again: boolean) => {
    // Only the amount and key are carried on: `from` is a stage object, and its own `at` must not override the new one.
    const s = { amount: from.amount, key: from.key };
    const prior = stage.at === 'done' ? stage : null;
    setStage({ at: 'sending', ...s });
    const before = again && prior ? prior.before : await figures();
    const result = await run({
      kind: 'vault_transfer',
      vault: vault.address,
      direction,
      asset: vault.asset,
      amount: s.amount,
      moveKey: s.key,
    });
    if (result.kind === 'refused') {
      setStage({ at: 'refused', message: result.message, beforeWallet: result.beforeWallet });
      return;
    }
    const after = again && prior ? prior.after : await figures();
    setStage({ at: 'done', ...s, result, before, after, again });
    onMoved();
  };

  const title = direction === 'deposit' ? t('depositTitle', { vault: vault.name }) : t('withdrawTitle', { vault: vault.name });
  return (
    <section className="lt-stack" data-testid="vault-move" data-direction={direction} data-vault={vault.address} aria-label={title}>
      <h3>{title}</h3>
      <p className="lt-hint" data-testid="vault-free" data-value={free ?? ''}>
        {free !== null
          ? t('freeLine', { free, venue })
          : balances.failure
            ? t('freeFailed', { venue, detail: balances.failure.message ?? '' })
            : t('freeReading', { venue })}
      </p>
      <Field
        label={t('amount')}
        inputMode="decimal"
        data-testid="vault-amount"
        value={amount}
        onChange={(e) => {
          setAmount(e.target.value);
          setStage({ at: 'idle' });
        }}
      />
      <Button data-testid="vault-review" disabled={unread} onClick={review}>
        {t('review')}
      </Button>
      <Button onClick={onClose}>{t('cancel')}</Button>
      {problem ? (
        <p role="alert" className="lt-refusal" data-testid="vault-problem">
          {problem}
        </p>
      ) : null}
      {stage.at === 'review' || stage.at === 'sending' ? (
        <div data-testid="vault-review-line">
          <p>
            {direction === 'deposit'
              ? t('reviewDeposit', { amount: stage.amount, vault: vault.name, lockUp: lockUpText(t, vault.lockUpSeconds), venue })
              : t('reviewWithdraw', { amount: stage.amount, vault: vault.name })}
          </p>
          <Button tone="primary" data-testid="vault-sign" disabled={stage.at === 'sending'} onClick={() => void send(stage, false)}>
            {t('sign')}
          </Button>
        </div>
      ) : null}
      {stage.at === 'refused' ? <Refused stage={stage} venue={venue} t={t} /> : null}
      {stage.at === 'done' ? (
        <Done stage={stage} venue={venue} vault={vault} direction={direction} onAgain={() => void send(stage, true)} t={t} />
      ) : null}
    </section>
  );
}

/** The venue's refusal in its own words; a refusal at prepare (before the wallet) also says nothing was signed. */
function Refused({ stage, venue, t }: { stage: Extract<Stage, { at: 'refused' }>; venue: string; t: T }) {
  // The venue names the lock-up's end as an ISO time in its refusal; it is shown again in the person's own time.
  const ends = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/.exec(stage.message)?.[0] ?? null;
  return (
    <div role="alert" className="lt-refusal" data-testid="vault-refused" data-before-wallet={stage.beforeWallet ? 'true' : 'false'}>
      <p>{t('refused', { venue, detail: stage.message })}</p>
      {ends ? (
        <p data-testid="vault-refused-ends" data-value={ends}>
          {t('lockUpEnds', { time: new Date(ends).toLocaleString() })}
        </p>
      ) : null}
      {stage.beforeWallet ? <p data-testid="vault-nothing-signed">{t('nothingSigned')}</p> : null}
    </div>
  );
}

function Done({
  stage,
  venue,
  vault,
  direction,
  onAgain,
  t,
}: {
  stage: Extract<Stage, { at: 'done' }>;
  venue: string;
  vault: VenueVault;
  direction: 'deposit' | 'withdraw';
  onAgain: () => void;
  t: T;
}) {
  const accepted = stage.result.kind === 'outcome' && stage.result.outcome.accepted;
  const nonce = stage.result.kind === 'outcome' ? stage.result.nonce : null;
  const transfer = stage.after?.holdings.transfers.find((x) => x.nonce === nonce) ?? null;
  let line: ReactNode = null;
  if (!accepted) line = <p>{resultLine(t, stage.result, venue)}</p>;
  else if (stage.before && stage.after && direction === 'deposit')
    line = (
      <p data-testid="vault-result-line">
        {t('deposited', {
          amount: stage.amount,
          vault: vault.name,
          position: stage.after.position ?? '0',
          ends: stage.after.ends ? new Date(stage.after.ends).toLocaleString() : t('asOfUnknown'),
          before: stage.before.free,
          after: stage.after.free,
          venue,
        })}
      </p>
    );
  else if (stage.before && stage.after && transfer)
    line = (
      <p data-testid="vault-result-line">
        {transfer.leaderShare === null
          ? t('withdrewNoShare', {
              amount: transfer.amount,
              vault: vault.name,
              credited: transfer.creditedAmount,
              before: stage.before.free,
              after: stage.after.free,
              venue,
            })
          : t('withdrew', {
              amount: transfer.amount,
              vault: vault.name,
              credited: transfer.creditedAmount,
              share: transfer.leaderShare,
              before: stage.before.free,
              after: stage.after.free,
              venue,
            })}
      </p>
    );
  return (
    <div
      role="status"
      data-testid="vault-result"
      data-accepted={accepted ? 'true' : 'false'}
      data-again={stage.again ? 'true' : 'false'}
      data-nonce={nonce ?? ''}
      data-credited={transfer?.creditedAmount ?? ''}
      data-leader-share={transfer?.leaderShare ?? ''}
    >
      {line}
      {stage.again && stage.result.kind === 'outcome' && stage.result.reused ? (
        <p data-testid="vault-again-same">{t('againSame')}</p>
      ) : null}
      {accepted ? (
        <Button data-testid="vault-again" onClick={onAgain}>
          {t('again')}
        </Button>
      ) : null}
    </div>
  );
}

function resultLine(t: T, result: ActionResult, venue: string): string {
  switch (result.kind) {
    case 'rejected':
      return t('walletRejected');
    case 'refused':
      return t('refused', { venue, detail: result.message });
    case 'outcome':
      return result.outcome.accepted ? '' : t('refused', { venue, detail: result.outcome.refusal.detail });
    default:
      return t('pending', { venue });
  }
}
