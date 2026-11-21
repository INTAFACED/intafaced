import { useMemo, useState } from 'react';
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Field,
  Input,
  KeyValue,
  Page,
  PageHeader,
  PageSection,
  type BadgeTone,
} from '@intafaced/ui';
import type { z } from 'zod';
import type { recurringRuleSchema } from '@intafaced/contracts/trade-recurring-procedures';
import { useApi, useSession } from '../../../features/session/session';
import { useWallet } from '../../../features/protocol/wallet/WalletProvider';
import { useVenueMode } from '../../../features/trade/use-venue-mode';
import { TestMark, VenueFrame, WalletBar, useOwner, useVenueApi } from '../../../features/trade/venue/VenueKit';
import { draftId, keys, preparedAnswerSchema, walletTypedData, type VenueUp } from '../../../features/trade/venue-api';
import type { ApiResult } from '../../../shared/api';
import { displayAmount } from '../../../shared/money';
import { useResource } from '../../../shared/resource';
import { createRoomApi } from './api';
import { roomCopy } from './copy';
import type { Failure } from './guard';
import { InfoNote, RefusalNote } from './parts';

/**
 * The recurring buy of a basket on the person's own venue account (J-copy-bots-otc-16; svc-trade
 * src/recurring/recurring-buys.ts). INTAFACED holds and moves nothing: each slot buys each coin as one venue order on the
 * person's own account, placed by the recurring-buy agent permission their wallet signs once. The form opens from a coin
 * page; the rules are managed at /trade/bots/dca, and each has a share page at /trade/bots/dca/share/<ruleId>.
 */

export type RecurringRule = z.output<typeof recurringRuleSchema>;
type RoomApi = ReturnType<typeof createRoomApi>;

