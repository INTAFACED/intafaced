// volt-room: /trade/staking
import { useMemo, useState, type ReactNode } from 'react';
import { Button, Field } from '@intafaced/ui/lit';
import { MonitorTemplate } from '@intafaced/ui/lit/templates';
import type { RoomState } from '@intafaced/ui/lit/templates';
import { displayAmount, formatAmount, parseAmount } from '../../../shared/money';
import { WalletProvider, usePolled, useWallet } from '../../protocol';
import { useSession } from '../../session';
import { useVenueMode } from '../use-venue-mode';
import { draftId, keys, type VenueStaking, type VenueStakingAccount, type VenueUp } from '../venue-api';
import { useOwner, useVenueActions, useVenueApi, type ActionResult } from '../venue/VenueKit';
import { stakingCopy } from './staking-copy';

/**
 * Staking on the venue (`/trade/staking`, J-cex-spot-21): the venue's validators, reward rate and staking fee-discount
 * tiers as it publishes them, and the person's own staking balance, delegations with each lock-up's end, the unstaking
 * queue and the rewards. Moving between spot and staking and delegating are each one signed venue action, sent once
 * under its own key; before a lock-up ends the venue refuses an undelegation at prepare, so nothing is signed; at its
 * pending limit it refuses a move to spot when the signed move arrives, and nothing is sent again. Every figure is the
 * venue's own; one it doesn't publish reads "not published". INTAFACED holds nothing and the ledger posts nothing.
 */

type T = ReturnType<typeof stakingCopy.useCopy>['t'];
type Validator = VenueStaking['validators'][number];
type Action = 'to_staking' | 'to_spot' | 'delegate' | 'undelegate';
const DAY_S = 86_400;
/** How often the room reads the venue again. */
const POLL_MS = 5_000;

export function StakingRoom() {
  const { t } = stakingCopy.useCopy();
  const mode = useVenueMode();
  const { userId } = useSession();
  const off = (state: RoomState) => <MonitorTemplate title={t('title')} description={t('lead')} state={state} mode="pro" figures={[]} />;
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
    <WalletProvider chainId={status.chainId ?? undefined} scope="venue-desk">
      <Room status={status} />
    </WalletProvider>
  );
}

/** Connect, the connected address and network, and the switch when the wallet is on another network. */
function WalletBar({ t }: { t: T }) {
  const wallet = useWallet();
  return (
    <section aria-label={t('walletTitle')} data-testid="venue-wallet">
      <h2>{t('walletTitle')}</h2>
      {wallet.status === 'connected' && wallet.address ? (
        <>
          <dl>
            <div>
              <dt>{t('connectedAddress')}</dt>
              <dd data-testid="venue-wallet-address">{wallet.address.toLowerCase()}</dd>
            </div>
            <div>
              <dt>{t('network')}</dt>
              <dd>{wallet.chainId ?? ''}</dd>
            </div>
          </dl>
          {wallet.guard && !wallet.guard.ok ? (
            <p role="alert">
              {t('wrongNetwork', { observed: String(wallet.guard.observed ?? ''), configured: String(wallet.guard.configured) })}{' '}
              <Button onClick={() => void wallet.switchNetwork()}>{t('switchNetwork')}</Button>
            </p>
          ) : null}
          <Button tone="quiet" onClick={wallet.disconnect}>
            {t('disconnect')}
          </Button>
        </>
      ) : wallet.wallets.length === 0 ? (
        <p>{t('noWallet')}</p>
      ) : (
        wallet.wallets.map((entry) => (
          <Button key={entry.info.uuid} disabled={wallet.status === 'connecting'} onClick={() => void wallet.connect(entry)}>
            {t('connectWallet', { name: entry.info.name })}
          </Button>
        ))
      )}
      {wallet.problem ? <p role="alert">{wallet.problem}</p> : null}
    </section>
  );
}

/** The kit's TEST label, on a TEST venue only. */
function TestMark({ test, t }: { test: boolean; t: T }) {
  return test ? (
    <span className="lt-test" data-testid="venue-test">
      {t('test')}
    </span>
  ) : null;
}

function AsOf({ iso, t }: { iso: string | null | undefined; t: T }) {
  if (!iso) return <span data-as-of="">{t('asOfUnknown')}</span>;
  return <span data-as-of={iso}>{t('asOf', { time: new Date(iso).toLocaleString() })}</span>;
}

