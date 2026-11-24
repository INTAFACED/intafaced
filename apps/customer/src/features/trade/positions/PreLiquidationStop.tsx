import { useRef, useState } from 'react';
import { Button } from '@intafaced/ui/lit';
import { TextField } from '@intafaced/ui/lit/templates';
import { usePolled } from '../../protocol';
import { closingSide, protectionClientId } from '../../../screens/trade/futures/venue-protect-logic';
import { refusalOf, useSignPrepared } from '../../../screens/trade/futures/VenueProtect';
import { compareDecimal } from '../../../data/decimal';
import { draftId, keys, type ProtectionView, type VenueMarket, type VenuePosition, type VenueUp } from '../venue-api';
import { VENUE_POLL_MS } from '../venue/poll';
import { outcomeText, useVenueApi, type RunAction } from '../venue/VenueKit';
import { venueCopy } from '../venue/venue-copy';
import { Known } from '../venue/volt/VoltVenue';
import { marginRatio, preLiquidationStop } from './positions-math';
import { positionsCopy } from './positions-copy';

/**
 * A pre-liquidation stop is a stop loss our door sends to the venue as its own trigger order, under a client order id
 * that names it and its level: `pls-<level in basis points>-<one id per press>`. The venue holds it; nothing else does.
 */
const PREFIX = 'pls-';
const idOf = (levelBps: bigint, press: string) => `${PREFIX}${levelBps}-${press}`;
const levelOf = (clientOrderId: string): string | null => {
  const m = /^pls-(\d+)-/.exec(clientOrderId);
  if (!m) return null;
  const bps = BigInt(m[1]!);
  const cents = bps % 100n;
  return cents === 0n ? String(bps / 100n) : `${bps / 100n}.${String(cents).padStart(2, '0').replace(/0$/, '')}`;
};
/** A percent with at most two places as basis points; null otherwise. */
const bpsOf = (percent: string): bigint | null => {
  const m = /^(\d{1,2})(?:\.(\d{1,2}))?$/.exec(percent.trim());
  return m ? BigInt(m[1]!) * 100n + BigInt((m[2] ?? '').padEnd(2, '0')) : null;
};

export interface PreLiquidationStopView {
  readonly level: string;
  readonly protection: ProtectionView;
}

/**
 * The person's pre-liquidation stops still live on the venue, one per symbol (the newest), read once for the room from
 * the door's record of the venue's own trigger orders.
 */
export function usePreLiquidationStops(owner: string): { stops: ReadonlyMap<string, PreLiquidationStopView>; reload: () => void } {
  const venue = useVenueApi();
  const list = usePolled((signal) => venue.protections(owner, signal), `pre-liquidation-stops:${owner}`, VENUE_POLL_MS);
  const stops = new Map<string, PreLiquidationStopView>();
  for (const p of list.data?.protections ?? []) {
    const level = levelOf(p.clientOrderId);
    if (level === null || p.restsOn !== 'venue' || (p.status !== 'armed' && p.status !== 'triggered')) continue;
    stops.set(p.symbol, { level, protection: p });
  }
  return { stops, reload: list.reload };
}

/** The stop as the position's row shows it. */
export function StopOnRow({ stop }: { stop: PreLiquidationStopView | undefined }) {
  const { t } = positionsCopy.useCopy();
  if (!stop) return null;
  return (
    <span className="lt-mono" data-testid="pre-liquidation-stop" data-status={stop.protection.status}>
      {t('plsRow', { level: stop.level, trigger: stop.protection.triggerPrice ?? '—' })}
    </span>
  );
}

/**
 * Set a pre-liquidation stop on one isolated position (J-derivatives-06 #5): the person names the margin ratio at which
 * to close; the room turns it into the venue's mark from the venue's own figures (`preLiquidationStop`) and the door
 * prepares one reduce-only stop loss for the whole position, judged on the mark, which the person's wallet signs once
 * and the venue holds. Nothing moves through INTAFACED and the ledger posts nothing. A level the venue's figures can't
 * carry, a venue that judges no stop on its mark, or a stop already resting is refused in words before anything is
 * signed.
 */
