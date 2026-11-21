import { useState } from 'react';
import { Button, DataTable, Field } from '../../../shared/ui';
import { displayAmount, parseAmount, formatAmount } from '../../../shared/money';
import { usePolled } from '../../protocol';
import { draftId, keys, type AsOf, type VenueAccountMode, type VenueAccountModeRead, type VenueBalance } from '../venue-api';
import { VENUE_POLL_MS, useOwner, useVenueActions, useVenueApi, type ActionResult } from '../venue/VenueKit';
import { accountModeCopy } from './account-mode-copy';

/**
 * The venue account's mode (J-derivatives-29): the venue's own setting on the person's account, read from the venue and
 * changed only by the person's signed venue action, never by us. Standard keeps spot and perps apart, and USDC moves
 * between them by one signed transfer, sent once under its own key; unified and portfolio margin hold one balance for
 * each asset and the venue caps their actions a day. A mode the venue doesn't report reads "not known", and every action
 * that depends on it is refused before anything is signed. The ledger posts nothing for any of it.
 */

type T = ReturnType<typeof accountModeCopy.useCopy>['t'];
type Direction = 'perps_to_spot' | 'spot_to_perps';
const MODES: readonly VenueAccountMode[] = ['standard', 'unified', 'portfolio_margin'];
const USDC = 'USDC';
/** The share of the venue's daily action limit at which the order ticket warns: 90% (our choice; the venue sets the limit). */
const NEAR_LIMIT_SHARE = 0.9;

/** The account's mode as the venue reports it: `unknown` where it reports none, or the read is refused (not offered). */
export type AccountModeState =
  | { state: 'loading' }
  | { state: 'unknown'; asOf: string | null }
  | { state: 'known'; read: VenueAccountModeRead & { mode: VenueAccountMode }; asOf: string };

export function useAccountMode(owner: string | null, revision = 0, venueId?: string) {
  const api = useVenueApi();
  const read = usePolled(
    (signal) => (owner ? api.accountMode(owner, signal, venueId) : Promise.resolve(null)),
    `account-mode:${owner ?? ''}:${venueId ?? ''}:${revision}`,
    VENUE_POLL_MS,
  );
  const data: AsOf<VenueAccountModeRead> | null = read.data;
  const state: AccountModeState =
    data && data.value.mode !== null
      ? { state: 'known', read: { ...data.value, mode: data.value.mode }, asOf: data.asOf }
      : data || read.failure
        ? { state: 'unknown', asOf: data?.asOf ?? null }
        : { state: 'loading' };
  return { ...state, failure: read.failure, reload: read.reload };
}

const modeWord = (t: T, mode: VenueAccountMode) => t(mode);
const meaningOf = (t: T, mode: VenueAccountMode) =>
  mode === 'standard' ? t('meaningStandard') : mode === 'unified' ? t('meaningUnified') : t('meaningPortfolio');
const freeOf = (rows: readonly VenueBalance[] | null, asset: string) => rows?.find((r) => r.asset === asset)?.free ?? '0';
const units = (value: string) => parseAmount(value);

function AsOfLine({ iso, t }: { iso: string | null; t: T }) {
  if (!iso) return <span data-as-of="">{t('asOfUnknown')}</span>;
  return <span data-as-of={iso}>{t('asOf', { time: new Date(iso).toLocaleTimeString() })}</span>;
}

function Balances({ rows, title, name, t }: { rows: readonly VenueBalance[]; title: string; name: string; t: T }) {
  return (
    <div data-testid={`mode-${name}`}>
      <h4 className="dk-tab-title">{title}</h4>
      {rows.length === 0 ? (
        <p className="muted" data-empty="">
          {t('empty')}
        </p>
      ) : (
        <DataTable label={title} headers={[t('hAsset'), t('hFree'), t('hLocked'), t('hTotal')]}>
          {rows.map((b) => (
            <tr key={b.asset} data-asset={b.asset}>
              <td>{b.asset}</td>
              <td className="numeric" data-cell="free" data-value={b.free}>
                {displayAmount(b.free, 2)}
              </td>
              <td className="numeric" data-cell="locked" data-value={b.locked}>
                {displayAmount(b.locked, 2)}
              </td>
              <td className="numeric" data-cell="total" data-value={b.total}>
                {displayAmount(b.total, 2)}
              </td>
            </tr>
          ))}
        </DataTable>
      )}
    </div>
  );
}

