import { type ReactNode, useId, useMemo, useState } from 'react';
import { Button, Radio, type MoneyStatus } from '@intafaced/ui/lit';
import { KeyValue, SelectField, StatusChip, TextField } from '@intafaced/ui/lit/templates';
import type { z } from 'zod';
import type { recurringRuleSchema } from '@intafaced/contracts/trade-recurring-procedures';
import { useApi, useSession } from '../../../features/session/session';
import { useWallet } from '../../../features/protocol/wallet/WalletProvider';
import { useVenueMode } from '../../../features/trade/use-venue-mode';
import { useOwner, useVenueApi } from '../../../features/trade/venue/VenueKit';
import { TestMark, VenueFrame, WalletBar } from '../../../features/trade/venue/volt/VoltVenue';
import { draftId, keys, preparedAnswerSchema, walletTypedData, type VenueUp } from '../../../features/trade/venue-api';
import type { ApiResult } from '../../../shared/api';
import { displayAmount } from '../../../shared/money';
import { useResource } from '../../../shared/resource';
import { createRoomApi } from './api';
import { roomCopy } from './copy';
import type { Failure } from './guard';
import { InfoNote, RefusalNote } from './notes';
import { KitDialog, KitState, LinkButton, typedDecimal } from '../kit-parts';

/**
 * The recurring buy of a basket on the person's own venue account (J-copy-bots-otc-16; svc-trade
 * src/recurring/recurring-buys.ts). INTAFACED holds and moves nothing: each slot buys each coin as one venue order on the
 * person's own account, placed by the recurring-buy agent permission their wallet signs once. The form opens from a coin
 * page; the rules are managed at /trade/bots/dca, and each has a share page at /trade/bots/dca?share=<ruleId>.
 */

export type RecurringRule = z.output<typeof recurringRuleSchema>;
type RoomApi = ReturnType<typeof createRoomApi>;