export function PreLiquidationStopPanel({
  owner,
  position,
  venue: on,
  desk,
  market,
  stop,
  builder,
  run,
  onDone,
  onClose,
}: {
  owner: string;
  position: VenuePosition;
  venue: { id: string; name: string };
  /** The venue the door sends protections to. */
  desk: { id: string; name: string };
  market: VenueMarket | undefined;
  stop: PreLiquidationStopView | undefined;
  /** Our builder fee, which every order on the venue carries; null where none is set. */
  builder: VenueUp['builder'];
  run: RunAction;
  onDone: () => void;
  onClose: () => void;
}) {
  const { t } = positionsCopy.useCopy();
  const v = venueCopy.useCopy().t;
  const api = useVenueApi();
  const sign = useSignPrepared(owner);
  const [level, setLevel] = useState('');
  const [said, setSaid] = useState<{ tone: 'ok' | 'refused'; text: string } | null>(null);
  const busy = useRef(false);
  const press = useRef<{ level: string; id: string } | null>(null);
  const words = { venue: on.name, symbol: position.symbol, desk: desk.name };
  const ratioNow = marginRatio(position);
  // Whether the venue account has yet to approve our builder fee: the close order carries it, so the venue refuses the
  // order until the person's wallet signs that one-time approval, which Set stop asks for first.
  const unapproved = async (signal?: AbortSignal) => {
    if (!builder) return false;
    const read = await api.builderFeeApproval(owner, signal, desk.id);
    return !read.ok || compareDecimal(read.data.value, builder.feeBps) === -1;
  };
  const approval = usePolled(
    async (signal) => ({ ok: true as const, data: await unapproved(signal) }),
    `pre-liquidation-stop-approval:${owner}:${desk.id}`,
    VENUE_POLL_MS,
  );

  const blocked: string | null =
    on.id !== desk.id
      ? t('plsWhy_otherVenue', words)
      : market && !(market.triggerSources ?? []).includes('mark')
        ? t('plsWhy_noMark', words)
        : null;
  const typed = level.trim();
  const at = typed === '' ? null : preLiquidationStop(position, typed, market?.tickSize ?? '0');
  // The level is kept in the order's own id to two places, so a third place is refused before anything is sent.
  const why = at && !at.ok ? t(`plsWhy_${at.why}`, words) : at?.ok && bpsOf(typed) === null ? t('plsWhy_level') : null;
  const ready = !blocked && !stop && at?.ok === true && bpsOf(typed) !== null;

  async function set() {
    if (busy.current || !ready || !at?.ok) return;
    setSaid(null);
    // One id per level typed: pressing again for the same level is the same order, which the door holds once.
    if (!press.current || press.current.level !== typed) press.current = { level: typed, id: protectionClientId(Date.now(), 0) };
    busy.current = true;
    try {
      if (builder && (await unapproved())) {
        const approved = await run(
          { kind: 'approve_builder_fee', builder: builder.address, maxFeeBps: builder.feeBps },
          { actionKey: keys.builderApproval(owner, builder.address, builder.feeBps, desk.id, draftId()), venueId: desk.id },
        );
        approval.reload();
        const refusedApproval = refusalOf(approved, (r) => outcomeText(v, r));
        if (refusedApproval) return setSaid({ tone: 'refused', text: refusedApproval.message });
      }
      const created = await api.createProtection({
        owner,
        symbol: position.symbol,
        kind: 'stop_loss',
        side: closingSide(position.side),
        quantity: position.size,
        triggerPrice: at.trigger,
        triggerSource: 'mark',
        clientOrderId: idOf(bpsOf(typed)!, press.current.id),
      });
      if (!created.ok) return setSaid({ tone: 'refused', text: created.message });
      if (created.data.restsOn !== 'venue') return setSaid({ tone: 'refused', text: t('plsWhy_noMark', words) });
      const answer = await sign(created.data);
      const refused = refusalOf(answer, (r) => outcomeText(v, r));
      if (refused) return setSaid({ tone: 'refused', text: refused.message });
      press.current = null;
      setLevel('');
      setSaid({ tone: 'ok', text: t('plsSetDone', { ...words, trigger: at.trigger }) });
    } finally {
      busy.current = false;
      onDone();
    }
  }

  async function remove() {
    if (busy.current || !stop?.protection.actionKey) return;
    setSaid(null);
    busy.current = true;
    try {
      const answer = await run(
        { kind: 'cancel_order', symbol: position.symbol, clientOrderKey: stop.protection.actionKey },
        { venueId: on.id },
      );
      const refused = refusalOf(answer, (r) => outcomeText(v, r));
      setSaid(refused ? { tone: 'refused', text: refused.message } : { tone: 'ok', text: t('plsRemoved', words) });
    } finally {
      busy.current = false;
      onDone();
    }
  }

  return (
    <section className="lt-stack" aria-label={t('plsTitle', words)} data-testid="pre-liquidation-stop-panel">
      <h3>{t('plsTitle', words)}</h3>
      <p className="lt-hint">{t('plsLead', words)}</p>
      <dl>
        <dt>{t('plsRatioNow')}</dt>
        <dd className="lt-mono" data-line="ratio">
          {ratioNow === null ? v('Not known') : ratioNow === 'liquidation' ? '—' : `${ratioNow}%`}
        </dd>
        <dt>{t('plsMaintenance', words)}</dt>
        <dd className="lt-mono" data-line="maintenance">
          {position.maintenanceMargin ? <Known value={position.maintenanceMargin} render={(x) => x} /> : v('Not known')}
        </dd>
        <dt>{t('plsMark', words)}</dt>
        <dd className="lt-mono" data-line="mark">
          {position.markPrice}
        </dd>
        <dt>{t('plsLiquidation', words)}</dt>
        <dd className="lt-mono" data-line="liquidation">
          <Known value={position.liquidationPrice} render={(x) => x} />
        </dd>
      </dl>
      <section className="lt-stack" aria-label={t('plsCurrentTitle')} data-testid="pre-liquidation-stop-current">
        <h4>{t('plsCurrentTitle')}</h4>
        {stop ? (
          <p data-status={stop.protection.status}>
            {stop.protection.status === 'triggered'
              ? t('plsTriggered', { ...words, trigger: stop.protection.triggerPrice ?? '—', size: stop.protection.quantity })
              : t('plsArmed', {
                  ...words,
                  level: stop.level,
                  trigger: stop.protection.triggerPrice ?? '—',
                  size: stop.protection.quantity,
                })}
          </p>
        ) : (
          <p>{t('plsNone')}</p>
        )}
      </section>
      {blocked ? (
        <p className="lt-refusal" role="alert">
          {blocked}
        </p>
      ) : stop ? (
        <>
          <p className="lt-hint">{t('plsWhy_replace')}</p>
          <Button tone="secondary" onClick={() => void remove()}>
            {t('plsRemove')}
          </Button>
        </>
      ) : (
        <>
          <TextField label={t('plsLevel')} hint={t('plsLevelHint', words)} inputMode="decimal" value={level} onChange={setLevel} />
          {why ? (
            <p className="lt-refusal" role="alert" data-testid="pre-liquidation-stop-why">
              {why}
            </p>
          ) : at?.ok ? (
            <p data-testid="pre-liquidation-stop-would">{t('plsWouldClose', { ...words, size: position.size, trigger: at.trigger })}</p>
          ) : null}
          {builder && approval.data === true ? (
            <p className="lt-hint" data-testid="pre-liquidation-stop-approve">
              {t('plsApprove', { ...words, fee: builder.feeBps })}
            </p>
          ) : null}
          <Button onClick={() => void set()} disabled={!ready}>
            {t('plsSet')}
          </Button>
        </>
      )}
      {said?.tone === 'refused' ? (
        <p className="lt-refusal" role="alert" data-testid="pre-liquidation-stop-said">
          {said.text}
        </p>
      ) : null}
      {said?.tone === 'ok' ? (
        <p className="lt-hint" role="status" data-testid="pre-liquidation-stop-said">
          {said.text}
        </p>
      ) : null}
      <Button tone="secondary" onClick={onClose}>
        {t('close')}
      </Button>
    </section>
  );
}