/** Whole basis points as a percent with two places (`230` → `2.30`). */
function bpsPercent(bps: number): string {
  return `${Math.floor(bps / 100)}.${String(bps % 100).padStart(2, '0')}`;
}

/** A span of seconds in words: whole days, else whole hours; `null` is not published. */
function spanText(t: T, seconds: number | null): string {
  if (seconds === null) return t('notPublished');
  if (seconds === DAY_S) return t('oneDay');
  if (seconds % DAY_S === 0) return t('days', { n: String(seconds / DAY_S) });
  return t('hours', { n: String(Math.round(seconds / 3600)) });
}

const spotOf = (rows: readonly { asset: string; free: string }[] | null | undefined, asset: string) =>
  rows?.find((r) => r.asset === asset)?.free ?? '0';

function Room({ status }: { status: VenueUp }) {
  const { t } = stakingCopy.useCopy();
  const api = useVenueApi();
  const owner = useOwner();
  const venue = status.venue.displayName;
  const [revision, setRevision] = useState(0);
  const [form, setForm] = useState<{ action: Action; validator: Validator | null; amount: string } | null>(null);
  const terms = usePolled((signal) => api.staking(signal), `staking:terms:${revision}`, POLL_MS);
  const mine = usePolled(
    (signal) => (owner ? api.stakingAccount(owner, signal) : Promise.resolve(null)),
    `staking:mine:${owner ?? ''}:${revision}`,
    POLL_MS,
  );
  const balances = usePolled(
    (signal) => (owner ? api.balances(owner, signal) : Promise.resolve(null)),
    `staking:spot:${owner ?? ''}:${revision}`,
    POLL_MS,
  );
  const s = terms.data?.value ?? null;
  const asset = s?.asset ?? mine.data?.value.asset ?? '';
  const validators = s?.validators ?? [];
  const byAddress = new Map(validators.map((v) => [v.address, v]));
  const state: RoomState = useMemo(() => {
    if (terms.failure && !terms.data)
      return {
        kind: 'refused',
        refusal: {
          variant: 'unreachable',
          title: t('termsFailedTitle'),
          body: t('readFailed', { venue, detail: terms.failure.message ?? '' }),
        },
      };
    return terms.data ? { kind: 'ready' } : { kind: 'loading' };
  }, [terms.data, terms.failure, t, venue]);
  const figures = s
    ? [
        <div key="rate">
          <span>{t('rewardRate')}</span>{' '}
          <strong data-testid="staking-reward-rate" data-value={s.rewardRateBps ?? ''}>
            {s.rewardRateBps === null ? t('notPublished') : t('rewardRateValue', { percent: bpsPercent(s.rewardRateBps) })}
          </strong>
        </div>,
        <div key="lockup">
          <span>{t('lockUp')}</span>{' '}
          <strong data-testid="staking-lockup" data-value={s.delegationLockUpSeconds ?? ''}>
            {spanText(t, s.delegationLockUpSeconds)}
          </strong>
        </div>,
        <div key="queue">
          <span>{t('queue')}</span>{' '}
          <strong data-testid="staking-queue" data-value={s.unstakingQueueSeconds ?? ''}>
            {spanText(t, s.unstakingQueueSeconds)}
          </strong>
        </div>,
        <div key="limit">
          <span>{t('limit')}</span>{' '}
          <strong data-testid="staking-limit" data-value={s.maxPendingWithdrawals ?? ''}>
            {s.maxPendingWithdrawals === null ? t('notPublished') : t('limitValue', { n: String(s.maxPendingWithdrawals) })}
          </strong>
        </div>,
      ]
    : [];
  return (
    <MonitorTemplate
      title={t('title')}
      description={t('lead')}
      state={state}
      mode="pro"
      figures={figures}
      actions={
        <div>
          <TestMark test={status.test} t={t} />
          <WalletBar t={t} />
          {owner ? null : <p>{t('connectFirst')}</p>}
        </div>
      }
      panels={
        <div>
          {owner && form && s ? (
            <MoveForm
              key={`${form.action}:${form.validator?.address ?? ''}`}
              owner={owner}
              venue={venue}
              terms={s}
              action={form.action}
              validator={form.validator}
              initialAmount={form.amount}
              onClose={() => setForm(null)}
              onMoved={() => setRevision((n) => n + 1)}
            />
          ) : null}
          {s ? (
            <section data-testid="staking-terms" aria-label={t('termsTitle', { venue })}>
              <h2>
                {t('termsTitle', { venue })} <TestMark test={status.test} t={t} />
              </h2>
              <p data-testid="staking-source">
                {t('source', { venue })} · <AsOf iso={terms.data?.asOf} t={t} />
              </p>
              <h3>{t('validatorsTitle')}</h3>
              <table aria-label={t('validatorsTitle')}>
                <thead>
                  <tr>
                    <th scope="col">{t('hValidator')}</th>
                    <th scope="col">{t('hCommission')}</th>
                    <th scope="col">{t('hStake')}</th>
                    <th scope="col">{t('hStatus')}</th>
                    <th scope="col" />
                  </tr>
                </thead>
                <tbody>
                  {validators.map((v) => (
                    <tr key={v.address} data-validator={v.address} data-status={v.status}>
                      <td data-cell="name">{v.name}</td>
                      <td data-cell="commission" data-value={v.commissionBps ?? ''}>
                        {v.commissionBps === null ? t('notPublished') : t('percent', { percent: bpsPercent(v.commissionBps) })}
                      </td>
                      <td data-cell="stake" data-value={v.totalStake ?? ''}>
                        {v.totalStake === null ? t('notPublished') : t('amountOf', { amount: displayAmount(v.totalStake), asset: s.asset })}
                      </td>
                      <td data-cell="status">{t(`status_${v.status}`)}</td>
                      <td>
                        {owner ? (
                          <Button data-testid="staking-delegate" onClick={() => setForm({ action: 'delegate', validator: v, amount: '' })}>
                            {t('delegate')}
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <h3>{t('tiersTitle', { venue })}</h3>
              <p>{t('tiersNote', { venue })}</p>
              {s.discountTiers === null ? (
                <p data-testid="staking-tiers-unpublished">{t('tiersNotPublished', { venue })}</p>
              ) : (
                <table data-testid="staking-tiers" aria-label={t('tiersTitle', { venue })}>
                  <thead>
                    <tr>
                      <th scope="col">{t('hTier')}</th>
                      <th scope="col">{t('hFrom')}</th>
                      <th scope="col">{t('hDiscount')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.discountTiers.map((tier) => (
                      <tr key={tier.name} data-tier={tier.name}>
                        <td data-cell="name">{tier.name}</td>
                        <td data-cell="from" data-value={tier.fromStaked}>
                          {t('amountOf', { amount: displayAmount(tier.fromStaked), asset: s.asset })}
                        </td>
                        <td data-cell="discount" data-value={tier.discountBps}>
                          {t('percent', { percent: bpsPercent(tier.discountBps) })}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          ) : null}
          {owner ? (
            <Mine
              mine={mine}
              spot={balances.data ? spotOf(balances.data.value, asset) : null}
              asset={asset}
              venue={venue}
              byAddress={byAddress}
              onAction={(action, validator, amount) => setForm({ action, validator, amount })}
              t={t}
            />
          ) : null}
        </div>
      }
      explain={
        <div>
          <p>{t('lead')}</p>
          <p>{t('ledgerNote')}</p>
        </div>
      }
    />
  );
}

function Mine({
  mine,
  spot,
  asset,
  venue,
  byAddress,
  onAction,
  t,
}: {
  mine: { data: { asOf: string; value: VenueStakingAccount } | null; failure: { message?: string } | null };
  spot: string | null;
  asset: string;
  venue: string;
  byAddress: Map<string, Validator>;
  onAction: (action: Action, validator: Validator | null, amount: string) => void;
  t: T;
}) {
  const m = mine.data?.value ?? null;
  return (
    <section data-testid="staking-mine" aria-label={t('mineTitle')}>
      <h2>{t('mineTitle')}</h2>
      <p>
        {t('source', { venue })} · <AsOf iso={mine.data?.asOf} t={t} />
      </p>
      {mine.failure && !m ? (
        <p role="alert">{t('holdingsFailed', { venue, detail: mine.failure.message ?? '' })}</p>
      ) : !m ? (
        <p role="status">{t('reading')}</p>
      ) : (
        <>
          <p data-testid="staking-spot" data-value={spot ?? ''}>
            {t('spotLine', { amount: spot === null ? '…' : displayAmount(spot), asset })}
          </p>
          <p data-testid="staking-balance" data-value={m.staked}>
            {t('stakingLine', { amount: displayAmount(m.staked), asset })}
          </p>
          <p data-testid="staking-rewards" data-value={m.rewards.total}>
            {t('rewardsLine', { amount: displayAmount(m.rewards.total), asset })}
          </p>
          <Button data-testid="staking-stake" onClick={() => onAction('to_staking', null, '')}>
            {t('stake')}
          </Button>
          <Button data-testid="staking-unstake" onClick={() => onAction('to_spot', null, '')}>
            {t('unstake')}
          </Button>
          <h3>{t('delegationsTitle')}</h3>
          {m.delegations.length === 0 ? (
            <p data-testid="staking-delegations-empty">{t('delegationsEmpty')}</p>
          ) : (
            <div data-testid="staking-delegations">
              <table aria-label={t('delegationsTitle')}>
                <thead>
                  <tr>
                    {[t('hValidator'), t('hAmount'), t('hEnds'), ''].map((h, i) => (
                      <th key={i} scope="col">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {m.delegations.map((d) => {
                    const v = byAddress.get(d.validator);
                    return (
                      <tr key={d.validator} data-delegation={d.validator}>
                        <td>{d.name}</td>
                        <td data-cell="amount" data-value={d.amount}>
                          {t('amountOf', { amount: displayAmount(d.amount), asset })}
                        </td>
                        <td data-cell="ends" data-value={d.lockUpEndsAt}>
                          {new Date(d.lockUpEndsAt).toLocaleString()}
                        </td>
                        <td>
                          {v ? (
                            <Button data-testid="staking-undelegate" onClick={() => onAction('undelegate', v, d.amount)}>
                              {t('undelegate')}
                            </Button>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <h3>{t('pendingTitle')}</h3>
          {m.pending.length === 0 ? (
            <p data-testid="staking-pending-empty">{t('pendingEmpty')}</p>
          ) : (
            <div data-testid="staking-pending">
              <table aria-label={t('pendingTitle')}>
                <thead>
                  <tr>
                    {[t('hAmount'), t('hRequested'), t('hArrives')].map((h, i) => (
                      <th key={i} scope="col">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {m.pending.map((p) => (
                    <tr key={p.nonce} data-nonce={p.nonce}>
                      <td data-cell="amount" data-value={p.amount}>
                        {t('amountOf', { amount: displayAmount(p.amount), asset })}
                      </td>
                      <td data-cell="requested" data-value={p.requestedAt}>
                        {new Date(p.requestedAt).toLocaleString()}
                      </td>
                      <td data-cell="arrives" data-value={p.arrivesAt}>
                        {new Date(p.arrivesAt).toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {m.arrived.length > 0 ? (
            <div data-testid="staking-arrived">
              <h3>{t('arrivedTitle')}</h3>
              <table aria-label={t('arrivedTitle')}>
                <thead>
                  <tr>
                    {[t('hAmount'), t('hRequested'), t('hArrives')].map((h, i) => (
                      <th key={i} scope="col">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {m.arrived.map((p) => (
                    <tr key={p.nonce} data-nonce={p.nonce}>
                      <td data-cell="amount" data-value={p.amount}>
                        {t('amountOf', { amount: displayAmount(p.amount), asset })}
                      </td>
                      <td data-cell="requested" data-value={p.requestedAt}>
                        {new Date(p.requestedAt).toLocaleString()}
                      </td>
                      <td data-cell="arrived" data-value={p.arrivedAt}>
                        {new Date(p.arrivedAt).toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

type Figures = { spot: string; account: VenueStakingAccount };
type Stage =
  | { at: 'idle' }
  | { at: 'review' | 'sending'; amount: string; key: string }
  | { at: 'refused'; message: string; beforeWallet: boolean }
  | { at: 'done'; amount: string; key: string; result: ActionResult; before: Figures | null; after: Figures | null; again: boolean };

const delegatedTo = (f: Figures | null, validator: string | undefined) =>
  f?.account.delegations.find((d) => d.validator === validator)?.amount ?? '0';

function MoveForm({
  owner,
  venue,
  terms,
  action,
  validator,
  initialAmount,
  onClose,
  onMoved,
}: {
  owner: string;
  venue: string;
  terms: VenueStaking;
  action: Action;
  validator: Validator | null;
  initialAmount: string;
  onClose: () => void;
  onMoved: () => void;
}) {
  const { t } = stakingCopy.useCopy();
  const api = useVenueApi();
  const { run } = useVenueActions(owner);
  const asset = terms.asset;
  const [amount, setAmount] = useState(initialAmount);
  const [stage, setStage] = useState<Stage>({ at: 'idle' });
  const [problem, setProblem] = useState<string | null>(null);

  /** The venue's figures now: free spot and the account's staking. */
  const figures = async (): Promise<Figures | null> => {
    const [b, s] = await Promise.all([api.balances(owner), api.stakingAccount(owner)]);
    if (!b.ok || !s.ok) return null;
    return { spot: spotOf(b.data.value, asset), account: s.data.value };
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
    const draft = draftId();
    const key =
      action === 'to_staking' || action === 'to_spot'
        ? keys.stakeMove(owner, action, draft)
        : keys.delegation(owner, validator?.address ?? '', action, draft);
    setStage({ at: 'review', amount: formatAmount(value), key });
  };

  const send = async (from: { amount: string; key: string }, again: boolean) => {
    // Only the amount and key are carried on: `from` is a stage object, and its own `at` must not override the new one.
    const s = { amount: from.amount, key: from.key };
    const prior = stage.at === 'done' ? stage : null;
    setStage({ at: 'sending', ...s });
    const before = again && prior ? prior.before : await figures();
    const result = await run(
      action === 'to_staking' || action === 'to_spot'
        ? { kind: 'staking_transfer', direction: action, asset, amount: s.amount, moveKey: s.key }
        : { kind: 'staking_delegate', validator: validator?.address ?? '', direction: action, asset, amount: s.amount, moveKey: s.key },
    );
    if (result.kind === 'refused') {
      setStage({ at: 'refused', message: result.message, beforeWallet: result.beforeWallet });
      return;
    }
    const after = again && prior ? prior.after : await figures();
    setStage({ at: 'done', ...s, result, before, after, again });
    onMoved();
  };

  const name = validator?.name ?? '';
  const title =
    action === 'to_staking'
      ? t('titleToStaking', { asset })
      : action === 'to_spot'
        ? t('titleToSpot', { asset })
        : action === 'delegate'
          ? t('titleDelegate', { validator: name })
          : t('titleUndelegate', { validator: name });
  const reviewText = (value: string) =>
    action === 'to_staking'
      ? t('reviewToStaking', { amount: value, asset })
      : action === 'to_spot'
        ? t('reviewToSpot', { amount: value, asset, venue, queue: spanText(t, terms.unstakingQueueSeconds) })
        : action === 'delegate'
          ? t('reviewDelegate', { amount: value, asset, validator: name, lockUp: spanText(t, terms.delegationLockUpSeconds), venue })
          : t('reviewUndelegate', { amount: value, asset, validator: name });
  return (
    <section data-testid="staking-move" data-action={action} data-validator={validator?.address ?? ''} aria-label={title}>
      <h3>{title}</h3>
      <Field
        label={t('amount', { asset })}
        inputMode="decimal"
        data-testid="staking-amount"
        value={amount}
        onChange={(e) => {
          setAmount(e.target.value);
          setStage({ at: 'idle' });
        }}
      />
      <Button data-testid="staking-review" onClick={review}>
        {t('review')}
      </Button>
      <Button onClick={onClose}>{t('cancel')}</Button>
      {problem ? (
        <p role="alert" data-testid="staking-problem">
          {problem}
        </p>
      ) : null}
      {stage.at === 'review' || stage.at === 'sending' ? (
        <div data-testid="staking-review-line">
          <p>{reviewText(stage.amount)}</p>
          <Button tone="primary" data-testid="staking-sign" disabled={stage.at === 'sending'} onClick={() => void send(stage, false)}>
            {t('sign')}
          </Button>
        </div>
      ) : null}
      {stage.at === 'refused' ? <Refused stage={stage} venue={venue} t={t} /> : null}
      {stage.at === 'done' ? (
        <Done
          stage={stage}
          venue={venue}
          terms={terms}
          action={action}
          validator={validator}
          onAgain={() => void send(stage, true)}
          t={t}
        />
      ) : null}
    </section>
  );
}

/** The venue's refusal in its own words; a refusal at prepare (before the wallet) also says nothing was signed. */
function Refused({ stage, venue, t }: { stage: Extract<Stage, { at: 'refused' }>; venue: string; t: T }) {
  // The venue names the lock-up's end as an ISO time in its refusal; it is shown again in the person's own time.
  const ends = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/.exec(stage.message)?.[0] ?? null;
  return (
    <div role="alert" data-testid="staking-refused" data-before-wallet={stage.beforeWallet ? 'true' : 'false'}>
      <p>{t('refused', { venue, detail: stage.message })}</p>
      {ends ? (
        <p data-testid="staking-refused-ends" data-value={ends}>
          {t('lockUpEnds', { time: new Date(ends).toLocaleString() })}
        </p>
      ) : null}
      {stage.beforeWallet ? <p data-testid="staking-nothing-signed">{t('nothingSigned')}</p> : null}
    </div>
  );
}

function Done({
  stage,
  venue,
  terms,
  action,
  validator,
  onAgain,
  t,
}: {
  stage: Extract<Stage, { at: 'done' }>;
  venue: string;
  terms: VenueStaking;
  action: Action;
  validator: Validator | null;
  onAgain: () => void;
  t: T;
}) {
  const asset = terms.asset;
  const outcome = stage.result.kind === 'outcome' ? stage.result.outcome : null;
  const accepted = outcome?.accepted === true;
  const nonce = stage.result.kind === 'outcome' ? stage.result.nonce : null;
  const { before, after } = stage;
  let line: ReactNode = null;
  if (!accepted) line = <p data-testid="staking-result-line">{resultLine(t, stage.result, venue)}</p>;
  else if (before && after) {
    const text =
      action === 'to_staking'
        ? t('doneToStaking', {
            amount: stage.amount,
            asset,
            before: before.account.staked,
            after: after.account.staked,
            spotBefore: before.spot,
            spotAfter: after.spot,
            venue,
          })
        : action === 'delegate'
          ? t('doneDelegate', {
              amount: stage.amount,
              asset,
              validator: validator?.name ?? '',
              before: delegatedTo(before, validator?.address),
              after: delegatedTo(after, validator?.address),
              ends: (() => {
                const d = after.account.delegations.find((x) => x.validator === validator?.address);
                return d ? new Date(d.lockUpEndsAt).toLocaleString() : t('asOfUnknown');
              })(),
              venue,
            })
          : action === 'undelegate'
            ? t('doneUndelegate', {
                amount: stage.amount,
                asset,
                validator: validator?.name ?? '',
                before: delegatedTo(before, validator?.address),
                after: delegatedTo(after, validator?.address),
                staking: after.account.staked,
                venue,
              })
            : t('doneToSpot', {
                amount: stage.amount,
                asset,
                venue,
                arrives: (() => {
                  const p = after.account.pending.find((x) => x.nonce === nonce);
                  return p ? new Date(p.arrivesAt).toLocaleString() : t('asOfUnknown');
                })(),
              });
    line = <p data-testid="staking-result-line">{text}</p>;
  }
  // A move to spot the venue refused at its pending limit: signed and sent once, never sent again.
  const atLimit = !accepted && outcome !== null && action === 'to_spot' && terms.maxPendingWithdrawals !== null;
  return (
    <div
      role="status"
      data-testid="staking-result"
      data-accepted={accepted ? 'true' : 'false'}
      data-again={stage.again ? 'true' : 'false'}
      data-nonce={nonce ?? ''}
    >
      {line}
      {atLimit ? (
        <p data-testid="staking-limit-refused" data-limit={terms.maxPendingWithdrawals ?? ''}>
          {t('limitRefused', { venue, n: String(terms.maxPendingWithdrawals) })}
        </p>
      ) : null}
      {stage.again && stage.result.kind === 'outcome' && stage.result.reused ? (
        <p data-testid="staking-again-same">{t('againSame')}</p>
      ) : null}
      {accepted ? (
        <Button data-testid="staking-again" onClick={onAgain}>
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
