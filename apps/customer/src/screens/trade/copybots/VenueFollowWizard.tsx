import { useMemo, useState } from 'react';
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  KeyValue,
} from '@intafaced/ui';
import { dec } from '../../../data/decimal';
import { displayAmount } from '../../../shared/money';
import { useResource } from '../../../shared/resource';
import { useWallet } from '../../../features/protocol/wallet/WalletProvider';
import { useSession } from '../../../features/session/session';
import { StepUpConfirm } from '../../../features/money/StepUpConfirm';
import {
  abandonAgentAccount,
  canonical,
  createAgentAccount,
  createStepUp,
  readAgentTerms,
  submitAgentAction,
  type AgentAccount,
} from '../../../features/more/agent-connect-api';
import { useVenueApi, WalletBar } from '../../../features/trade/venue/VenueKit';
import { keys, walletTypedData, type PreparedAnswer, type VenueUp } from '../../../features/trade/venue-api';
import type { Failure } from './guard';
import type { CopyDesk, FollowRequest, LeaderRow, RoomApi } from './api';
import { bpsText, deskState } from './desk';
import { roomCopy } from './copy';
import { InfoNote, RefusalNote } from './parts';

type Step = 1 | 2 | 3 | 4;

/** The datetime-local box gives "2026-10-20T12:00" in the person's own zone; the service wants an instant. */
function instantOf(local: string): string | null {
  if (!local) return null;
  const when = new Date(local);
  return Number.isNaN(when.getTime()) ? null : when.toISOString();
}

const asOfText = (iso: string) => new Date(iso).toLocaleString();

type Typed = PreparedAnswer['prepared']['typedData'];
const failed = (code: string): Failure => ({ ok: false, reason: 'error', message: '', code });

/**
 * Start copying on the person's own venue account (J-copy-bots-otc-01 #5 #7; svc-trade copy/venue-copy.ts). INTAFACED
 * holds and moves nothing. Start copying first has svc-trade check every gate and term with nothing written
 * (copy.checkVenueFollow). Then, after the person confirms it's them, their wallet opens the follow's own agent account
 * (J-agents-21: a venue sub-account under their wallet, its agent permission, which can place and cancel orders there
 * and never withdraw, and the move of the most in total into it from their main venue account) and approves our builder
 * fee on it. Only then is the follow made, bound to that account: every copy is a venue order there, placed by the agent
 * permission. A rejected signature while the account opens ends it: no account and no follow. The request key and the
 * account id are kept for the request, so a second press after a lost answer is the same account and the same follow.
 */