/** What a signed venue action came to, in this panel's words. */
function resultLine(t: T, result: ActionResult, venue: string): string {
  switch (result.kind) {
    case 'rejected':
      return t('walletRejected');
    case 'refused':
      return t('refused', { detail: result.message });
    case 'outcome':
      return result.outcome.accepted ? '' : t('refused', { detail: result.outcome.refusal.detail });
    default:
      return t('pending', { venue });
  }
}

/**
 * The mode panel in the trading account (J-derivatives-29 #1, #3, #4, #6, #7, #8, #11): the mode and what it means, the
 * balances as the venue reports them, the day's action count, the move between spot and perps and the mode switch.
 */
export function AccountModePanel({
  owner,
  venue,
  balances,
  onChanged,
}: {
  owner: string;
  venue: { id: string | undefined; name: string };
  /** The venue account's balances as the trading group read them: in a one-balance mode, the one balance per asset. */
  balances: readonly VenueBalance[] | null;
  onChanged: () => void;
}) {
  const { t } = accountModeCopy.useCopy();
  const [revision, setRevision] = useState(0);
  const mode = useAccountMode(owner, revision, venue.id);
  const changed = () => {
    setRevision((n) => n + 1);
    onChanged();
  };
  const known = mode.state === 'known' ? mode.read : null;
  return (
    <div className="form-stack" data-testid="account-mode" data-mode={known?.mode ?? (mode.state === 'unknown' ? 'unknown' : '')}>
      <h3 className="dk-tab-title">{t('title')}</h3>
      <p className="muted">
        {t('source', { venue: venue.name })} · <AsOfLine iso={mode.state === 'loading' ? null : mode.asOf} t={t} />
      </p>
      {mode.state === 'loading' ? null : known ? (
        <>
          <p data-testid="account-mode-line" data-value={known.mode}>
            {t('modeLine', { mode: modeWord(t, known.mode) })}
          </p>
          <p className="muted" data-testid="account-mode-meaning">
            {meaningOf(t, known.mode)}
          </p>
          {known.mode === 'standard' ? (
            <div className="grid-2">
              <Balances rows={known.spot ?? []} title={t('spotTitle')} name="spot" t={t} />
              <Balances rows={known.perps ?? []} title={t('perpsTitle')} name="perps" t={t} />
            </div>
          ) : (
            <OneBalance balances={balances} t={t} />
          )}
          <Actions read={known} venue={venue.name} t={t} />
        </>
      ) : (
        <>
          <p data-testid="account-mode-line" data-value="unknown">
            {t('modeUnknown')}
          </p>
          <p className="muted" data-testid="account-mode-meaning">
            {t('unknownLine', { venue: venue.name })}
          </p>
        </>
      )}
      <MoveForm owner={owner} venue={venue} mode={mode} onMoved={changed} />
      <SwitchForm owner={owner} venue={venue} mode={mode} onSwitched={changed} />
    </div>
  );
}

function OneBalance({ balances, t }: { balances: readonly VenueBalance[] | null; t: T }) {
  const usdc = balances?.find((b) => b.asset === USDC) ?? null;
  return (
    <p data-testid="mode-one-balance" data-value={usdc?.total ?? ''}>
      {usdc ? t('oneBalance', { asset: USDC, amount: displayAmount(usdc.total, 2) }) : t('oneBalanceNone')}
    </p>
  );
}

function Actions({ read, venue, t }: { read: VenueAccountModeRead & { mode: VenueAccountMode }; venue: string; t: T }) {
  const a = read.actions;
  if (!a)
    return (
      <p className="muted" data-testid="mode-actions">
        {t('actionsUnknown', { venue })}
      </p>
    );
  return (
    <p className="muted" data-testid="mode-actions" data-used={a.usedToday} data-limit={a.dailyLimit ?? ''}>
      {a.dailyLimit === null
        ? t('actionsFree', { used: a.usedToday.toLocaleString('en-US'), venue })
        : t('actionsLimited', {
            used: a.usedToday.toLocaleString('en-US'),
            limit: a.dailyLimit.toLocaleString('en-US'),
            venue,
            mode: modeWord(t, read.mode),
          })}
    </p>
  );
}

