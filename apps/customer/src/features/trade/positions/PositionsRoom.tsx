import { useEffect, useMemo, useRef, useState } from 'react';
import type { Position } from '@intafaced/exchange-contract/schemas';
import { Badge, Button, ChoiceGroup, EmptyState, KeyValue } from '@intafaced/ui';
import { fmtAmount } from '../../../data/format';
import { useBalances } from '../../../screens/trade/desk/data';
import { useNow } from '../../../screens/trade/desk/hooks';
import type { PositionMode } from '../../../screens/trade/futures/api';
import { useFuturesApi, useFuturesRefresh, useMarginCalls, useOpenPositions, useRiskStops } from '../../../screens/trade/futures/data';
import { newNonce } from '../../../screens/trade/futures/hooks';
import { isLive, totalsOf } from '../../../screens/trade/futures/model';
import { PositionDetail } from '../../../screens/trade/futures/PositionDetail';
import { PositionsTable } from '../../../screens/trade/futures/PositionsTable';
import { futuresRefusal, isPlaneOff } from '../../../screens/trade/futures/refusals';
import { freeOf } from '../../../screens/trade/futures/RiskSummary';
import { Page } from '../../../shared/ui';
import { useSession } from '../../session/session';
import { positionsRoomCopy } from './positions-room-copy';

type Mode = 'one_way' | 'hedge';

/** The settle asset of a derivative symbol ("BTC/USDT:USDT" -> "USDT"). */
function settleOf(symbol: string): string {
  return symbol.split(':')[1] ?? symbol.split('/')[1] ?? 'USDT';
}

type ModeState =
  { status: 'loading' } | { status: 'ready'; mode: PositionMode } | { status: 'refused'; title: string; body: string; code: string | null };

/**
 * One-way or hedge, for the whole futures account. A flat account switches; with an open position the service refuses
 * the migration and its reason is said here, word for word. An unset mode is shown as unset, never as a default.
 */
function PositionModeControl() {
  const { t } = positionsRoomCopy.useCopy();
  const api = useFuturesApi();
  const [state, setState] = useState<ModeState>({ status: 'loading' });
  const [choice, setChoice] = useState<Mode | null>(null);
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<
    { kind: 'switched'; mode: Mode } | { kind: 'refused'; title: string; body: string; code: string | null } | null
  >(null);
  const key = useRef<{ mode: Mode; id: string } | null>(null);

  const read = async (signal?: AbortSignal) => {
    const got = await api.positionMode(signal);
    if (signal?.aborted) return;
    if (got.ok) {
      setState({ status: 'ready', mode: got.data });
      setChoice((c) => c ?? got.data.mode);
    } else {
      const words = futuresRefusal(got);
      setState({ status: 'refused', title: words.title, body: words.body, code: got.code ?? null });
    }
  };
  useEffect(() => {
    const controller = new AbortController();
    void read(controller.signal);
    return () => controller.abort();
  }, [api]);

  const current = state.status === 'ready' ? state.mode.mode : null;
  const fixed = state.status === 'ready' && state.mode.source === 'fixed';
  const save = async () => {
    if (!choice || busy) return;
    // The same choice keeps its request id, so a retry after a lost answer is the same request.
    if (!key.current || key.current.mode !== choice) key.current = { mode: choice, id: `position-mode:${choice}:${newNonce()}` };
    setBusy(true);
    const sent = await api.setPositionMode({ mode: choice, clientModeId: key.current.id });
    setBusy(false);
    if (sent.ok) {
      key.current = null;
      setAnswer({ kind: 'switched', mode: choice });
      setState({ status: 'ready', mode: sent.data });
    } else {
      const words = futuresRefusal(sent);
      // The service's own reason, as it said it: what stops the switch now.
      setAnswer({ kind: 'refused', title: words.title, body: sent.message || words.body, code: sent.code ?? null });
    }
  };

  const modeWord = (mode: Mode | null) => (mode === 'hedge' ? t('Mode hedge') : mode === 'one_way' ? t('Mode one way') : t('Mode unset'));
  return (
    <section id="position-mode" aria-label={t('Mode label')} className="flex flex-col gap-2 rounded-sm border border-line p-3">
      <h2 className="text-md font-medium text-fg">{t('Mode label')}</h2>
      <p className="text-fg-2 text-sm">{t('Mode explain')}</p>
      {state.status === 'loading' ? <p className="text-fg-2 text-sm">{t('Mode loading')}</p> : null}
      {state.status === 'refused' ? (
        <EmptyState variant="refused" size="inline" title={state.title} reason={state.body} {...(state.code ? { code: state.code } : {})} />
      ) : null}
      {state.status === 'ready' ? (
        <>
          <p data-testid="position-mode-current" className="text-sm">
            {t('Mode now', { mode: modeWord(current) })}
          </p>
          {current === null ? <p className="text-warn text-sm">{t('Mode unset note')}</p> : null}
          {fixed ? (
            <p className="text-fg-2 text-sm">{t('Mode fixed')}</p>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <ChoiceGroup
                items={['one_way', 'hedge']}
                value={choice ?? ''}
                label={t('Mode choose')}
                labels={{ one_way: t('Mode one way'), hedge: t('Mode hedge') }}
                onChange={(next) => {
                  setChoice(next as Mode);
                  setAnswer(null);
                }}
              />
              <Button size={32} loading={busy} disabled={!choice || choice === current || busy} onClick={() => void save()}>
                {t('Mode save')}
              </Button>
            </div>
          )}
        </>
      ) : null}
      {answer?.kind === 'switched' ? (
        <p role="status" className="text-sm">
          {t('Mode switched', { mode: modeWord(answer.mode) })}
        </p>
      ) : null}
      {answer?.kind === 'refused' ? (
        <div role="alert" className="text-error-text text-sm">
          <p className="font-medium">{answer.title}</p>
          <p>{answer.body}</p>
          {answer.code ? <p className="text-fg-2 text-2xs">{answer.code}</p> : null}
        </div>
      ) : null}
    </section>
  );
}