export function VenueFollowWizard({
  open,
  onOpenChange,
  api,
  desk,
  initialLeader,
  listed = null,
  venueName,
  builder,
  onFollowed,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  api: RoomApi;
  desk: CopyDesk | null;
  initialLeader: string;
  listed?: LeaderRow | null;
  /** The venue's own name, as its status names it. */
  venueName: string;
  /** Our builder fee as the venue status names it; null when the owner set none. */
  builder: VenueUp['builder'];
  onFollowed: () => void;
}) {
  const { t } = roomCopy.useCopy();
  const venue = useVenueApi();
  const wallet = useWallet();
  const { api: transport } = useSession();
  const owner = wallet.status === 'connected' && wallet.address ? wallet.address.toLowerCase() : null;
  const [step, setStep] = useState<Step>(1);
  const [leader, setLeader] = useState(initialLeader);
  const [region, setRegion] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [perOrder, setPerOrder] = useState('');
  const [aggregate, setAggregate] = useState('');
  const [fixed, setFixed] = useState('');
  const [expiry, setExpiry] = useState('');
  // Mounted when the wizard opens (CopyRoom), so each opening is a new request with its own key.
  const [requestKey, setRequestKey] = useState(() => `copy-start:${Date.now().toString(36)}`);
  // The follow's own agent account: its id is made once per request, so a retry is the same account, never a second.
  const [accountId, setAccountId] = useState(() => crypto.randomUUID());
  const [made, setMade] = useState<AgentAccount | null>(null);
  const [asking, setAsking] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);
  // While the wallet asks, its own "Check before you sign" sheet is the only thing on screen: this modal would hide it from
  // the accessibility tree and block pointer input to it. The wizard keeps its state and comes back once the wallet answers.
  const [signing, setSigning] = useState(false);
  const [touched, setTouched] = useState(false);
  const state = deskState(desk);

  const markets = useResource((signal) => venue.markets(signal), 'copy-venue-markets');
  const terms = useResource((signal) => readAgentTerms(transport, signal), 'copy-agent-terms');
  const reach = terms.resource.status === 'ready' ? (terms.resource.data.agentPermission?.reach ?? null) : null;
  const spot = useMemo(
    () => (markets.resource.status === 'ready' ? markets.resource.data.value.filter((m) => m.kind === 'spot') : []),
    [markets.resource],
  );
  const quote = useMemo(() => {
    const assets = new Set(spot.filter((m) => picked.includes(m.symbol)).map((m) => m.quoteAsset));
    return assets.size === 1 ? [...assets][0]! : null;
  }, [spot, picked]);
  const balances = useResource(
    (signal) =>
      owner
        ? venue.balances(owner, signal)
        : Promise.resolve({ ok: false as const, reason: 'error' as const, message: '', code: 'wallet' }),
    `copy-venue-balances:${owner ?? ''}:${step}`,
  );
  const read = balances.resource.status === 'ready' ? balances.resource.data : null;
  const free = read && quote ? (dec(read.value.find((b) => b.asset === quote)?.free ?? '0') ?? 0n) : null;
  const freeText = read && quote ? displayAmount(read.value.find((b) => b.asset === quote)?.free ?? '0') : null;
  const asset = quote ?? '';

  const problems = {
    leader: listed || leader.trim() ? '' : t('Enter the leader’s ID'),
    region: /^[A-Za-z]{2}$/.test(region.trim()) ? '' : t('Enter your country as two letters, for example ID'),
    markets: picked.length ? '' : t('Choose at least one market'),
    perOrder: (dec(perOrder) ?? 0n) > 0n ? '' : t('Enter an amount above zero'),
    aggregate:
      (dec(aggregate) ?? 0n) > 0n && (dec(aggregate) ?? 0n) >= (dec(perOrder) ?? 0n)
        ? ''
        : t('The total can’t be below the amount per order'),
    fixed:
      (dec(fixed) ?? 0n) <= 0n
        ? t('Enter an amount above zero')
        : (dec(fixed) ?? 0n) > (dec(perOrder) ?? 0n)
          ? t('The most per order is {cap} {asset}', { cap: displayAmount(perOrder || '0'), asset })
          : '',
    wallet: owner ? '' : t('Connect your wallet first'),
    balance:
      free === null || !read
        ? ''
        : (dec(fixed) ?? 0n) > free || (dec(aggregate) ?? 0n) > free
          ? t('That is more than the {free} {asset} free that {venue} reports for your account, as of {time}', {
              free: freeText ?? '0',
              asset,
              venue: venueName,
              time: asOfText(read.asOf),
            })
          : '',
    expiry: instantOf(expiry) && new Date(expiry).getTime() > Date.now() ? '' : t('Choose a time in the future'),
    mixedQuote: picked.length > 0 && quote === null ? t('Choose markets that settle in the same asset') : '',
  };
  const valid1 = !problems.leader && !problems.region;
  const valid2 = !problems.markets && !problems.mixedQuote;
  const valid3 = !problems.perOrder && !problems.aggregate && !problems.fixed && !problems.wallet && !problems.balance && !problems.expiry;
  const show = (message: string) => (touched ? message : '');

  const reset = () => {
    setStep(1);
    setTouched(false);
    setFailure(null);
    setAsking(false);
  };
  const next = () => {
    setTouched(true);
    if ((step === 1 && valid1) || (step === 2 && valid2) || (step === 3 && valid3)) {
      setTouched(false);
      setStep((step + 1) as Step);
    }
  };

  /** A new Start copying request: its own key, its own agent account id, and nothing made for it yet. */
  function newRequest() {
    setRequestKey(`copy-start:${Date.now().toString(36)}`);
    setAccountId(crypto.randomUUID());
    setMade(null);
    setAsking(false);
  }

  const request = (): FollowRequest | null => {
    const expiresAt = instantOf(expiry);
    if (!expiresAt) return null;
    return {
      ...(listed ? { leaderRef: listed.leaderRef } : { leaderId: leader.trim() }),
      region: region.trim().toUpperCase(),
      permittedMarkets: picked,
      maxNotionalPerOrder: perOrder,
      maxAggregateExposure: aggregate,
      fixedOrderSize: fixed,
      expiresAt,
      clientRequestId: requestKey,
    };
  };
  const ask = () => ({
    accountId,
    owner: owner ?? '',
    asset,
    cap: canonical(aggregate) ?? aggregate,
    fund: canonical(aggregate) ?? aggregate,
  });

  /** The wallet signs one prepared payload; while it asks, its own sheet is the only thing on screen. */
  async function walletSigns(typed: Typed) {
    setSigning(true);
    return wallet.sign({ kind: 'typedData', typedData: walletTypedData(typed) }).finally(() => setSigning(false));
  }

  /** The wallet signs each step the agent account asks (open, agent permission, move in), each sent once. */
  async function openAccount(start: AgentAccount): Promise<AgentAccount | null> {
    let view = start;
    for (let i = 0; view.next && i < 6 && owner; i += 1) {
      const next = view.next;
      const signed = await walletSigns(next.prepared.typedData as Typed);
      if (signed.status !== 'signed') {
        if (view.status === 'opening') {
          // Nothing signed, so nothing moved; the account is ended and this request with it. A new press is a new one.
          const ended = await abandonAgentAccount(transport, view.accountId);
          if (!ended.ok) return (setFailure(ended), null);
          newRequest();
        }
        setFailure(failed(signed.status === 'rejected' ? 'trade.copy_venue_wallet_rejected' : 'trade.copy_venue_wallet_failed'));
        return null;
      }
      const sent = await submitAgentAction(transport, view.accountId, next.actionKey, {
        digest: next.prepared.digest,
        signature: signed.signature,
        signedBy: view.owner,
      });
      if (!sent.ok) return (setFailure(sent), null);
      view = sent.data;
    }
    if (view.next || view.status !== 'open' || !view.subAccount) return (setFailure(failed('trade.copy_venue_account_not_open')), null);
    return view;
  }

  /** Our builder fee rides on every copy: the wallet approves it once on the follow's sub-account, sent once. */
  async function approveBuilder(account: AgentAccount): Promise<boolean> {
    if (!builder || !owner || !account.subAccount) return true;
    const prepared = await venue.prepare({
      owner,
      subAccount: account.subAccount,
      intent: { kind: 'approve_builder_fee', builder: builder.address, maxFeeBps: builder.feeBps },
      actionKey: `${keys.builderApproval(owner, builder.address, builder.feeBps)}:${account.subAccount}`,
    });
    if (!prepared.ok) return (setFailure(prepared), false);
    if (prepared.data.lastOutcome?.definite && prepared.data.lastOutcome.accepted) return true;
    const signed = await walletSigns(prepared.data.prepared.typedData);
    if (signed.status !== 'signed') {
      setFailure(failed(signed.status === 'rejected' ? 'trade.copy_venue_wallet_rejected' : 'trade.copy_venue_wallet_failed'));
      return false;
    }
    const sent = await venue.submit(prepared.data.actionKey, {
      digest: prepared.data.prepared.digest,
      signature: signed.signature,
      signedBy: owner,
    });
    if (!sent.ok) return (setFailure(sent), false);
    if (!sent.data.outcome.definite || !sent.data.outcome.accepted) return (setFailure(failed('trade.copy_venue_refused')), false);
    return true;
  }

  /** The follow onto the open account, then automatic copying on: Start copying is also the grant to place each copy. */
  async function follow(account: AgentAccount) {
    const body = request();
    if (!body) return;
    if (!(await approveBuilder(account))) return;
    const followed = await api.venueFollow({ ...body, agentAccountId: account.accountId });
    if (!followed.ok) return setFailure(followed);
    const granted = await api.grantCopying(followed.data.followId);
    if (!granted.ok) return setFailure(granted);
    onFollowed();
    onOpenChange(false);
    reset();
  }

  /** Start copying: svc-trade checks every gate and term with nothing written; then the person confirms it's them. */
  const confirm = async () => {
    const body = request();
    if (!body || busy || !owner) return;
    setBusy(true);
    setFailure(null);
    try {
      // The account this request already opened: its answer was lost, so carry on from it, never open a second.
      if (made) return await follow(made);
      const checked = await api.checkVenueFollow(body);
      if (!checked.ok) return setFailure(checked);
      if (checked.data.follow) {
        const granted = await api.grantCopying(checked.data.followId);
        if (!granted.ok) return setFailure(granted);
        onFollowed();
        onOpenChange(false);
        return reset();
      }
      setAsking(true);
    } finally {
      setBusy(false);
    }
  };

  /** Confirmed: the wallet opens the follow's agent account, and the follow is made on it. */
  const approved = async (stepUpApprovalId: string | null) => {
    if (busy) return;
    setAsking(false);
    setBusy(true);
    try {
      const created = await createAgentAccount(transport, ask(), stepUpApprovalId);
      if (!created.ok) {
        setFailure(created);
        // A definite refusal ends this request; one whose answer was lost keeps its id, so the retry is the same account.
        if (created.reason !== 'uncertain') newRequest();
        return;
      }
      const open = await openAccount(created.data);
      if (!open) return;
      setMade(open);
      await follow(open);
    } finally {
      setBusy(false);
    }
  };

  const share = bpsText(desk?.leaderShareBps ?? null);
  return (
    <Dialog
      open={open && !signing}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) reset();
      }}
    >
      <DialogContent className="cb-dialog">
        <DialogHeader>
          <DialogTitle>{t('Follow a leader')}</DialogTitle>
          <DialogDescription>
            {t('Step {step} of 4. You set every limit. A leader’s order is only a suggestion.', { step })}
          </DialogDescription>
        </DialogHeader>

        {state && !state.open ? (
          <InfoNote tone="warn">
            {t('Copy trading is closed right now, so the final step will be refused. Nothing is followed and no money moves.')}
          </InfoNote>
        ) : null}

        {step === 1 ? (
          <div className="cb-form">
            {listed ? (
              <KeyValue items={[{ label: t('Leader'), value: listed.displayName }]} />
            ) : (
              <Field label={t('Leader ID')} hint={t('The ID the leader shares with you')} error={show(problems.leader)} required>
                <Input kind="text" value={leader} onValueChange={setLeader} maxLength={120} autoComplete="off" />
              </Field>
            )}
            <Field
              label={t('Your country')}
              hint={t('Two letters. Copy trading is only offered in some countries.')}
              error={show(problems.region)}
              required
            >
              <Input kind="text" value={region} onValueChange={(v) => setRegion(v.toUpperCase())} maxLength={2} autoComplete="country" />
            </Field>
          </div>
        ) : null}

        {step === 2 ? (
          <div className="cb-form">
            <fieldset className="cb-fieldset">
              <legend className="cb-label">{t('Markets you allow')}</legend>
              {markets.resource.status === 'failed' ? (
                <RefusalNote failure={markets.resource.failure} retry={markets.reload} />
              ) : spot.length === 0 ? (
                <InfoNote>{t('No markets are open for copying right now.')}</InfoNote>
              ) : (
                <ul className="cb-checklist">
                  {spot.map((market) => (
                    <li key={market.symbol}>
                      <label>
                        <Checkbox
                          checked={picked.includes(market.symbol)}
                          onCheckedChange={(checked) =>
                            setPicked((p) => (checked ? [...p, market.symbol] : p.filter((s) => s !== market.symbol)))
                          }
                        />
                        <span>{market.symbol}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
              {show(problems.markets || problems.mixedQuote) ? (
                <p className="cb-error" role="alert">
                  {problems.markets || problems.mixedQuote}
                </p>
              ) : null}
            </fieldset>
            <InfoNote>{t('Only the leader’s trades in these markets can be copied. Nothing else.')}</InfoNote>
          </div>
        ) : null}

        {step === 3 ? (
          <div className="cb-form">
            <WalletBar />
            {show(problems.wallet) ? (
              <p className="cb-error" role="alert">
                {problems.wallet}
              </p>
            ) : null}
            <KeyValue
              items={[
                {
                  label: t('Free {asset} on your venue account', { asset }),
                  value: read && freeText !== null ? `${freeText} ${asset}` : t('Balance unread'),
                  hint: read ? t('As the venue reports it, as of {time}', { time: asOfText(read.asOf) }) : undefined,
                },
              ]}
            />
            <Field label={t('Most per order ({asset})', { asset })} error={show(problems.perOrder)} required>
              <Input kind="decimal" value={perOrder} onValueChange={setPerOrder} precision={8} trailing={asset} />
            </Field>
            <Field
              label={t('Most in total ({asset})', { asset })}
              hint={t('All copied orders together can never go past this. It is a limit: nothing is set aside or moved.')}
              error={show(problems.aggregate)}
              required
            >
              <Input kind="decimal" value={aggregate} onValueChange={setAggregate} precision={8} trailing={asset} />
            </Field>
            <Field
              label={t('Fixed amount per copied order ({asset})', { asset })}
              hint={t('Each copied order uses this much, never more than the most per order.')}
              error={show(problems.fixed)}
              required
            >
              <Input kind="decimal" value={fixed} onValueChange={setFixed} precision={8} trailing={asset} />
            </Field>
            {show(problems.balance) ? (
              <p className="cb-error" role="alert">
                {problems.balance}
              </p>
            ) : null}
            <Field
              label={t('Permission ends')}
              hint={t('After this time no new trades are copied.')}
              error={show(problems.expiry)}
              required
            >
              <Input kind="text" {...{ type: 'datetime-local' }} value={expiry} onValueChange={setExpiry} />
            </Field>
            <InfoNote>{t('The leader can never raise these limits.')}</InfoNote>
          </div>
        ) : null}

        {step === 4 ? (
          <div className="cb-form">
            {failure ? <RefusalNote failure={failure} /> : null}
            <KeyValue
              items={[
                listed ? { label: t('Leader'), value: listed.displayName } : { label: t('Leader'), value: leader.trim(), mono: true },
                { label: t('Country'), value: region.trim().toUpperCase() },
                { label: t('Markets'), value: picked.join(', ') },
                { label: t('Your venue account'), value: owner ?? t('Not connected'), mono: true },
                { label: t('Most per order'), value: `${displayAmount(perOrder)} ${asset}` },
                { label: t('Most in total'), value: `${displayAmount(aggregate)} ${asset}` },
                { label: t('Fixed amount per copied order'), value: `${displayAmount(fixed)} ${asset}` },
                { label: t('Permission ends'), value: new Date(expiry).toLocaleString() },
              ]}
            />
            <section aria-label={t('What it costs')} className="cb-cost">
              <h3>{t('What it costs')}</h3>
              <KeyValue
                items={[
                  { label: t('Fee on each copied order'), value: t('The venue’s own fee and our builder fee, as the venue reports them') },
                  {
                    label: t('Leader’s share'),
                    value: share ? t('{share} of our fee, paid by the platform from that fee', { share }) : t('Not approved'),
                  },
                  { label: t('Extra charge on your profit'), value: t('None. Leaders are never paid from your profit') },
                ]}
              />
            </section>
            <section aria-label={t('Copy permission')} className="cb-cost">
              <h3>{t('Copy permission')}</h3>
              <InfoNote>
                {t(
                  'Your wallet is asked to open an agent account for this follow on your own venue account, sign its agent permission and move the most in total into it. The permission can place and cancel orders there and can never withdraw. Nothing is moved or held by INTAFACED.',
                )}
              </InfoNote>
              {reach === 'owner_accounts' ? (
                <InfoNote tone="warn">
                  {t(
                    'On {venue}, this permission also reaches your other accounts there. Your limits here are then the only limit on its orders.',
                    {
                      venue: venueName,
                    },
                  )}
                </InfoNote>
              ) : null}
            </section>
            {asking ? (
              <StepUpConfirm
                request={() => createStepUp(ask())}
                words={{
                  why: t('Confirm it’s you to open the agent account for this follow and move {amount} {asset} into it.', {
                    amount: displayAmount(aggregate),
                    asset,
                  }),
                  code: t('Authenticator code'),
                  codeHint: t('The 6-digit code from your authenticator app'),
                  codeShort: t('Enter the 6-digit code'),
                  noFactor: t('You have no authenticator app or passkey. The request is sent without one, and the service decides.'),
                  sendWithout: t('Continue'),
                }}
                disabled={busy}
                onApproved={(id) => void approved(id)}
              />
            ) : null}
            <InfoNote>
              {t(
                'Each new trade the leader makes is then placed on your venue account, within these limits, until you turn copying off or the permission ends.',
              )}
            </InfoNote>
          </div>
        ) : null}

        <DialogFooter>
          {step > 1 ? (
            <Button variant="secondary" onClick={() => setStep((step - 1) as Step)} disabled={busy}>
              {t('Back')}
            </Button>
          ) : null}
          {step < 4 ? (
            <Button onClick={next}>{t('Next')}</Button>
          ) : (
            <Button onClick={() => void confirm()} loading={busy} disabled={!owner || asking}>
              {t('Start copying')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
