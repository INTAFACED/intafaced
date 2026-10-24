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
import type { Listing } from '../../../features/trade/trade-api';
import { dec } from '../../../data/decimal';
import { displayAmount } from '../../../shared/money';
import { useBalances } from '../desk/data';
import type { CopyDesk, LeaderRow, RoomApi } from './api';
import { useLive } from './live';
import { bpsText, deskState } from './desk';
import { roomCopy } from './copy';
import type { WriteGuard } from './guard';
import { InfoNote, RefusalNote } from './parts';

type Step = 1 | 2 | 3 | 4;

/** The datetime-local box gives "2026-10-20T12:00" in the person's own zone; the service wants an instant. */
function instantOf(local: string): string | null {
  if (!local) return null;
  const when = new Date(local);
  return Number.isNaN(when.getTime()) ? null : when.toISOString();
}

export function FollowWizard({
  open,
  onOpenChange,
  api,
  guard,
  desk,
  markets,
  initialLeader,
  listed = null,
  onFollowed,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  api: RoomApi;
  guard: WriteGuard;
  desk: CopyDesk | null;
  markets: Listing[];
  initialLeader: string;
  /** A listed leader picked in the directory or on their page: followed by its public ref, not a typed ID. */
  listed?: LeaderRow | null;
  onFollowed: () => void;
}) {
  const { t } = roomCopy.useCopy();
  const [step, setStep] = useState<Step>(1);
  const [leader, setLeader] = useState(initialLeader);
  const [region, setRegion] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [perOrder, setPerOrder] = useState('');
  const [aggregate, setAggregate] = useState('');
  const [maxLoss, setMaxLoss] = useState('');
  const [useFixed, setUseFixed] = useState(true);
  const [fixed, setFixed] = useState('');
  const [expiry, setExpiry] = useState('');
  const [understood, setUnderstood] = useState(false);
  // One key per opening of the wizard: a second press of Start copying, or a retry after a lost answer, is the same
  // request and returns the same follow.
  const [requestKey, setRequestKey] = useState('');
  const state = deskState(desk);
  const balances = useBalances();
  const disclosure = useLive((signal) => api.disclosure(signal), `copy-disclosure:${open ? 'open' : 'closed'}`, null);
  useEffect(() => {
    if (open) {
      setLeader(initialLeader);
      setRequestKey(`copy-start:${Date.now().toString(36)}`);
    }
  }, [open, initialLeader]);

  const quote = useMemo(() => {
    const assets = new Set(markets.filter((m) => picked.includes(m.symbol)).map((m) => m.quote));
    return assets.size === 1 ? [...assets][0]! : null;
  }, [markets, picked]);

  const free = quote && balances.status === 'ready' ? (dec(balances.data[quote]?.free ?? '0') ?? 0n) : null;
  const problems = {
    leader: listed || leader.trim() ? '' : t('Enter the leader’s ID'),
    region: /^[A-Za-z]{2}$/.test(region.trim()) ? '' : t('Enter your country as two letters, for example ID'),
    markets: picked.length ? '' : t('Choose at least one market'),
    perOrder: (dec(perOrder) ?? 0n) > 0n ? '' : t('Enter an amount above zero'),
    aggregate:
      (dec(aggregate) ?? 0n) > 0n && (dec(aggregate) ?? 0n) >= (dec(perOrder) ?? 0n)
        ? ''
        : t('The total can’t be below the amount per order'),
    maxLoss: !maxLoss || (dec(maxLoss) ?? 0n) > 0n ? '' : t('Enter an amount above zero, or leave it empty'),
    fixed: !useFixed
      ? ''
      : (dec(fixed) ?? 0n) <= 0n
        ? t('Enter an amount above zero')
        : (dec(fixed) ?? 0n) > (dec(perOrder) ?? 0n)
          ? t('The most per order is {cap} {asset}', { cap: displayAmount(perOrder || '0'), asset: quote ?? '' })
          : '',
    reserve: free !== null && (dec(aggregate) ?? 0n) > free ? t('That is more than your free {asset}', { asset: quote ?? '' }) : '',
    expiry: instantOf(expiry) && new Date(expiry).getTime() > Date.now() ? '' : t('Choose a time in the future'),
    mixedQuote: picked.length > 0 && quote === null ? t('Choose markets that settle in the same asset') : '',
  };
  const valid1 = !problems.leader && !problems.region;
  const valid2 = !problems.markets && !problems.mixedQuote;
  const valid3 = !problems.perOrder && !problems.aggregate && !problems.maxLoss && !problems.fixed && !problems.reserve && !problems.expiry;
  const [touched, setTouched] = useState(false);
  const show = (message: string) => (touched ? message : '');

  const reset = () => {
    setStep(1);
    setTouched(false);
    setUnderstood(false);
    guard.setFailure(null);
  };
  const next = () => {
    setTouched(true);
    if ((step === 1 && valid1) || (step === 2 && valid2) || (step === 3 && valid3)) {
      setTouched(false);
      setStep((step + 1) as Step);
    }
  };
  const terms = disclosure.data;
  const confirm = () => {
    const expiresAt = instantOf(expiry);
    if (!expiresAt || guard.busy || guard.locked || !terms?.published || !terms.version) return;
    const version = terms.version;
    void guard.run(
      { kind: 'copy', id: `follow:${listed ? listed.leaderRef : leader.trim()}:${Date.now()}`, symbol: picked.join(',') },
      async () => {
        // Accepting is its own record, keyed by the version; the follow then goes through the same gate.
        if (!terms.accepted) {
          const accepted = await api.acceptDisclosure({ version, clientAcceptId: `copy-accept:${version}` });
          if (!accepted.ok) return accepted;
        }
        return api.follow({
          ...(listed ? { leaderRef: listed.leaderRef } : { leaderId: leader.trim() }),
          region: region.trim().toUpperCase(),
          permittedMarkets: picked,
          maxNotionalPerOrder: perOrder,
          maxAggregateExposure: aggregate,
          ...(maxLoss ? { maxLoss } : {}),
          ...(useFixed ? { fixedOrderSize: fixed } : {}),
          expiresAt,
          clientRequestId: requestKey,
        });
      },
      () => {
        disclosure.reload();
        onFollowed();
        onOpenChange(false);
        reset();
      },
    );
  };

  const asset = quote ?? '';
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
              {markets.length === 0 ? (
                <InfoNote>{t('No markets are open for copying right now.')}</InfoNote>
              ) : (
                <ul className="cb-checklist">
                  {markets.map((market) => (
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
            <Field label={t('Most per order ({asset})', { asset })} error={show(problems.perOrder)} required>
              <Input kind="decimal" value={perOrder} onValueChange={setPerOrder} precision={8} trailing={asset} />
            </Field>
            <Field
              label={t('Most in total ({asset})', { asset })}
              hint={t('All copied orders together can never go past this.')}
              error={show(problems.aggregate)}
              required
            >
              <Input kind="decimal" value={aggregate} onValueChange={setAggregate} precision={8} trailing={asset} />
            </Field>
            <KeyValue
              items={[
                {
                  label: t('Free {asset} now', { asset }),
                  value: balances.status === 'ready' ? `${displayAmount(balances.data[asset]?.free ?? '0')} ${asset}` : t('Balance unread'),
                },
                { label: t('Reserved for this copy'), value: aggregate ? `${displayAmount(aggregate)} ${asset}` : t('Not set') },
              ]}
            />
            {show(problems.reserve) ? (
              <p className="cb-error" role="alert">
                {problems.reserve}
              </p>
            ) : null}
            <label className="cb-check">
              <Checkbox checked={useFixed} onCheckedChange={(v) => setUseFixed(v === true)} />
              <span>{t('Use the same amount for every copied order')}</span>
            </label>
            {useFixed ? (
              <Field
                label={t('Fixed amount per copied order ({asset})', { asset })}
                hint={t('Each copied order uses this much, never more than the most per order.')}
                error={show(problems.fixed)}
                required
              >
                <Input kind="decimal" value={fixed} onValueChange={setFixed} precision={8} trailing={asset} />
              </Field>
            ) : null}
            <Field
              label={t('Stop at a loss of ({asset})', { asset })}
              hint={t('Optional. Copying stops when losses reach this.')}
              error={show(problems.maxLoss)}
            >
              <Input kind="decimal" value={maxLoss} onValueChange={setMaxLoss} precision={8} trailing={asset} />
            </Field>
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
            {guard.failure ? <RefusalNote failure={guard.failure} /> : null}
            <KeyValue
              items={[
                listed ? { label: t('Leader'), value: listed.displayName } : { label: t('Leader'), value: leader.trim(), mono: true },
                { label: t('Country'), value: region.trim().toUpperCase() },
                { label: t('Markets'), value: picked.join(', ') },
                { label: t('Most per order'), value: `${displayAmount(perOrder)} ${asset}` },
                { label: t('Most in total'), value: `${displayAmount(aggregate)} ${asset}` },
                { label: t('Reserved for this copy'), value: `${displayAmount(aggregate)} ${asset}` },
                {
                  label: t('Fixed amount per copied order'),
                  value: useFixed ? `${displayAmount(fixed)} ${asset}` : t('Not set'),
                },
                { label: t('Stop at a loss of'), value: maxLoss ? `${displayAmount(maxLoss)} ${asset}` : t('Not set') },
                { label: t('Permission ends'), value: new Date(expiry).toLocaleString() },
              ]}
            />
            <section aria-label={t('What it costs')} className="cb-cost">
              <h3>{t('What it costs')}</h3>
              <KeyValue
                items={[
                  { label: t('Fee on each copied order'), value: t('The same trading fee as trading alone') },
                  {
                    label: t('Leader’s share'),
                    value: share ? t('{share} of that fee, paid by the platform from the fee', { share }) : t('Not approved'),
                  },
                  { label: t('Extra charge on your profit'), value: t('None. Leaders are never paid from your profit') },
                ]}
              />
            </section>
            <InfoNote>{t('If you stop, new copies stop at once. Positions already open stay yours until you close them.')}</InfoNote>
            <section aria-label={t('Copy risk disclosure')} className="cb-disclosure">
              <h3>{t('Copy risk disclosure')}</h3>
              {disclosure.status === 'loading' ? (
                <p>{t('Loading')}</p>
              ) : disclosure.failure && !terms ? (
                <RefusalNote failure={disclosure.failure} retry={disclosure.reload} />
              ) : !terms?.published ? (
                <InfoNote tone="warn">{t('Not published. Copying can’t start until the platform publishes its risk disclosure.')}</InfoNote>
              ) : (
                <>
                  <p className="cb-disclosure-text">{terms.text}</p>
                  <p className="cb-meta">{t('Version {version}', { version: terms.version ?? '' })}</p>
                  <label className="cb-check">
                    <Checkbox
                      checked={terms.accepted || understood}
                      disabled={terms.accepted}
                      onCheckedChange={(v) => setUnderstood(v === true)}
                    />
                    <span>{terms.accepted ? t('You accepted this version.') : t('I have read this disclosure and accept it.')}</span>
                  </label>
                </>
              )}
            </section>
          </div>
        ) : null}

        <DialogFooter>
          {step > 1 ? (
            <Button variant="secondary" onClick={() => setStep((step - 1) as Step)} disabled={guard.busy}>
              {t('Back')}
            </Button>
          ) : null}
          {step < 4 ? (
            <Button onClick={next}>{t('Next')}</Button>
          ) : (
            <Button
              onClick={confirm}
              loading={guard.busy}
              disabled={!terms?.published || !(terms.accepted || understood) || guard.locked || !guard.signedIn}
            >
              {t('Start copying')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