/** One product's figures, each the sum of the rows below it, exactly. */
function ProductTotals({ positions }: { positions: readonly Position[] }) {
  const { t } = positionsRoomCopy.useCopy();
  const totals = totalsOf(positions);
  const asset = positions[0] ? settleOf(positions[0].symbol) : 'USDT';
  const money = (v: string | null) => (v === null ? null : `${fmtAmount(v, { places: 18 })} ${asset}`);
  return (
    <section aria-label={t('Totals label')}>
      <KeyValue
        density="dense"
        items={[
          { label: t('Totals count'), value: String(totals.count) },
          { label: t('Totals margin'), value: money(totals.collateral) },
          { label: t('Totals pnl'), value: money(totals.unrealizedPnl) },
        ]}
      />
    </section>
  );
}

export function PositionsRoom() {
  const { t } = positionsRoomCopy.useCopy();
  const { userId } = useSession();
  const api = useFuturesApi();
  const now = useNow(5_000);
  const refresh = useFuturesRefresh();
  const positions = useOpenPositions();
  const balances = useBalances();
  const live = positions.status === 'ready' ? positions.data.filter(isLive) : [];
  const calls = useMarginCalls(live, positions.status === 'ready');
  const riskStops = useRiskStops(live, positions.status === 'ready');
  const planeOff = positions.status === 'refused' && isPlaneOff(positions.code);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = positions.status === 'ready' ? (positions.data.find((p) => p.id === selectedId) ?? null) : null;

  // The published leverage cap of each contract held (`GET /futures/tiers`), so a leverage change shows it before typing.
  const symbols = useMemo(() => [...new Set(live.map((p) => p.symbol))].sort().join('|'), [live]);
  const [caps, setCaps] = useState<Record<string, string | null>>({});
  useEffect(() => {
    if (!symbols) return;
    const controller = new AbortController();
    void Promise.all(
      symbols.split('|').map(async (symbol) => {
        const read = await api.tiers(symbol, controller.signal);
        return [symbol, read.ok ? read.data.maxLeverage : null] as const;
      }),
    ).then((pairs) => !controller.signal.aborted && setCaps(Object.fromEntries(pairs)));
    return () => controller.abort();
  }, [api, symbols]);

  if (!userId) {
    return (
      <Page eyebrow={t('Eyebrow')} title={t('Title')} description={t('Lead')}>
        <EmptyState
          variant="refused"
          title={t('Signed out title')}
          reason={t('Signed out reason')}
          action={{ label: t('Sign in'), href: `/login?redirect=${encodeURIComponent('/trade/positions')}` }}
        />
      </Page>
    );
  }

  return (
    <Page eyebrow={t('Eyebrow')} title={t('Title')} description={t('Lead')}>
      <div className="flex flex-col gap-6">
        <PositionModeControl />
        <section aria-label={t('Futures label')} className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-md font-medium text-fg">{t('Futures label')}</h2>
            <Badge tone="neutral">{t('Tag futures')}</Badge>
          </div>
          {positions.status === 'ready' ? <ProductTotals positions={positions.data} /> : null}
          <PositionsTable
            positions={positions}
            marginCalls={calls}
            riskStops={riskStops}
            freeBalances={balances}
            planeOff={planeOff}
            now={now}
            leverageCapFor={(symbol) => caps[symbol] ?? null}
            onOpen={(p) => setSelectedId(p.id)}
            onChanged={refresh}
          />
        </section>
        <section aria-label={t('Options label')} className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-md font-medium text-fg">{t('Options label')}</h2>
            <Badge tone="neutral">{t('Tag options')}</Badge>
          </div>
          <EmptyState variant="unavailable" size="inline" title={t('Options blocked title')} reason={t('Options blocked reason')} />
        </section>
        <section aria-label={t('Margin label')} className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-md font-medium text-fg">{t('Margin label')}</h2>
            <Badge tone="neutral">{t('Tag margin')}</Badge>
          </div>
          <EmptyState variant="unavailable" size="inline" title={t('Margin blocked title')} reason={t('Margin blocked reason')} />
        </section>
      </div>
      {selected ? (
        <PositionDetail
          position={selected}
          marginCall={calls.status === 'ready' && selected.id ? calls.data[selected.id] : undefined}
          free={freeOf(balances, settleOf(selected.symbol))}
          leverageCap={caps[selected.symbol] ?? null}
          planeOff={planeOff}
          onClose={() => setSelectedId(null)}
          onChanged={refresh}
        />
      ) : null}
    </Page>
  );
}
