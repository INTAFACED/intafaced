import { useEffect, useMemo, useState } from 'react';
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
import { useVenueApi, WalletBar } from '../../../features/trade/venue/VenueKit';
import { walletTypedData } from '../../../features/trade/venue-api';
import type { Failure } from './guard';
import type { CopyDesk, LeaderRow, RoomApi, VenueFollow } from './api';
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

/**
 * Start copying on the person's own venue account (J-copy-bots-otc-01 #7; svc-trade copy/venue-copy.ts). INTAFACED holds
 * and moves nothing: the follow's total is a limit, checked against the free balance the venue reports for the
 * connected wallet's account, and starting it asks the wallet to sign the venue's permission for this follow's key,
 * which can place and cancel orders on that account and never withdraw. A rejected signature leaves no follow.
 */
export function VenueFollowWizard({
  open,
  onOpenChange,
  api,
  desk,
  initialLeader,
  listed = null,
  venueName,
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
  onFollowed: () => void;
}) {
  const { t } = roomCopy.useCopy();
  const venue = useVenueApi();
  const wallet = useWallet();
  const owner = wallet.status === 'connected' && wallet.address ? wallet.address.toLowerCase() : null;
  const [step, setStep] = useState<Step>(1);
  const [leader, setLeader] = useState(initialLeader);
  const [region, setRegion] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [perOrder, setPerOrder] = useState('');
  const [aggregate, setAggregate] = useState('');
  const [fixed, setFixed] = useState('');
  const [expiry, setExpiry] = useState('');
  const [requestKey, setRequestKey] = useState('');
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);
  const state = deskState(desk);
  useEffect(() => {
    if (open) {
      setLeader(initialLeader);
      setRequestKey(`copy-start:${Date.now().toString(36)}`);
    }
  }, [open, initialLeader]);

  const markets = useResource((signal) => venue.markets(signal), 'copy-venue-markets');
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
  };
  const next = () => {
    setTouched(true);
    if ((step === 1 && valid1) || (step === 2 && valid2) || (step === 3 && valid3)) {
      setTouched(false);
      setStep((step + 1) as Step);
    }
  };

  /** The wallet signs what the follow asks next, sent once; a rejection is never sent, and the follow is ended. */
  async function signNext(start: VenueFollow): Promise<VenueFollow | null> {
    let current = start;
    for (let i = 0; current.next && i < 3 && owner; i += 1) {
      const p = current.next.prepared;
      const signed = await wallet.sign({ kind: 'typedData', typedData: walletTypedData(p.typedData) });
      if (signed.status !== 'signed') {
        await api.venueFollowAbandon(current.followId);
        // That request has ended; pressing Start copying again is a new request, with its own key.
        setRequestKey(`copy-start:${Date.now().toString(36)}`);
        setFailure({
          ok: false,
          reason: 'error',
          message: '',
          code: signed.status === 'rejected' ? 'trade.copy_venue_wallet_rejected' : 'trade.copy_venue_wallet_failed',
        });
        return null;
      }
      const sent = await api.venueFollowSubmit(current.followId, current.next.actionKey, {
        digest: p.digest,
        signature: signed.signature,
        signedBy: owner,
      });
      if (!sent.ok) {
        setFailure(sent);
        return null;
      }
      current = sent.data;
    }
    return current;
  }

  const confirm = async () => {
    const expiresAt = instantOf(expiry);
    if (!expiresAt || busy || !owner) return;
    setBusy(true);
    setFailure(null);
    try {
      const started = await api.venueFollow({
        ...(listed ? { leaderRef: listed.leaderRef } : { leaderId: leader.trim() }),
        region: region.trim().toUpperCase(),
        permittedMarkets: picked,
        maxNotionalPerOrder: perOrder,
        maxAggregateExposure: aggregate,
        fixedOrderSize: fixed,
        expiresAt,
        clientRequestId: requestKey,
        owner,
      });
      if (!started.ok) return setFailure(started);
      const done = await signNext(started.data);
      if (!done) return;
      if (done.status !== 'active' || !done.follow) {
        return setFailure({ ok: false, reason: 'error', message: '', code: 'trade.copy_venue_permission_pending' });
      }
      // Starting to copy is also the grant to place each copy as you; it can be turned off on the follow.
      const granted = await api.grantCopying(done.followId);
      if (!granted.ok) return setFailure(granted);
      onFollowed();
      onOpenChange(false);
      reset();
    } finally {
      setBusy(false);
    }
  };

  const share = bpsText(desk?.leaderShareBps ?? null);
  return (
    <Dialog
      open={open}
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
            {failure?.code === 'trade.copy_venue_balance_short' && problems.balance ? (
              <p className="cb-error" role="alert">
                {problems.balance}
              </p>
            ) : null}
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
                  'Your wallet is asked to sign a permission for this follow on your own venue account. It can place and cancel orders there and can never withdraw. Nothing is moved or held by INTAFACED.',
                )}
              </InfoNote>
            </section>
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
            <Button onClick={() => void confirm()} loading={busy} disabled={!owner}>
              {t('Start copying')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