const DCA_HREF = '/trade/bots/dca';
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
const STATUS_MARK: Record<RecurringRule['status'], MoneyStatus> = {
  signing: 'pending',
  active: 'done',
  suspended_insufficient_funds: 'pending',
  completed: 'unknown',
  terminated: 'unknown',
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
function useWalletSteps(api: RoomApi, status: VenueUp, onSigning: (signing: boolean) => void) {
  const wallet = useWallet();
  const venue = useVenueApi();
  const owner = useOwner();
  const [approvalDraft] = useState(() => draftId());

  async function sign(typed: unknown): Promise<{ ok: true; signature: string } | { ok: false; failure: Failure }> {
    const parsed = preparedAnswerSchema.shape.prepared.shape.typedData.safeParse(typed);
    if (!parsed.success) return { ok: false, failure: failed('trade.recurring_wallet_failed') };
    onSigning(true);
    const signed = await wallet.sign({ kind: 'typedData', typedData: walletTypedData(parsed.data) }).finally(() => onSigning(false));
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
  const title = t('Recurring buy');
  const description = t(
    'Buy a basket of coins on a schedule, on your own venue account. Each time, each coin is bought as one order there.',
  );
  // Mounted when the form opens, so each opening is a new request with its own key.
  const dialog = !open ? null : venueUp ? (
    <RecurringEditor asset={asset} status={venueUp} title={title} description={description} onClose={() => setOpen(false)} />
  ) : (
    <KitDialog title={title} description={description} onClose={() => setOpen(false)}>
      <RefusalNote failure={failed('trade.recurring_unavailable')} />
    </KitDialog>
  );
  return (
    <>
      <Button tone="secondary" block onClick={() => setOpen(true)}>
        {t('Recurring buy')}
      </Button>
      {venueMode.mode === 'on' ? <VenueFrame mode={venueMode}>{dialog}</VenueFrame> : dialog}
    </>
  );
}

type Row = { symbol: string; weight: string; lowest: string; highest: string };

/** A decimal box with its words above it and its unit under it; it refuses a keystroke past `places` decimals. */
function DecimalField({
  label,
  value,
  onChange,
  places,
  unit,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  places: number;
  unit: string;
  disabled?: boolean;
}) {
  return (
    <TextField
      label={label}
      type="text"
      inputMode="decimal"
      autoComplete="off"
      spellCheck={false}
      value={value}
      onChange={(raw) => {
        const next = typedDecimal(raw, places);
        if (next !== null) onChange(next);
      }}
      hint={unit}
      disabled={disabled}
    />
  );
}

function RecurringEditor({
  asset,
  status,
  title,
  description,
  onClose,
}: {
  asset: string;
  status: VenueUp;
  title: string;
  description: string;
  onClose: () => void;
}) {
  const { t } = roomCopy.useCopy();
  const api = useRoomApi();
  const venue = useVenueApi();
  // While the wallet asks, its own "Check before you sign" sheet is the only thing on screen: this modal would hide it from
  // the accessibility tree and block pointer input to it. The form keeps its state and comes back once the wallet answers.
  const [signing, setSigning] = useState(false);
  const steps = useWalletSteps(api, status, setSigning);
  const frame = (body: ReactNode) =>
    signing ? null : (
      <KitDialog title={title} description={description} onClose={onClose}>
        {body}
      </KitDialog>
    );
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
    return frame(
      <div className="lt-stack">
        <p role="status">
          {saved.status === 'signing'
            ? t('Saved. Nothing is bought until your wallet signs the permission.')
            : t('Saved. It buys {amount} {asset} each time, starting now.', {
                amount: displayAmount(saved.amount),
                asset: saved.quoteAsset,
              })}
        </p>
        <LinkButton href={DCA_HREF}>{t('Open my recurring buys')}</LinkButton>
      </div>,
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

  return frame(
    <div className="lt-stack">
      <WalletBar />
      <InfoNote>
        {t(
          'It trades on your own {venue} account, under an agent permission your wallet signs once. It can place and cancel orders there, never withdraw.',
          { venue: status.venue.displayName },
        )}{' '}
        <TestMark test={status.test} />
      </InfoNote>
      <fieldset className="lt-stack" aria-label={t('Pay with')}>
        <legend>{t('Pay with')}</legend>
        <Radio name="recurring-funding" checked={funding === 'venue'} onSelect={() => setFunding('venue')}>
          {t('USDC on your venue account')}
        </Radio>
        <Radio name="recurring-funding" checked={funding === 'card'} onSelect={() => setFunding('card')}>
          {t('Card')}
        </Radio>
      </fieldset>
      {funding === 'card' ? (
        <InfoNote tone="warn">
          {t('Card funding needs the card processor, which is switched off in this build. Nothing is saved with a card.')}
        </InfoNote>
      ) : null}
      {rows.map((row, i) => {
        const n = String(i + 1);
        return (
          <fieldset key={i} className="lt-stack" aria-label={t('Coin {n} in the basket', { n })}>
            <SelectField
              label={t('Coin {n}', { n })}
              value={row.symbol}
              onChange={(symbol) => set(i, { symbol })}
              disabled={busy}
              options={[...new Set([row.symbol, ...spot])].map((s) => ({ value: s, label: s.replace(/-USDC$/, '') }))}
            />
            <DecimalField
              label={t('Weight {n}, %', { n })}
              value={row.weight}
              onChange={(v) => set(i, { weight: v })}
              places={2}
              unit="%"
              disabled={busy}
            />
            <DecimalField
              label={t('Lowest price {n}', { n })}
              value={row.lowest}
              onChange={(v) => set(i, { lowest: v })}
              places={8}
              unit="USDC"
              disabled={busy}
            />
            <DecimalField
              label={t('Highest price {n}', { n })}
              value={row.highest}
              onChange={(v) => set(i, { highest: v })}
              places={8}
              unit="USDC"
              disabled={busy}
            />
          </fieldset>
        );
      })}
      <Button
        tone="secondary"
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
      <DecimalField label={t('Amount each time (USDC)')} value={amount} onChange={setAmount} places={2} unit="USDC" disabled={busy} />
      <SelectField
        label={t('How often')}
        value={frequency}
        onChange={(next) => setFrequency(next as Frequency)}
        disabled={busy}
        options={FREQUENCIES.map((f) => ({ value: f.value, label: t(f.label) }))}
      />
      <DecimalField
        label={t('Most to invest (USDC)')}
        value={maxInvestment}
        onChange={setMaxInvestment}
        places={2}
        unit="USDC"
        disabled={busy}
      />
      <p className="lt-hint">{t('Leave it blank and the recurring buy never ends by itself.')}</p>
      <Button tone="primary" disabled={busy || funding === 'card'} onClick={() => void save()}>
        {t('Save')}
      </Button>
      {detail ? <p role="alert">{detail}</p> : null}
      {failure ? <RefusalNote failure={failure} /> : null}
    </div>,
  );
}

/** `/trade/bots/dca`: the person's recurring buys, each managed in place; `/trade/bots/dca?share=<id>`: its share page. */
export function RecurringRoom({ path }: { path: string }) {
  const { t } = roomCopy.useCopy();
  const { session } = useSession();
  const venueMode = useVenueMode();
  const url = new URL(path, 'http://x');
  const share = url.searchParams.get('share');
  const body = !session ? (
    <KitState
      kind="refused"
      title={t('You are signed out')}
      body={t('Sign in to see your recurring buys.')}
      action={{ label: t('Sign in'), href: `/login?redirect=${encodeURIComponent(url.pathname + url.search)}` }}
    />
  ) : share ? (
    <RecurringShare ruleId={share} />
  ) : (
    <RecurringList />
  );
  return (
    <div className="lt-stack">
      <header>
        <h1 className="lt-title">{share ? t('Recurring buy result') : t('Recurring buy (DCA)')}</h1>
      </header>
      {venueMode.mode === 'on' ? <VenueFrame mode={venueMode}>{body}</VenueFrame> : body}
    </div>
  );
}

/** A titled block of the room: its heading names the section. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  const titleId = useId();
  return (
    <section className="lt-stack" aria-labelledby={titleId}>
      <h2 id={titleId}>{title}</h2>
      {children}
    </section>
  );
}

/** A rule's state in words, with the kit's mark: active reads done, waiting and suspended pending, finished and ended neutral. */
function RuleState({ status }: { status: RecurringRule['status'] }) {
  const { t } = roomCopy.useCopy();
  return <StatusChip status={STATUS_MARK[status]} label={t(STATUS_WORD[status] as 'Active')} />;
}

function RecurringList() {
  const { t } = roomCopy.useCopy();
  const api = useRoomApi();
  const list = useResource((signal) => api.recurringList(signal), 'recurring-list');
  const [open, setOpen] = useState<string | null>(null);
  if (list.resource.status === 'loading') return <p className="lt-hint">{t('Checking')}</p>;
  if (list.resource.status === 'failed') return <RefusalNote failure={list.resource.failure} retry={list.reload} />;
  const rules = list.resource.data;
  return (
    <Section title={t('My recurring buys')}>
      <p className="lt-hint">{t('Set one up from any coin page with Recurring buy.')}</p>
      {rules.length === 0 ? (
        <KitState kind="empty" title={t('You have no recurring buys')} body={t('A recurring buy you save shows here.')} />
      ) : (
        <table className="lt-table" aria-label={t('My recurring buys')}>
          <thead>
            <tr>
              <th scope="col">{t('Recurring buy')}</th>
              <th scope="col">{t('State')}</th>
              <th scope="col" data-align="end">
                {t('Amount each time')}
              </th>
              <th scope="col">{t('Action')}</th>
            </tr>
          </thead>
          <tbody>
            {rules.map((rule) => (
              <tr key={rule.ruleId}>
                <td>{t('Recurring buy {basket}', { basket: basketLine(rule) })}</td>
                <td>
                  <RuleState status={rule.status} />
                </td>
                <td data-align="end">
                  {displayAmount(rule.amount)} {rule.quoteAsset}
                </td>
                <td>
                  <Button tone="secondary" onClick={() => setOpen(rule.ruleId)}>
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
    </Section>
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
    <KitDialog title={t('Manage recurring buy')} description={shown ? basketLine(shown) : t('Checking')} onClose={onClose}>
      {!shown ? (
        read.resource.status === 'failed' ? (
          <RefusalNote failure={read.resource.failure} retry={read.reload} />
        ) : null
      ) : (
        <div className="lt-stack">
          <KeyValue
            rows={[
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
          <DecimalField
            label={t('Amount each time (USDC)')}
            value={amount ?? shown.amount}
            onChange={setAmount}
            places={2}
            unit={shown.quoteAsset}
            disabled={busy || ended}
          />
          <Button
            tone="primary"
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
              rows={shown.conversions.map((c) => ({
                label: t('Converted {coin}', { coin: c.symbol.replace(/-USDC$/, '') }),
                value: `${displayAmount(c.filled)} → ${displayAmount(c.received)} ${shown.quoteAsset}`,
              }))}
            />
          ) : null}
          <LinkButton href={`${DCA_HREF}?share=${encodeURIComponent(shown.ruleId)}`}>{t('Open the share page')}</LinkButton>
          {shown.status !== 'terminated' ? (
            <Button tone="secondary" disabled={busy} onClick={() => setConfirming(true)}>
              {t('End this recurring buy')}
            </Button>
          ) : null}
          {note ? <p role="status">{note}</p> : null}
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
    </KitDialog>
  );
}

function Confirm(props: { title: string; body: string; action: string; onCancel: () => void; onConfirm: () => void }) {
  const { t } = roomCopy.useCopy();
  return (
    <section role="alertdialog" aria-label={props.title} className="lt-refusal" data-refusal="refused" data-tone="warn">
      <p className="lt-refusal-title">{props.title}</p>
      <p className="lt-refusal-body">{props.body}</p>
      <div className="lt-actions">
        <Button tone="secondary" onClick={props.onCancel}>
          {t('Keep it')}
        </Button>
        <Button tone="primary" onClick={props.onConfirm}>
          {props.action}
        </Button>
      </div>
    </section>
  );
}

function Slots({ rule }: { rule: RecurringRule }) {
  const { t } = roomCopy.useCopy();
  if (rule.slots.length === 0) return <p className="lt-hint">{t('No buy has run.')}</p>;
  return (
    <table className="lt-table" aria-label={t('Buys')}>
      <thead>
        <tr>
          <th scope="col" data-align="end">
            {t('Buy')}
          </th>
          <th scope="col" data-align="end">
            {t('Amount')}
          </th>
          <th scope="col" data-align="end">
            {t('Spent')}
          </th>
          <th scope="col">{t('State')}</th>
        </tr>
      </thead>
      <tbody>
        {rule.slots.map((s) => (
          <tr key={s.slot}>
            <td data-align="end">{s.slot + 1}</td>
            <td data-align="end">
              {displayAmount(s.amount)} {rule.quoteAsset}
            </td>
            <td data-align="end">
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
  if (read.resource.status === 'loading') return <p className="lt-hint">{t('Checking')}</p>;
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
    <Section title={basketLine(rule)}>
      <section role="region" aria-label={t('Recurring buy result')} className="lt-stack">
        <KeyValue rows={lines} />
        {value === null ? <InfoNote>{t('Value is Not set while a coin in the basket has no price on the venue.')}</InfoNote> : null}
        <TestMark test={rule.venue.test} />
      </section>
      <Button tone="primary" onClick={() => setSheet(true)}>
        {t('Share')}
      </Button>
      {sheet ? (
        <KitDialog
          title={t('Share your result')}
          description={t('Copy these words to share them. Nothing is sent from here.')}
          onClose={() => setSheet(false)}
        >
          <pre className="lt-pre-wrap" data-testid="recurring-share-text">
            {text}
          </pre>
          <Button tone="secondary" onClick={() => void navigator.clipboard?.writeText(text).catch(() => undefined)}>
            {t('Copy')}
          </Button>
        </KitDialog>
      ) : null}
    </Section>
  );
}