export const DCA_HREF = '/trade/bots/dca';
const FREQUENCIES = [
  { value: 'hourly', label: 'Hourly' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
] as const;
type Frequency = (typeof FREQUENCIES)[number]['value'];

const STATUS_WORD: Record<RecurringRule['status'], string> = {
  signing: 'Waiting for your wallet',
  active: 'Active',
  suspended_insufficient_funds: 'Suspended: not enough funds',
  completed: 'Finished: most to invest reached',
  terminated: 'Ended',
};
const STATUS_TONE: Record<RecurringRule['status'], BadgeTone> = {
  signing: 'warn',
  active: 'lime',
  suspended_insufficient_funds: 'warn',
  completed: 'neutral',
  terminated: 'neutral',
};
const OUTCOME_WORD: Record<RecurringRule['slots'][number]['outcome'], string> = {
  pending: 'Buying',
  bought: 'Bought',
  skipped_insufficient_funds: 'Skipped: not enough funds',
  skipped_not_permitted: 'Skipped',
};

const failed = (code: string): Failure => ({ ok: false, reason: 'error', message: '', code });
const newRequestKey = () => `recurring-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** The scaled sum of typed percentages, two decimals; null when one is not a number. */
function weightTotal(weights: readonly string[]): string | null {
  let cents = 0n;
  for (const w of weights) {
    const m = /^([0-9]+)(?:\.([0-9]{1,2}))?$/.exec(w.trim());
    if (!m) return null;
    cents += BigInt(m[1]!) * 100n + BigInt((m[2] ?? '').padEnd(2, '0'));
  }
  const whole = cents / 100n;
  const frac = cents % 100n;
  return frac === 0n ? whole.toString() : `${whole}.${frac.toString().padStart(2, '0').replace(/0$/, '')}`;
}

function useRoomApi(): RoomApi {
  const transport = useApi();
  return useMemo(() => createRoomApi(transport), [transport]);
}

/** The wallet signs what the service asks for: our builder fee once, then the recurring-buy agent permission. */
function useWalletSteps(api: RoomApi, status: VenueUp) {
  const wallet = useWallet();
  const venue = useVenueApi();
  const owner = useOwner();
  const [approvalDraft] = useState(() => draftId());

  async function sign(typed: unknown): Promise<{ ok: true; signature: string } | { ok: false; failure: Failure }> {
    const parsed = preparedAnswerSchema.shape.prepared.shape.typedData.safeParse(typed);
    if (!parsed.success) return { ok: false, failure: failed('trade.recurring_wallet_failed') };
    const signed = await wallet.sign({ kind: 'typedData', typedData: walletTypedData(parsed.data) });
    if (signed.status === 'signed') return { ok: true, signature: signed.signature };
    return {
      ok: false,
      failure: failed(signed.status === 'rejected' ? 'trade.recurring_wallet_rejected' : 'trade.recurring_wallet_failed'),
    };
  }

  async function approveBuilder(): Promise<Failure | null> {
    const builder = status.builder;
    if (!builder || !owner) return failed('trade.recurring_builder_fee_unapproved');
    const prepared = await venue.prepare({
      owner,
      intent: { kind: 'approve_builder_fee', builder: builder.address, maxFeeBps: builder.feeBps },
      actionKey: keys.builderApproval(owner, builder.address, builder.feeBps, undefined, approvalDraft),
    });
    if (!prepared.ok) return prepared;
    if (prepared.data.lastOutcome?.definite && prepared.data.lastOutcome.accepted) return null;
    const signed = await sign(prepared.data.prepared.typedData);
    if (!signed.ok) return signed.failure;
    const sent = await venue.submit(prepared.data.actionKey, {
      digest: prepared.data.prepared.digest,
      signature: signed.signature,
      signedBy: owner,
    });
    if (!sent.ok) return sent;
    return sent.data.outcome.definite && sent.data.outcome.accepted ? null : failed('trade.recurring_builder_fee_unapproved');
  }

  async function permit(rule: RecurringRule): Promise<ApiResult<RecurringRule>> {
    const next = rule.next;
    if (!next || !owner) return { ok: true, data: rule };
    const signed = await sign(next.typedData);
    if (!signed.ok) return signed.failure;
    return api.recurringSubmitPermission({
      ruleId: rule.ruleId,
      actionKey: next.actionKey,
      signature: { digest: next.digest, signature: signed.signature, signedBy: owner },
    });
  }

  return { owner, approveBuilder, permit };
}

/** On a coin page: the button that opens the recurring buy form with the page's coin as the first row. */
export function RecurringBuyButton({ asset }: { asset: string }) {
  const { t } = roomCopy.useCopy();
  const { session } = useSession();
  const [open, setOpen] = useState(false);
  const venueMode = useVenueMode();
  if (!session) return null;
  const venueUp = venueMode.mode === 'on' && venueMode.status.available ? venueMode.status : null;
  const dialog = (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="cb-dialog">
        <DialogHeader>
          <DialogTitle>{t('Recurring buy')}</DialogTitle>
          <DialogDescription>
            {t('Buy a basket of coins on a schedule, on your own venue account. Each time, each coin is bought as one order there.')}
          </DialogDescription>
        </DialogHeader>
        {venueUp ? <RecurringEditor asset={asset} status={venueUp} /> : <RefusalNote failure={failed('trade.recurring_unavailable')} />}
      </DialogContent>
    </Dialog>
  );
  return (
    <>
      <Button variant="secondary" fullWidth onClick={() => setOpen(true)}>
        {t('Recurring buy')}
      </Button>
      {venueMode.mode === 'on' ? <VenueFrame mode={venueMode}>{dialog}</VenueFrame> : dialog}
    </>
  );
}

type Row = { symbol: string; weight: string; lowest: string; highest: string };

function RecurringEditor({ asset, status }: { asset: string; status: VenueUp }) {
  const { t } = roomCopy.useCopy();
  const api = useRoomApi();
  const venue = useVenueApi();
  const steps = useWalletSteps(api, status);
  const markets = useResource((signal) => venue.markets(signal), 'recurring-venue-markets');
  const spot = useMemo(
    () =>
      markets.resource.status === 'ready'
        ? markets.resource.data.value.filter((m) => m.kind === 'spot' && m.quoteAsset === 'USDC').map((m) => m.symbol)
        : [],
    [markets.resource],
  );
  const first = `${asset}-USDC`;
  const [rows, setRows] = useState<Row[]>([{ symbol: first, weight: '100', lowest: '', highest: '' }]);
  const [funding, setFunding] = useState<'venue' | 'card'>('venue');
  const [amount, setAmount] = useState('');
  const [frequency, setFrequency] = useState<Frequency>('daily');
  const [maxInvestment, setMaxInvestment] = useState('');
  const [requestId, setRequestId] = useState(newRequestKey);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [saved, setSaved] = useState<RecurringRule | null>(null);
  const set = (i: number, patch: Partial<Row>) => setRows((all) => all.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  if (saved) {
    return (
      <div className="cb-form">
        <p role="status" className="cb-note-body">
          {saved.status === 'signing'
            ? t('Saved. Nothing is bought until your wallet signs the permission.')
            : t('Saved. It buys {amount} {asset} each time, starting now.', {
                amount: displayAmount(saved.amount),
                asset: saved.quoteAsset,
              })}
        </p>
        <Button nativeButton={false} render={<a href={DCA_HREF} />}>
          {t('Open my recurring buys')}
        </Button>
      </div>
    );
  }

  async function save() {
    if (busy || funding === 'card') return;
    setBusy(true);
    setFailure(null);
    setDetail(null);
    const input = {
      clientRequestId: requestId,
      owner: steps.owner,
      funding,
      basket: rows.map((r) => ({ symbol: r.symbol, weightPct: r.weight, lowestPrice: r.lowest, highestPrice: r.highest })),
      amount,
      frequency,
      maxInvestment,
    };
    let made = await api.recurringCreate(input);
    if (!made.ok && made.code === 'trade.recurring_builder_fee_unapproved' && steps.owner) {
      const refused = await steps.approveBuilder();
      made = refused ?? (await api.recurringCreate(input));
    }
    if (made.ok) made = await steps.permit(made.data);
    setBusy(false);
    if (made.ok) return setSaved(made.data);
    setFailure(made);
    // Which total or which row, in the words of what the person typed: the service refused it for that.
    if (made.code === 'trade.recurring_weights_not_100') {
      const total = weightTotal(rows.map((r) => r.weight));
      if (total !== null) setDetail(t('The weights add up to {total}%. They must add up to 100%.', { total }));
    }
    if (made.code === 'trade.recurring_price_range_inverted') {
      const n = rows.findIndex((r) => r.lowest !== '' && r.highest !== '' && Number(r.lowest) >= Number(r.highest));
      if (n >= 0) setDetail(t('Coin {n}: the lowest price must be below the highest price.', { n: String(n + 1) }));
    }
    if (made.reason !== 'uncertain' && made.code !== 'trade.recurring_wallet_rejected' && made.code !== 'trade.recurring_wallet_failed')
      setRequestId(newRequestKey());
  }

  return (
    <div className="cb-form">
      <WalletBar />
      <InfoNote>
        {t(
          'It trades on your own {venue} account, under an agent permission your wallet signs once. It can place and cancel orders there, never withdraw.',
          { venue: status.venue.displayName },
        )}{' '}
        <TestMark test={status.test} />
      </InfoNote>
      <fieldset className="cb-form" aria-label={t('Pay with')}>
        <legend className="cb-label">{t('Pay with')}</legend>
        <label>
          <input type="radio" name="recurring-funding" checked={funding === 'venue'} onChange={() => setFunding('venue')} />{' '}
          {t('USDC on your venue account')}
        </label>
        <label>
          <input type="radio" name="recurring-funding" checked={funding === 'card'} onChange={() => setFunding('card')} /> {t('Card')}
        </label>
      </fieldset>
      {funding === 'card' ? (
        <InfoNote tone="warn">
          {t('Card funding needs the card processor, which is switched off in this build. Nothing is saved with a card.')}
        </InfoNote>
      ) : null}
      {rows.map((row, i) => {
        const n = String(i + 1);
        return (
          <fieldset key={i} className="cb-form" aria-label={t('Coin {n} in the basket', { n })}>
            <label className="cb-selectfield">
              <span className="cb-label">{t('Coin {n}', { n })}</span>
              <select
                aria-label={t('Coin {n}', { n })}
                value={row.symbol}
                onChange={(e) => set(i, { symbol: e.target.value })}
                disabled={busy}
              >
                {[...new Set([row.symbol, ...spot])].map((s) => (
                  <option key={s} value={s}>
                    {s.replace(/-USDC$/, '')}
                  </option>
                ))}
              </select>
            </label>
            <Field label={t('Weight {n}, %', { n })}>
              <Input
                kind="decimal"
                value={row.weight}
                onValueChange={(v) => set(i, { weight: v })}
                precision={2}
                trailing="%"
                disabled={busy}
              />
            </Field>
            <Field label={t('Lowest price {n}', { n })}>
              <Input
                kind="decimal"
                value={row.lowest}
                onValueChange={(v) => set(i, { lowest: v })}
                precision={8}
                trailing="USDC"
                disabled={busy}
              />
            </Field>
            <Field label={t('Highest price {n}', { n })}>
              <Input
                kind="decimal"
                value={row.highest}
                onValueChange={(v) => set(i, { highest: v })}
                precision={8}
                trailing="USDC"
                disabled={busy}
              />
            </Field>
          </fieldset>
        );
      })}
      <Button
        variant="secondary"
        disabled={busy || rows.length >= 10}
        onClick={() =>
          setRows((all) => [
            ...all,
            { symbol: spot.find((s) => !all.some((r) => r.symbol === s)) ?? first, weight: '', lowest: '', highest: '' },
          ])
        }
      >
        {t('Add a coin')}
      </Button>
      <Field label={t('Amount each time (USDC)')}>
        <Input kind="decimal" value={amount} onValueChange={setAmount} precision={2} trailing="USDC" disabled={busy} />
      </Field>
      <label className="cb-selectfield">
        <span className="cb-label">{t('How often')}</span>
        <select aria-label={t('How often')} value={frequency} onChange={(e) => setFrequency(e.target.value as Frequency)} disabled={busy}>
          {FREQUENCIES.map((f) => (
            <option key={f.value} value={f.value}>
              {t(f.label)}
            </option>
          ))}
        </select>
      </label>
      <Field label={t('Most to invest (USDC)')}>
        <Input kind="decimal" value={maxInvestment} onValueChange={setMaxInvestment} precision={2} trailing="USDC" disabled={busy} />
      </Field>
      <p className="cb-note-body">{t('Leave it blank and the recurring buy never ends by itself.')}</p>
      <Button disabled={busy || funding === 'card'} onClick={() => void save()}>
        {t('Save')}
      </Button>
      {detail ? (
        <p role="alert" className="cb-note-body">
          {detail}
        </p>
      ) : null}
      {failure ? <RefusalNote failure={failure} /> : null}
    </div>
  );
}

/** `/trade/bots/dca`: the person's recurring buys, each managed in place; `/trade/bots/dca/share/<id>`: its share page. */
export function RecurringRoom({ path }: { path: string }) {
  const { t } = roomCopy.useCopy();
  const { session } = useSession();
  const venueMode = useVenueMode();
  const pathname = new URL(path, 'http://x').pathname.replace(/\/+$/, '');
  const share = /^\/trade\/bots\/dca\/share\/([^/]+)$/.exec(pathname);
  const body = !session ? (
    <EmptyState
      variant="refused"
      title={t('You are signed out')}
      reason={t('Sign in to see your recurring buys.')}
      action={{ label: t('Sign in'), href: `/login?redirect=${encodeURIComponent(pathname)}` }}
    />
  ) : share ? (
    <RecurringShare ruleId={decodeURIComponent(share[1]!)} />
  ) : (
    <RecurringList />
  );
  return (
    <Page>
      <PageHeader title={share ? t('Recurring buy result') : t('Recurring buy (DCA)')} />
      {venueMode.mode === 'on' ? <VenueFrame mode={venueMode}>{body}</VenueFrame> : body}
    </Page>
  );
}

function RecurringList() {
  const { t } = roomCopy.useCopy();
  const api = useRoomApi();
  const list = useResource((signal) => api.recurringList(signal), 'recurring-list');
  const [open, setOpen] = useState<string | null>(null);
  if (list.resource.status === 'loading') return <p className="cb-note-body">{t('Checking')}</p>;
  if (list.resource.status === 'failed') return <RefusalNote failure={list.resource.failure} retry={list.reload} />;
  const rules = list.resource.data;
  return (
    <PageSection title={t('My recurring buys')}>
      <p className="cb-note-body">{t('Set one up from any coin page with Recurring buy.')}</p>
      {rules.length === 0 ? (
        <EmptyState title={t('No recurring buys yet')} reason={t('A recurring buy you save shows here.')} />
      ) : (
        <table className="cb-table" aria-label={t('My recurring buys')}>
          <thead>
            <tr>
              <th scope="col">{t('Recurring buy')}</th>
              <th scope="col">{t('State')}</th>
              <th scope="col">{t('Amount each time')}</th>
              <th scope="col">{t('Action')}</th>
            </tr>
          </thead>
          <tbody>
            {rules.map((rule) => (
              <tr key={rule.ruleId}>
                <td>{t('Recurring buy {basket}', { basket: basketLine(rule) })}</td>
                <td>
                  <Badge tone={STATUS_TONE[rule.status]}>{t(STATUS_WORD[rule.status] as 'Active')}</Badge>
                </td>
                <td className="numeric">
                  {displayAmount(rule.amount)} {rule.quoteAsset}
                </td>
                <td>
                  <Button variant="secondary" size={32} onClick={() => setOpen(rule.ruleId)}>
                    {t('Manage')}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {open ? (
        <RecurringManage
          ruleId={open}
          onClose={() => {
            setOpen(null);
            list.reload();
          }}
        />
      ) : null}
    </PageSection>
  );
}

const basketLine = (rule: RecurringRule) => rule.basket.map((b) => `${b.baseAsset} ${displayAmount(b.weightPct)}%`).join(', ');

function RecurringManage({ ruleId, onClose }: { ruleId: string; onClose: () => void }) {
  const { t } = roomCopy.useCopy();
  const api = useRoomApi();
  const [rule, setRule] = useState<RecurringRule | null>(null);
  const read = useResource((signal) => api.recurringGet(ruleId, signal), `recurring-get:${ruleId}`);
  const shown = rule ?? (read.resource.status === 'ready' ? read.resource.data : null);
  const [amount, setAmount] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const ended = shown ? shown.status === 'terminated' || shown.status === 'completed' : true;

  async function run(f: () => Promise<ApiResult<RecurringRule>>, done: (r: RecurringRule) => string) {
    setBusy(true);
    setFailure(null);
    const res = await f();
    setBusy(false);
    if (!res.ok) return setFailure(res);
    setRule(res.data);
    setNote(done(res.data));
  }

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="cb-dialog">
        <DialogHeader>
          <DialogTitle>{t('Manage recurring buy')}</DialogTitle>
          <DialogDescription>{shown ? basketLine(shown) : t('Checking')}</DialogDescription>
        </DialogHeader>
        {!shown ? (
          read.resource.status === 'failed' ? (
            <RefusalNote failure={read.resource.failure} retry={read.reload} />
          ) : null
        ) : (
          <div className="cb-form">
            <KeyValue
              items={[
                { label: t('State'), value: t(STATUS_WORD[shown.status] as 'Active') },
                { label: t('How often'), value: t(FREQUENCIES.find((f) => f.value === shown.frequency)!.label) },
                {
                  label: t('Most to invest'),
                  value: shown.maxInvestment === null ? t('Not set') : `${displayAmount(shown.maxInvestment)} ${shown.quoteAsset}`,
                },
                { label: t('Trades on'), value: t('Your {venue} account {owner}', { venue: shown.venue.name, owner: shown.venue.owner }) },
                { label: t('Agent permission'), value: `${shown.venue.agentName} ${shown.venue.agentAddress}` },
              ]}
            />
            <TestMark test={shown.venue.test} />
            {shown.status === 'suspended_insufficient_funds' ? (
              <InfoNote tone="warn">
                {t('Suspended: your venue account had less than {amount} {asset} free. It resumes by itself once the funds arrive.', {
                  amount: displayAmount(shown.amount),
                  asset: shown.quoteAsset,
                })}
              </InfoNote>
            ) : null}
            <Field label={t('Amount each time (USDC)')}>
              <Input
                kind="decimal"
                value={amount ?? shown.amount}
                onValueChange={setAmount}
                precision={2}
                trailing={shown.quoteAsset}
                disabled={busy || ended}
              />
            </Field>
            <Button
              disabled={busy || ended}
              onClick={() =>
                void run(
                  () => api.recurringUpdate({ ruleId, amount: amount ?? shown.amount, maxInvestment: shown.maxInvestment }),
                  (r) =>
                    t('Saved. The next buy spends {amount} {asset}; earlier buys are unchanged.', {
                      amount: displayAmount(r.amount),
                      asset: r.quoteAsset,
                    }),
                )
              }
            >
              {t('Save')}
            </Button>
            <Slots rule={shown} />
            {shown.conversions.length > 0 ? (
              <KeyValue
                items={shown.conversions.map((c) => ({
                  label: t('Converted {coin}', { coin: c.symbol.replace(/-USDC$/, '') }),
                  value: `${displayAmount(c.filled)} → ${displayAmount(c.received)} ${shown.quoteAsset}`,
                }))}
              />
            ) : null}
            <Button nativeButton={false} variant="secondary" render={<a href={`${DCA_HREF}/share/${encodeURIComponent(shown.ruleId)}`} />}>
              {t('Open the share page')}
            </Button>
            {shown.status !== 'terminated' ? (
              <Button variant="secondary" disabled={busy} onClick={() => setConfirming(true)}>
                {t('End this recurring buy')}
              </Button>
            ) : null}
            {note ? (
              <p role="status" className="cb-note-body">
                {note}
              </p>
            ) : null}
            {failure ? <RefusalNote failure={failure} /> : null}
          </div>
        )}
        {confirming && shown ? (
          <Confirm
            title={t('End this recurring buy?')}
            body={t('No buy runs again, and the coins it bought are sold for {asset} once, at the venue’s best bid.', {
              asset: shown.quoteAsset,
            })}
            action={t('End and convert to {asset}', { asset: shown.quoteAsset })}
            onCancel={() => setConfirming(false)}
            onConfirm={() => {
              setConfirming(false);
              void run(
                () => api.recurringTerminate(ruleId),
                () => t('Ended. What it bought was sold once.'),
              );
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function Confirm(props: { title: string; body: string; action: string; onCancel: () => void; onConfirm: () => void }) {
  const { t } = roomCopy.useCopy();
  return (
    <section role="alertdialog" aria-label={props.title} className="cb-note" data-tone="warn">
      <div>
        <p className="cb-note-title">{props.title}</p>
        <p className="cb-note-body">{props.body}</p>
        <div className="cb-action-row">
          <Button variant="secondary" onClick={props.onCancel}>
            {t('Keep it')}
          </Button>
          <Button onClick={props.onConfirm}>{props.action}</Button>
        </div>
      </div>
    </section>
  );
}

function Slots({ rule }: { rule: RecurringRule }) {
  const { t } = roomCopy.useCopy();
  if (rule.slots.length === 0) return <p className="cb-note-body">{t('No buy has run yet.')}</p>;
  return (
    <table className="cb-table" aria-label={t('Buys')}>
      <thead>
        <tr>
          <th scope="col">{t('Buy')}</th>
          <th scope="col">{t('Amount')}</th>
          <th scope="col">{t('Spent')}</th>
          <th scope="col">{t('State')}</th>
        </tr>
      </thead>
      <tbody>
        {rule.slots.map((s) => (
          <tr key={s.slot}>
            <td className="numeric">{s.slot + 1}</td>
            <td className="numeric">
              {displayAmount(s.amount)} {rule.quoteAsset}
            </td>
            <td className="numeric">
              {displayAmount(s.spent)} {rule.quoteAsset}
            </td>
            <td>{t(OUTCOME_WORD[s.outcome] as 'Bought')}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * The share page: cost is always shown; value reads Not set while a coin has no mark on the venue, and the profit
 * percentage appears only with a value. Sharing writes nothing: the sheet only offers the words and the link to copy.
 */
function RecurringShare({ ruleId }: { ruleId: string }) {
  const { t } = roomCopy.useCopy();
  const api = useRoomApi();
  const read = useResource((signal) => api.recurringGet(ruleId, signal), `recurring-share:${ruleId}`);
  const [sheet, setSheet] = useState(false);
  if (read.resource.status === 'loading') return <p className="cb-note-body">{t('Checking')}</p>;
  if (read.resource.status === 'failed') return <RefusalNote failure={read.resource.failure} retry={read.reload} />;
  const rule = read.resource.data;
  const { cost, value, profitPct } = rule.result;
  const lines: { label: string; value: string }[] = [
    { label: t('Basket'), value: basketLine(rule) },
    { label: t('Cost'), value: `${displayAmount(cost)} ${rule.quoteAsset}` },
    { label: t('Value'), value: value === null ? t('Not set') : `${displayAmount(value)} ${rule.quoteAsset}` },
  ];
  if (profitPct !== null) lines.push({ label: t('Profit'), value: `${displayAmount(profitPct)}%` });
  const text = [
    t('My recurring buy of {basket}', { basket: basketLine(rule) }),
    t('Cost {amount} {asset}', { amount: displayAmount(cost), asset: rule.quoteAsset }),
    value === null ? t('Value Not set') : t('Value {amount} {asset}', { amount: displayAmount(value), asset: rule.quoteAsset }),
    ...(profitPct === null ? [] : [t('Profit {pct}%', { pct: displayAmount(profitPct) })]),
  ].join('\n');
  return (
    <PageSection title={basketLine(rule)}>
      <section role="region" aria-label={t('Recurring buy result')} className="cb-form">
        <KeyValue items={lines} />
        {value === null ? <InfoNote>{t('Value is Not set while a coin in the basket has no price on the venue.')}</InfoNote> : null}
        <TestMark test={rule.venue.test} />
      </section>
      <Button onClick={() => setSheet(true)}>{t('Share')}</Button>
      <Dialog open={sheet} onOpenChange={setSheet}>
        <DialogContent className="cb-dialog">
          <DialogHeader>
            <DialogTitle>{t('Share your result')}</DialogTitle>
            <DialogDescription>{t('Copy these words to share them. Nothing is sent from here.')}</DialogDescription>
          </DialogHeader>
          <pre className="cb-note-body" data-testid="recurring-share-text">
            {text}
          </pre>
          <Button variant="secondary" onClick={() => void navigator.clipboard?.writeText(text).catch(() => undefined)}>
            {t('Copy')}
          </Button>
        </DialogContent>
      </Dialog>
    </PageSection>
  );
}