/** Refused before anything is signed, by the account's mode as the venue reports it; null where the action may go. */
function modeRefusal(t: T, mode: AccountModeState, venue: string, kind: 'move' | 'switch'): string | null {
  if (mode.state === 'loading') return null;
  if (mode.state === 'unknown') return kind === 'move' ? t('moveModeUnknown', { venue }) : t('switchModeUnknown', { venue });
  if (kind === 'move' && mode.read.mode !== 'standard') return t('moveNotStandard', { mode: modeWord(t, mode.read.mode) });
  return null;
}

type MoveStage =
  | { at: 'idle' }
  | { at: 'review'; direction: Direction; amount: string; key: string }
  | { at: 'sending'; direction: Direction; amount: string; key: string }
  | {
      at: 'done';
      direction: Direction;
      amount: string;
      key: string;
      result: ActionResult;
      before: { spot: string; perps: string } | null;
      after: { spot: string; perps: string } | null;
      again: boolean;
    };

/** The venue's own spot and perps USDC, read now (the figures a move is shown with, before and after). */
function useFigures(owner: string, venueId: string | undefined) {
  const api = useVenueApi();
  return async (): Promise<{ spot: string; perps: string } | null> => {
    const read = await api.accountMode(owner, undefined, venueId);
    if (!read.ok || read.data.value.mode !== 'standard') return null;
    const total = (rows: readonly VenueBalance[] | null) => rows?.find((r) => r.asset === USDC)?.total ?? '0';
    return { spot: total(read.data.value.spot), perps: total(read.data.value.perps) };
  };
}

function MoveForm({
  owner,
  venue,
  mode,
  onMoved,
}: {
  owner: string;
  venue: { id: string | undefined; name: string };
  mode: AccountModeState;
  onMoved: () => void;
}) {
  const { t } = accountModeCopy.useCopy();
  const { run } = useVenueActions(owner);
  const figures = useFigures(owner, venue.id);
  const [direction, setDirection] = useState<Direction>('perps_to_spot');
  const [amount, setAmount] = useState('');
  const [stage, setStage] = useState<MoveStage>({ at: 'idle' });
  const [problem, setProblem] = useState<string | null>(null);
  const from = (d: Direction) => (d === 'perps_to_spot' ? t('perpsTitle') : t('spotTitle')).toLowerCase();
  const to = (d: Direction) => (d === 'perps_to_spot' ? t('spotTitle') : t('perpsTitle')).toLowerCase();

  const review = () => {
    setProblem(null);
    const refusal = modeRefusal(t, mode, venue.name, 'move');
    if (refusal) return setProblem(refusal);
    if (mode.state !== 'known') return;
    let value: bigint;
    try {
      value = units(amount.trim());
    } catch {
      return setProblem(t('refused', { detail: amount }));
    }
    if (value <= 0n) return setProblem(t('refused', { detail: amount }));
    // The venue's own figure for the source balance, as it last reported it: a move above it is refused, nothing signed.
    const free = freeOf(direction === 'perps_to_spot' ? mode.read.perps : mode.read.spot, USDC);
    if (value > units(free))
      return setProblem(t('moveTooMuch', { venue: venue.name, free, from: from(direction), amount: formatAmount(value) }));
    setStage({ at: 'review', direction, amount: formatAmount(value), key: keys.spotPerpsMove(owner, direction, draftId()) });
  };

  const send = async (s: { direction: Direction; amount: string; key: string }, again: boolean) => {
    setStage({ at: 'sending', ...s });
    const before = again && stage.at === 'done' ? stage.before : await figures();
    const result = await run(
      { kind: 'spot_perps_transfer', direction: s.direction, asset: USDC, amount: s.amount, moveKey: s.key },
      venue.id ? { venueId: venue.id } : {},
    );
    const after = again && stage.at === 'done' ? stage.after : await figures();
    setStage({ at: 'done', ...s, result, before, after, again });
    onMoved();
  };

  const accepted = stage.at === 'done' && stage.result.kind === 'outcome' && stage.result.outcome.accepted;
  return (
    <section className="form-stack" data-testid="mode-move" aria-label={t('moveTitle')}>
      <h4 className="dk-tab-title">{t('moveTitle')}</h4>
      <label className="field">
        <span>{t('moveDirection')}</span>
        <select
          data-testid="mode-move-direction"
          value={direction}
          onChange={(e) => {
            setDirection(e.target.value as Direction);
            setStage({ at: 'idle' });
          }}
        >
          <option value="perps_to_spot">{t('perpsToSpot')}</option>
          <option value="spot_to_perps">{t('spotToPerps')}</option>
        </select>
      </label>
      <Field
        label={t('moveAmount')}
        inputMode="decimal"
        data-testid="mode-move-amount"
        value={amount}
        onChange={(e) => {
          setAmount(e.target.value);
          setStage({ at: 'idle' });
        }}
      />
      <Button data-testid="mode-move-review" onClick={review}>
        {t('moveReview')}
      </Button>
      {problem ? (
        <p role="alert" className="failure" data-testid="mode-move-refused">
          {problem}
        </p>
      ) : null}
      {stage.at === 'review' || stage.at === 'sending' ? (
        <div data-testid="mode-move-review-line">
          <p>{t('moveReviewLine', { amount: stage.amount, from: from(stage.direction), to: to(stage.direction), venue: venue.name })}</p>
          <Button variant="primary" data-testid="mode-move-sign" disabled={stage.at === 'sending'} onClick={() => void send(stage, false)}>
            {t('moveSign')}
          </Button>
          <Button disabled={stage.at === 'sending'} onClick={() => setStage({ at: 'idle' })}>
            {t('cancel')}
          </Button>
        </div>
      ) : null}
      {stage.at === 'done' ? (
        <div
          role="status"
          data-testid="mode-move-result"
          data-accepted={accepted ? 'true' : 'false'}
          data-again={stage.again ? 'true' : 'false'}
        >
          {accepted ? (
            <p>
              {stage.before && stage.after
                ? t('moveDone', {
                    from: from(stage.direction),
                    to: to(stage.direction),
                    fromBefore: stage.direction === 'perps_to_spot' ? stage.before.perps : stage.before.spot,
                    fromAfter: stage.direction === 'perps_to_spot' ? stage.after.perps : stage.after.spot,
                    toBefore: stage.direction === 'perps_to_spot' ? stage.before.spot : stage.before.perps,
                    toAfter: stage.direction === 'perps_to_spot' ? stage.after.spot : stage.after.perps,
                    venue: venue.name,
                  })
                : null}
            </p>
          ) : (
            <p>{resultLine(t, stage.result, venue.name)}</p>
          )}
          {stage.again && stage.result.kind === 'outcome' && stage.result.reused ? (
            <p data-testid="mode-move-again-same">{t('moveAgainSame')}</p>
          ) : null}
          {accepted ? (
            <Button data-testid="mode-move-again" onClick={() => void send(stage, true)}>
              {t('moveAgain')}
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

type SwitchStage =
  | { at: 'idle' }
  | { at: 'review' | 'sending'; mode: VenueAccountMode; key: string }
  | { at: 'done'; mode: VenueAccountMode; result: ActionResult; after: VenueAccountMode | null };

function SwitchForm({
  owner,
  venue,
  mode,
  onSwitched,
}: {
  owner: string;
  venue: { id: string | undefined; name: string };
  mode: AccountModeState;
  onSwitched: () => void;
}) {
  const { t } = accountModeCopy.useCopy();
  const api = useVenueApi();
  const { run } = useVenueActions(owner);
  const [stage, setStage] = useState<SwitchStage>({ at: 'idle' });
  const [problem, setProblem] = useState<string | null>(null);
  const current = mode.state === 'known' ? mode.read.mode : null;
  const targets = MODES.filter((m) => m !== current);

  const ask = (target: VenueAccountMode) => {
    setProblem(null);
    const refusal = modeRefusal(t, mode, venue.name, 'switch');
    if (refusal) return setProblem(refusal);
    if (mode.state !== 'known') return;
    setStage({ at: 'review', mode: target, key: keys.accountMode(owner, target, draftId()) });
  };
  const sign = async (s: { mode: VenueAccountMode; key: string }) => {
    setStage({ at: 'sending', ...s });
    const result = await run({ kind: 'set_account_mode', mode: s.mode, changeKey: s.key }, venue.id ? { venueId: venue.id } : {});
    // The mode after, as the venue reports it: never our own idea of it.
    const read = await api.accountMode(owner, undefined, venue.id);
    setStage({ at: 'done', mode: s.mode, result, after: read.ok ? read.data.value.mode : null });
    onSwitched();
  };

  const accepted = stage.at === 'done' && stage.result.kind === 'outcome' && stage.result.outcome.accepted;
  const refusedDetail =
    stage.at === 'done' && stage.result.kind === 'outcome' && !stage.result.outcome.accepted
      ? stage.result.outcome.refusal.detail
      : stage.at === 'done' && stage.result.kind === 'refused'
        ? stage.result.message
        : null;
  return (
    <section className="form-stack" data-testid="mode-switch" aria-label={t('switchTitle')}>
      <h4 className="dk-tab-title">{t('switchTitle')}</h4>
      <p className="muted">{t('switchLine')}</p>
      <div className="button-row">
        {(current ? targets : MODES).map((m) => (
          <Button key={m} data-testid={`mode-switch-${m}`} onClick={() => ask(m)}>
            {t('switchTo', { mode: modeWord(t, m) })}
          </Button>
        ))}
      </div>
      {problem ? (
        <p role="alert" className="failure" data-testid="mode-switch-refused">
          {problem}
        </p>
      ) : null}
      {stage.at === 'review' || stage.at === 'sending' ? (
        <div data-testid="mode-switch-review">
          <p>{t('switchReview', { venue: venue.name, mode: modeWord(t, stage.mode) })}</p>
          <Button variant="primary" data-testid="mode-switch-sign" disabled={stage.at === 'sending'} onClick={() => void sign(stage)}>
            {t('switchSign')}
          </Button>
          <Button disabled={stage.at === 'sending'} onClick={() => setStage({ at: 'idle' })}>
            {t('cancel')}
          </Button>
        </div>
      ) : null}
      {stage.at === 'done' ? (
        <p
          role={accepted ? 'status' : 'alert'}
          className={accepted ? undefined : 'failure'}
          data-testid="mode-switch-result"
          data-accepted={accepted ? 'true' : 'false'}
        >
          {accepted && stage.after
            ? t('switchDone', { venue: venue.name, mode: modeWord(t, stage.after) })
            : refusedDetail !== null
              ? t('switchRefused', {
                  venue: venue.name,
                  detail: refusedDetail,
                  mode: stage.after ? modeWord(t, stage.after) : t('modeUnknown'),
                })
              : resultLine(t, stage.result, venue.name)}
        </p>
      ) : null}
    </section>
  );
}

/**
 * The order ticket's warning (J-derivatives-29 #9): in a mode the venue caps, once the day's actions reach 90% of the
 * venue's limit, the limit, what the venue reports used today, and that standard mode has no such limit.
 */
export function ActionLimitWarning({ venueName, venueId }: { venueName: string; venueId?: string }) {
  const { t } = accountModeCopy.useCopy();
  const owner = useOwner();
  const mode = useAccountMode(owner, 0, venueId);
  if (mode.state !== 'known') return null;
  const a = mode.read.actions;
  if (!a || a.dailyLimit === null || a.usedToday < a.dailyLimit * NEAR_LIMIT_SHARE) return null;
  return (
    <p role="alert" className="failure" data-testid="action-limit-warning" data-used={a.usedToday} data-limit={a.dailyLimit}>
      {t('limitNear', {
        venue: venueName,
        limit: a.dailyLimit.toLocaleString('en-US'),
        used: a.usedToday.toLocaleString('en-US'),
        mode: modeWord(t, mode.read.mode),
      })}
    </p>
  );
}

/**
 * A spot buy in standard mode that spot can't pay for (J-derivatives-29 #2 #3 #4 #11): spot's figure and what the buy
 * locks, as the venue reports them, and one signed move of the amount needed from perps; nothing is bought until it
 * lands. Once it lands, the venue's spot and perps figures before and after, and the same move may be sent again, which
 * moves nothing and shows the first result. With the mode not known, it is refused naming the unknown mode, and nothing
 * is signed.
 */
export function SpotShortOffer({
  owner,
  venueName,
  mode,
  lock,
  onLanded,
}: {
  owner: string;
  venueName: string;
  mode: AccountModeState;
  /** What the buy locks in USDC, as the venue's preview says, while spot is short of it; null while it is not. */
  lock: string | null;
  onLanded: () => void;
}) {
  const { t } = accountModeCopy.useCopy();
  const { run } = useVenueActions(owner);
  const [key] = useState(() => keys.spotPerpsMove(owner, 'perps_to_spot', draftId()));
  const [sent, setSent] = useState<{
    amount: string;
    result: ActionResult;
    before: { spot: string; perps: string };
    after: { spot: string; perps: string } | null;
    again: ActionResult | null;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const api = useVenueApi();
  const figures = async () => {
    const read = await api.accountMode(owner);
    if (!read.ok || read.data.value.mode !== 'standard') return null;
    return { spot: freeOf(read.data.value.spot, USDC), perps: freeOf(read.data.value.perps, USDC) };
  };
  const landed = sent !== null && sent.result.kind === 'outcome' && sent.result.outcome.accepted;
  if (sent && landed) {
    const send = async () => {
      setBusy(true);
      const again = await run({ kind: 'spot_perps_transfer', direction: 'perps_to_spot', asset: USDC, amount: sent.amount, moveKey: key });
      setBusy(false);
      setSent({ ...sent, again });
      onLanded();
    };
    return (
      <div role="status" data-testid="spot-short" data-state="landed" data-needed={sent.amount}>
        <p data-testid="spot-short-landed">
          {sent.after
            ? t('moveDone', {
                from: t('perpsTitle').toLowerCase(),
                to: t('spotTitle').toLowerCase(),
                fromBefore: sent.before.perps,
                fromAfter: sent.after.perps,
                toBefore: sent.before.spot,
                toAfter: sent.after.spot,
                venue: venueName,
              })
            : null}
        </p>
        {sent.again ? (
          <p data-testid="spot-short-again">
            {sent.again.kind === 'outcome' && sent.again.reused ? t('moveAgainSame') : resultLine(t, sent.again, venueName)}
          </p>
        ) : null}
        <Button variant="secondary" data-testid="spot-short-again-send" disabled={busy} onClick={() => void send()}>
          {t('moveAgain')}
        </Button>
      </div>
    );
  }
  if (lock === null) return null;
  if (mode.state === 'unknown')
    return (
      <p role="alert" className="failure" data-testid="spot-short" data-state="mode-unknown">
        {t('spotShortUnknown', { venue: venueName })}
      </p>
    );
  if (mode.state !== 'known' || mode.read.mode !== 'standard') return null;
  const spotFree = freeOf(mode.read.spot, USDC);
  const perpsFree = freeOf(mode.read.perps, USDC);
  const neededUnits = units(lock) - units(spotFree);
  if (neededUnits <= 0n) return null;
  const needed = formatAmount(neededUnits);
  if (neededUnits > units(perpsFree))
    return (
      <p role="alert" className="failure" data-testid="spot-short" data-state="perps-short">
        {t('spotShortNoPerps', { free: spotFree, lock, perps: perpsFree })}
      </p>
    );
  const move = async () => {
    setBusy(true);
    const before = { spot: spotFree, perps: perpsFree };
    const result = await run({ kind: 'spot_perps_transfer', direction: 'perps_to_spot', asset: USDC, amount: needed, moveKey: key });
    const after = result.kind === 'outcome' && result.outcome.accepted ? await figures() : null;
    setBusy(false);
    setSent({ amount: needed, result, before, after, again: null });
    onLanded();
  };
  return (
    <div role="alert" className="failure" data-testid="spot-short" data-state="offer" data-needed={needed}>
      <p>{t('spotShort', { free: spotFree, lock, needed })}</p>
      <Button data-testid="spot-short-move" disabled={busy} onClick={() => void move()}>
        {t('spotShortSign', { needed })}
      </Button>
      {sent ? <p data-testid="spot-short-result">{resultLine(t, sent.result, venueName)}</p> : null}
    </div>
  );
}
